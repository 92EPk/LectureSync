"""
Lecture Sync - Colab worker

Pulls lecture archives from Telegram, extracts them on Colab's local disk
and drops the result into Google Drive. The desktop app talks to this
process through a Cloudflare quick tunnel.

Author: Ahmed Omran <B9x@outlook.com>
GitHub: https://github.com/92EPK
"""

from __future__ import annotations

import re
import asyncio
import os
import secrets
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel
from telethon import TelegramClient, utils
from telethon.network import MTProtoSender
from telethon.tl.alltlobjects import LAYER
from telethon.tl.functions import InvokeWithLayerRequest
from telethon.tl.functions.auth import ExportAuthorizationRequest, ImportAuthorizationRequest
from telethon.tl.functions.upload import GetFileRequest, SaveBigFilePartRequest
from telethon.tl.types import InputFileBig, DocumentAttributeFilename
from telethon.errors import FloodWaitError, SessionPasswordNeededError
from telethon.errors import AuthKeyError, RPCError, UnauthorizedError
from fastapi.responses import JSONResponse

# Telegram encrypts every chunk with AES-IGE. Without a native backend Telethon
# falls back to pure Python, which pins one CPU core at ~4-5 MB/s. tgcrypto ships
# prebuilt wheels (unlike cryptg), so plug it in when present; otherwise carry on.
try:
    import tgcrypto
    import telethon.crypto.aes as _tl_aes

    class _TgCryptoBackend:
        encrypt_ige = staticmethod(tgcrypto.ige256_encrypt)
        decrypt_ige = staticmethod(tgcrypto.ige256_decrypt)

    _tl_aes.cryptg = _TgCryptoBackend
    CRYPTO_BACKEND = "tgcrypto"
except Exception:
    CRYPTO_BACKEND = "python"

def _find_drive_root() -> Path:
    if os.environ.get("LS_DRIVE_ROOT"):
        return Path(os.environ["LS_DRIVE_ROOT"])
    for p in ("/content/drive/MyDrive", "/content/drive/My Drive"):
        if Path(p).is_dir():
            return Path(p)
    return Path("/content/drive/MyDrive")


DRIVE_ROOT = _find_drive_root()


def drive_mounted() -> bool:
    # Without the user approving Drive in Colab, the folder exists but is not a mount.
    return os.path.ismount("/content/drive") and DRIVE_ROOT.is_dir()
# Session lives on Drive so a fresh Colab VM doesn't ask for an SMS code again.
STATE_DIR = DRIVE_ROOT / ".lecture-sync"
SCRATCH = Path(os.environ.get("LS_SCRATCH", "/content/scratch"))
# The desktop app generates this per run and bakes it into the cell it pastes.
ACCESS_TOKEN = os.environ["LS_ACCESS_TOKEN"]

# Archives roughly double in size while extracting; keep a margin on top.
EXTRACT_FACTOR = 2.2

STATE_DIR.mkdir(parents=True, exist_ok=True)
SCRATCH.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="lecture-sync", docs_url=None, redoc_url=None)
# Each user brings their own api_id/hash from my.telegram.org; the app sends
# them after connecting, so nothing Telegram-specific is typed into Colab.
tg: TelegramClient | None = None
_tg_key: tuple[int, str] | None = None
_pending_phone: dict[str, str] = {}
# Last known Telegram sign-in state, kept in memory so /health never waits on
# Telegram's network. Updated on configure/sign-in, by a slow background check,
# and flipped off as soon as any call reports the session was revoked.
_tg_authorized = False


async def _check_auth(timeout: float = 5.0) -> bool:
    """Ask Telegram if we're signed in; on timeout/network error keep the last known state."""
    global _tg_authorized
    if tg is None:
        _tg_authorized = False
        return False
    try:
        _tg_authorized = bool(await asyncio.wait_for(tg.is_user_authorized(), timeout))
    except Exception:  # noqa: BLE001 - slow or flaky Telegram must not change state
        pass
    return _tg_authorized


def _set_authorized(value: bool) -> None:
    global _tg_authorized
    _tg_authorized = value


@app.exception_handler(RPCError)
async def _telegram_rpc_error(_request, exc: RPCError):
    # Session revoked/expired: drop the cached state so the app asks to sign in again.
    if isinstance(exc, (AuthKeyError, UnauthorizedError)):
        _set_authorized(False)
        return JSONResponse(status_code=401, content={"detail": "Telegram session ended. Sign in again."})
    return JSONResponse(status_code=502, content={"detail": f"Telegram error: {type(exc).__name__}: {exc}"})


async def _auth_watch() -> None:
    while True:
        await asyncio.sleep(60)
        await _check_auth()


def require_token(x_access_token: str = Header(default="")) -> None:
    if not secrets.compare_digest(x_access_token, ACCESS_TOKEN):
        raise HTTPException(status_code=401, detail="bad token")


auth = [Depends(require_token)]


def client() -> TelegramClient:
    if tg is None:
        raise HTTPException(status_code=428, detail="telegram keys not set")
    return tg


def safe_path(rel: str) -> Path:
    """Resolve a Drive-relative path and refuse anything outside MyDrive."""
    p = (DRIVE_ROOT / rel.lstrip("/")).resolve()
    if p != DRIVE_ROOT.resolve() and DRIVE_ROOT.resolve() not in p.parents:
        raise HTTPException(status_code=400, detail="path outside drive")
    return p


# ---------------------------------------------------------------- status

@app.get("/health")
def health():
    # Memory only: answers instantly even when Telegram is slow or unreachable.
    return {"ok": True, "telegram_ready": tg is not None, "telegram": tg is not None and _tg_authorized}


@app.get("/disk", dependencies=auth)
def disk():
    u = shutil.disk_usage(SCRATCH)
    out = {"total": u.total, "used": u.used, "free": u.free}
    if drive_mounted():
        try:
            d = shutil.disk_usage(DRIVE_ROOT)
            out["drive"] = {"total": d.total, "used": d.used, "free": d.free}
        except OSError:
            pass
    return out


# ---------------------------------------------------------------- telegram login

class KeysIn(BaseModel):
    api_id: int
    api_hash: str


class PhoneIn(BaseModel):
    phone: str


class CodeIn(BaseModel):
    phone: str
    code: str
    password: str | None = None


@app.post("/telegram/configure", dependencies=auth)
async def configure(body: KeysIn):
    global tg, _tg_key, _tg_authorized
    key = (body.api_id, body.api_hash)
    if tg is not None and _tg_key == key:
        return {"ok": True, "telegram": await _check_auth()}
    _tg_authorized = False
    if tg is not None:
        await tg.disconnect()
    # One session file per api_id, so two people sharing a Drive never collide.
    tg = TelegramClient(str(STATE_DIR / f"telegram-{body.api_id}"), body.api_id, body.api_hash)
    await tg.connect()
    _tg_key = key
    return {"ok": True, "telegram": await _check_auth(15.0)}


@app.post("/telegram/send-code", dependencies=auth)
async def send_code(body: PhoneIn):
    sent = await client().send_code_request(body.phone)
    _pending_phone[body.phone] = sent.phone_code_hash
    return {"sent": True}


@app.post("/telegram/sign-in", dependencies=auth)
async def sign_in(body: CodeIn):
    c = client()
    try:
        await c.sign_in(body.phone, body.code,
                        phone_code_hash=_pending_phone.get(body.phone))
    except SessionPasswordNeededError:
        if not body.password:
            raise HTTPException(status_code=409, detail="2fa password required")
        await c.sign_in(password=body.password)
    _set_authorized(True)
    return {"ok": True}


# ---------------------------------------------------------------- QR login
# Telegram often refuses to send SMS/app codes to datacenter IPs (Colab),
# so scanning a QR from the phone (Settings > Devices > Link desktop) is the reliable path.
_qr = {"login": None, "state": "idle", "error": None}


def _qr_svg(url: str) -> str:
    import io
    import qrcode
    import qrcode.image.svg
    buf = io.BytesIO()
    qrcode.make(url, image_factory=qrcode.image.svg.SvgPathFillImage, border=2).save(buf)
    return buf.getvalue().decode()


async def _qr_wait(login):
    try:
        await login.wait(timeout=120)
        _set_authorized(True)
        _qr["state"] = "done"
    except SessionPasswordNeededError:
        _qr["state"] = "password"
    except asyncio.TimeoutError:
        _qr["state"] = "expired"
    except Exception as e:  # noqa: BLE001
        _qr["state"], _qr["error"] = "error", str(e)


@app.post("/telegram/qr/start", dependencies=auth)
async def qr_start():
    c = client()
    try:
        # Colab tunnels and idle VMs drop the Telegram socket; reconnect first.
        if not c.is_connected():
            await c.connect()
        if await _check_auth(15.0):
            return {"state": "done"}
        login = await c.qr_login()
    except FloodWaitError as e:
        raise HTTPException(status_code=429, detail=f"Telegram asks to wait {e.seconds} seconds before trying again")
    except Exception as e:  # noqa: BLE001
        name = type(e).__name__
        if "ApiId" in name or "ApiHash" in name:
            msg = "Telegram rejected your API ID / API Hash. Check them in Settings (no spaces)."
        elif "AuthKey" in name or "Unregistered" in name:
            msg = "Saved Telegram session is broken. Delete the .lecture-sync folder in Drive and restart Colab."
        else:
            msg = f"Telegram QR failed: {name}: {e}"
        raise HTTPException(status_code=502, detail=msg)
    try:
        svg = _qr_svg(login.url)
    except ImportError:
        raise HTTPException(status_code=500, detail="The qrcode package is missing on Colab. Re-run the Colab cell.")
    _qr.update(login=login, state="waiting", error=None)
    asyncio.create_task(_qr_wait(login))
    return {"state": "waiting", "svg": svg, "expires": login.expires.timestamp()}


@app.get("/telegram/qr/status", dependencies=auth)
async def qr_status():
    return {"state": _qr["state"], "error": _qr["error"]}


class PasswordIn(BaseModel):
    password: str


@app.post("/telegram/qr/password", dependencies=auth)
async def qr_password(body: PasswordIn):
    await client().sign_in(password=body.password)
    _set_authorized(True)
    _qr["state"] = "done"
    return {"ok": True}


@app.get("/telegram/chats", dependencies=auth)
async def chats():
    out = []
    async for d in client().iter_dialogs(limit=200):
        if d.is_group or d.is_channel:
            out.append({"id": d.id, "title": d.name})
    return out


@app.get("/telegram/files", dependencies=auth)
async def files(chat_id: int, limit: int = 100, q: str = ""):
    out = []
    kw = {"search": q.strip()} if q.strip() else {}
    async for m in client().iter_messages(chat_id, limit=limit, **kw):
        if m.file and m.file.size:
            out.append({
                "id": m.id,
                "name": m.file.name or f"message-{m.id}{m.file.ext or ''}",
                "size": m.file.size,
                "date": m.date.isoformat(),
                "caption": (m.message or "")[:300],
            })
    return out


class LinkIn(BaseModel):
    link: str


@app.post("/telegram/resolve-link", dependencies=auth)
async def resolve_link(body: LinkIn):
    """t.me/c/123/45, t.me/c/123/9/45 (topics), t.me/name/45 -> the file in that message."""
    m = re.search(r"t\.me/(?:s/)?(c/(\d+)|[A-Za-z0-9_]{4,})/(?:\d+/)?(\d+)", body.link.strip())
    if not m:
        raise HTTPException(status_code=400, detail="not a Telegram message link")
    c = client()
    if m.group(2):
        chat_id = int("-100" + m.group(2))
    else:
        try:
            chat_id = utils.get_peer_id(await c.get_entity(m.group(1)))
        except Exception:
            raise HTTPException(status_code=404, detail="chat not found")
    try:
        msg = await c.get_messages(chat_id, ids=int(m.group(3)))
    except Exception:
        raise HTTPException(status_code=404, detail="you are not a member of this chat")
    if not msg or not msg.file or not msg.file.size:
        raise HTTPException(status_code=404, detail="that message has no file")
    return {"chat_id": chat_id, "id": msg.id, "size": msg.file.size,
            "name": msg.file.name or f"message-{msg.id}{msg.file.ext or ''}",
            "date": msg.date.isoformat(), "caption": (msg.message or "")[:300]}


# ---------------------------------------------------------------- drive

@app.get("/drive/list", dependencies=auth)
def drive_list(path: str = ""):
    base = safe_path(path)
    if not base.is_dir():
        raise HTTPException(status_code=404, detail="not a folder")
    items = []
    try:
        entries = list(base.iterdir())
    except OSError as e:
        raise HTTPException(status_code=503, detail=f"Google Drive could not be read: {e}")
    for e in entries:
        if e.name.startswith(".lecture-sync"):
            continue
        # Drive sync can list files it can't stat (shortcuts, half-synced or deleted files).
        try:
            is_dir = e.is_dir()
            st = e.stat()
        except OSError:
            continue
        items.append({"name": e.name, "dir": is_dir,
                      "size": 0 if is_dir else st.st_size,
                      "modified": st.st_mtime})
    items.sort(key=lambda x: (not x["dir"], x["name"].lower()))
    return {"path": path.strip("/"), "items": items, "mounted": drive_mounted()}


class PathIn(BaseModel):
    path: str


class RenameIn(BaseModel):
    path: str
    new_name: str


@app.post("/drive/mkdir", dependencies=auth)
def drive_mkdir(body: PathIn):
    safe_path(body.path).mkdir(parents=True, exist_ok=False)
    return {"ok": True}


@app.post("/drive/rename", dependencies=auth)
def drive_rename(body: RenameIn):
    if "/" in body.new_name or body.new_name in ("", ".", ".."):
        raise HTTPException(status_code=400, detail="bad name")
    src = safe_path(body.path)
    src.rename(src.with_name(body.new_name))
    return {"ok": True}


@app.post("/drive/delete", dependencies=auth)
def drive_delete(body: PathIn):
    target = safe_path(body.path)
    if target == DRIVE_ROOT.resolve():
        raise HTTPException(status_code=400, detail="refusing to delete drive root")
    # Mounted Drive moves removed items to Drive's own trash, so this is recoverable
    # for 30 days from drive.google.com.
    shutil.rmtree(target) if target.is_dir() else target.unlink()
    return {"ok": True}


# ---------------------------------------------------------------- jobs

@dataclass
class Job:
    id: str
    chat_id: int
    message_id: int
    dest: str
    extra_ids: list[int] = field(default_factory=list)  # further volumes of a split archive
    extract: bool = True          # False: keep archives compressed, copy them as they are
    password: str | None = None   # archive password handed to 7z
    subfolder: bool = False       # always extract into a folder named after the archive
    rename: str | None = None     # new file name (or folder name when extracting)
    kind: str = "download"        # "download" (Telegram -> Drive) or "upload" (Drive -> Telegram)
    src: str = ""                 # upload: Drive-relative file path
    target: str = ""              # upload: "me", a chat id or @username
    split: bool = False           # upload: user agreed to cut an oversized file into parts
    mode: str = "file"            # upload: "file", or for folders "archive" (one 7z) / "batch" (file by file)
    caption: str = ""
    url: str = ""                 # link: the address the user pasted
    platform: str = ""            # link: sharepoint, gdrive, dropbox, mediafire, youtube, direct
    quality: str = "720"          # link (video sites only): "1080", "720", "480" or "audio"
    compress: bool = False        # link: shrink videos with ffmpeg / other files with 7z first
    to: str = "drive"             # link: "drive" (dest folder) or "telegram" (target chat)
    bundle: bool = False          # link (playlists): pack every video into one 7z archive
    parts: int = 0
    name: str = ""
    size: int = 0
    state: str = "queued"      # queued -> downloading -> extracting -> uploading -> done | failed | cancelled (+ paused)
    progress: float = 0.0
    speed: float = 0.0
    paused: bool = False
    error: str | None = None
    created: float = field(default_factory=time.time)


JOBS: dict[str, Job] = {}
# Per-job pause gates (set = running) and the task currently running a job.
GATES: dict[str, asyncio.Event] = {}
TASKS: dict[str, asyncio.Task] = {}
# One job at a time: Colab's disk is the bottleneck, and Telegram gets
# grumpy (FloodWait) when several big downloads run from one account.
_queue: asyncio.Queue[str] = asyncio.Queue()
FINISHED = ("done", "failed", "cancelled")


class JobIn(BaseModel):
    chat_id: int
    message_id: int
    dest: str
    extra_ids: list[int] = []
    extract: bool = True
    password: str | None = None
    subfolder: bool = False
    rename: str | None = None


def _public(j: Job) -> dict:
    d = asdict(j)
    d["has_password"] = bool(d.pop("password"))
    return d


async def _enqueue(body: JobIn) -> Job:
    safe_path(body.dest).mkdir(parents=True, exist_ok=True)
    if body.rename and ("/" in body.rename or body.rename.strip() in ("", ".", "..")):
        raise HTTPException(status_code=400, detail="bad name")
    job = Job(id=uuid.uuid4().hex[:10], **body.model_dump())
    gate = asyncio.Event()
    gate.set()
    GATES[job.id] = gate
    JOBS[job.id] = job
    await _queue.put(job.id)
    return job


@app.post("/jobs", dependencies=auth)
async def create_job(body: JobIn):
    return _public(await _enqueue(body))


@app.get("/jobs", dependencies=auth)
def list_jobs():
    return [_public(j) for j in sorted(JOBS.values(), key=lambda j: -j.created)]


def _job(job_id: str) -> Job:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="no such job")
    return JOBS[job_id]


@app.post("/jobs/{job_id}/pause", dependencies=auth)
def pause_job(job_id: str):
    j = _job(job_id)
    if j.state in FINISHED:
        raise HTTPException(status_code=409, detail="job already finished")
    if j.state in ("extracting", "uploading"):
        raise HTTPException(status_code=409, detail="can only pause while waiting or downloading")
    j.paused = True
    GATES[job_id].clear()
    return _public(j)


@app.post("/jobs/{job_id}/resume", dependencies=auth)
def resume_job(job_id: str):
    j = _job(job_id)
    j.paused = False
    GATES[job_id].set()
    return _public(j)


@app.post("/jobs/{job_id}/cancel", dependencies=auth)
def cancel_job(job_id: str):
    j = _job(job_id)
    if j.state in FINISHED:
        return _public(j)
    j.state, j.paused, j.speed = "cancelled", False, 0.0
    GATES[job_id].set()  # wake a paused job so it can unwind
    t = TASKS.get(job_id)
    if t:
        t.cancel()
    return _public(j)


@app.post("/jobs/{job_id}/retry", dependencies=auth)
async def retry_job(job_id: str):
    j = _job(job_id)
    if j.state not in ("failed", "cancelled"):
        raise HTTPException(status_code=409, detail="only failed or cancelled jobs can be retried")
    if j.kind == "link":
        new = await _enqueue_link(LinkIn(url=j.url, to=j.to, dest=j.dest if j.to == "drive" else "",
                                         target=j.target, quality=j.quality, compress=j.compress))
        JOBS.pop(job_id, None)
        GATES.pop(job_id, None)
        return _public(new)
    if j.kind == "upload":
        new = await _enqueue_upload(UploadIn(path=j.src, target=j.target, split=j.split,
                                             caption=j.caption), j.dest)
        JOBS.pop(job_id, None)
        GATES.pop(job_id, None)
        return _public(new)
    new = await _enqueue(JobIn(chat_id=j.chat_id, message_id=j.message_id, dest=j.dest,
                               extra_ids=j.extra_ids, extract=j.extract, password=j.password,
                               subfolder=j.subfolder, rename=j.rename))
    JOBS.pop(job_id, None)
    GATES.pop(job_id, None)
    return _public(new)


@app.delete("/jobs", dependencies=auth)
def clear_jobs():
    gone = [k for k, j in JOBS.items() if j.state in FINISHED]
    for k in gone:
        JOBS.pop(k, None)
        GATES.pop(k, None)
    return {"cleared": len(gone)}


# Telethon pulls a file over one request at a time, which Telegram caps at ~1-1.5 MB/s.
# Splitting the file into ranges and fetching them concurrently (512 KB requests, the
# API maximum) multiplies throughput on Colab's fast link.
PART = 512 * 1024
WORKERS = int(os.environ.get("LS_DL_WORKERS", "8"))


async def fast_download(cl, msg, work: Path, on_chunk, gate: asyncio.Event | None = None) -> Path:
    total = msg.file.size
    name = msg.file.name or f"message-{msg.id}{msg.file.ext or ''}"
    target = work / os.path.basename(name)

    async def slow_cb(d: int, t: int) -> None:
        on_chunk(d, t)
        if gate is not None:
            await gate.wait()  # Telethon awaits async callbacks, which pauses the stream

    if total < 8 * PART:
        return Path(await cl.download_media(msg, file=str(target), progress_callback=slow_cb))
    parts = (total + PART - 1) // PART
    done = 0
    with open(target, "wb") as fh:
        fh.truncate(total)

    dc_id, location = utils.get_input_location(msg.media)
    senders: list = []
    queue: asyncio.Queue[int] = asyncio.Queue()
    for p in range(parts):
        queue.put_nowait(p)

    async def worker(sender) -> None:
        nonlocal done
        with open(target, "r+b") as f:
            while True:
                try:
                    p = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                if gate is not None:
                    await gate.wait()  # paused: hold here, keep every finished part on disk
                for attempt in range(5):
                    try:
                        # client._call waits for and decodes the reply; sender.send only
                        # returns a pending future, which silently broke the parallel path.
                        res = await cl._call(sender, GetFileRequest(location, offset=p * PART, limit=PART))
                        break
                    except FloodWaitError as e:
                        await asyncio.sleep(e.seconds + 1)
                    except (ConnectionError, asyncio.TimeoutError):
                        if attempt == 4:
                            raise
                        await asyncio.sleep(1 + attempt)
                f.seek(p * PART)
                f.write(res.bytes)
                done += len(res.bytes)
                on_chunk(done, total)

    try:
        # Each worker gets its own TCP connection to the file's data centre, so
        # Telegram serves them in parallel instead of queueing them on one socket.
        n = max(1, min(WORKERS, parts))
        # The first sender to a foreign DC imports the authorization; the rest reuse its key.
        first, key = await _open_sender(cl, dc_id, None)
        senders.append(first)
        results = await asyncio.gather(*(_open_sender(cl, dc_id, key) for _ in range(n - 1)),
                                       return_exceptions=True)
        senders += [r[0] for r in results if not isinstance(r, BaseException)]
        print(f"[DL] {len(senders)} parallel connections to DC {dc_id} "
              f"(crypto: {CRYPTO_BACKEND})", flush=True)
        await asyncio.gather(*(worker(s) for s in senders))
    except FloodWaitError:
        raise
    except Exception as e:
        # Anything unexpected: fall back to the plain single-stream download.
        print(f"[DL] parallel download failed, using single stream: {e!r}", flush=True)
        target.unlink(missing_ok=True)
        return Path(await cl.download_media(msg, file=str(target), progress_callback=slow_cb))
    finally:
        for s in senders:
            try:
                await s.disconnect()
            except Exception:
                pass
    return target


async def _open_sender(cl, dc_id: int, key=None):
    """Open an extra, independent MTProto connection to `dc_id` (FastTelethon style).
    Returns (sender, auth_key) so later connections can reuse the imported key."""
    dc = await cl._get_dc(dc_id)
    if key is None and dc_id == cl.session.dc_id:
        key = cl.session.auth_key
    sender = MTProtoSender(key, loggers=cl._log)
    await sender.connect(cl._connection(dc.ip_address, dc.port, dc.id,
                                        loggers=cl._log, proxy=cl._proxy))
    if key is None:
        auth = await cl(ExportAuthorizationRequest(dc_id))
        cl._init_request.query = ImportAuthorizationRequest(id=auth.id, bytes=auth.bytes)
        await cl._call(sender, InvokeWithLayerRequest(LAYER, cl._init_request))
        key = sender.auth_key
    return sender, key


ARCHIVE_EXT = (".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".tbz2",
               ".xz", ".txz", ".zst", ".cab", ".iso", ".lzh", ".arj")


def is_archive(name: str) -> bool:
    n = name.lower()
    # Split volumes: .001, .z01, .r00, .part1.rar
    return n.endswith(ARCHIVE_EXT) or bool(re.search(r"\.(\d{3}|z\d{2}|r\d{2})$", n))


def archive_base(name: str) -> str:
    """'Lec 1.part1.rar' -> 'Lec 1', 'a.tar.gz' -> 'a'."""
    n = re.sub(r"\.(part\d+\.rar|tar\.(gz|bz2|xz)|\d{3}|z\d{2}|r\d{2})$", "", name, flags=re.I)
    n = re.sub(r"\.(zip|rar|7z|tar|gz|bz2|xz|tgz)$", "", n, flags=re.I)
    return n.strip() or "extracted"


def unique(p: Path) -> Path:
    """Never overwrite or merge into an existing Drive item: add ' (2)', ' (3)'..."""
    if not p.exists():
        return p
    stem, suf = (p.name, "") if p.is_dir() else (p.stem, p.suffix)
    i = 2
    while (p.with_name(f"{stem} ({i}){suf}")).exists():
        i += 1
    return p.with_name(f"{stem} ({i}){suf}")


async def _wait_if_paused(job: Job, resume_state: str) -> None:
    gate = GATES[job.id]
    if not gate.is_set():
        job.state, job.speed = "paused", 0.0
        await gate.wait()
        job.state = resume_state


async def _run(job: Job) -> None:
    await _wait_if_paused(job, "queued")
    ids = [job.message_id, *job.extra_ids]
    msgs = await client().get_messages(job.chat_id, ids=ids)
    msgs = msgs if isinstance(msgs, list) else [msgs]
    if not msgs or any(m is None or not m.file for m in msgs):
        raise RuntimeError("message has no file")

    total = sum(m.file.size for m in msgs)
    job.size = total
    job.name = msgs[0].file.name or f"message-{msgs[0].id}{msgs[0].file.ext or ''}"
    first_is_archive = is_archive(job.name)
    need = total * (EXTRACT_FACTOR if job.extract and first_is_archive else 1.1)
    if shutil.disk_usage(SCRATCH).free < need:
        raise RuntimeError(f"not enough scratch space, need ~{need / 1e9:.1f} GB")

    work = SCRATCH / job.id
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    gate = GATES[job.id]
    proc = None
    try:
        job.state = "downloading"
        before = 0
        active = {"t": 0.0, "since": time.time()}
        files: list[Path] = []

        def on_chunk(done: int, _total: int) -> None:
            now = time.time()
            if gate.is_set():
                active["t"] += now - active["since"]
                job.state = "downloading"
            else:
                job.state, job.speed = "paused", 0.0
            active["since"] = now
            job.progress = (before + done) / total
            if gate.is_set():
                job.speed = (before + done) / max(active["t"], 0.1)

        for m in msgs:
            while True:
                await _wait_if_paused(job, "downloading")
                try:
                    files.append(await fast_download(client(), m, work, on_chunk, gate))
                    break
                except FloodWaitError as e:
                    job.state = f"waiting {e.seconds}s (telegram limit)"
                    await asyncio.sleep(e.seconds + 1)
                    job.state = "downloading"
            before += m.file.size

        archive = files[0]
        out = work / "out"
        out.mkdir()
        extracted = False
        if job.extract and is_archive(archive.name):
            job.state, job.progress, job.speed = "extracting", 0.0, 0.0
            # 7z handles zip, rar, 7z, tar, gz and split volumes; -aoa avoids prompts.
            # Always pass -p so an encrypted archive fails fast instead of waiting for input.
            proc = await asyncio.create_subprocess_exec(
                "7z", "x", "-y", "-aoa", f"-p{job.password or ''}", f"-o{out}", str(archive),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            _, err = await proc.communicate()
            msg_err = (err or b"").decode(errors="ignore")
            if "Wrong password" in msg_err or "Can not open encrypted archive" in msg_err:
                raise RuntimeError("wrong or missing archive password" if job.password
                                   else "archive is password protected, retry with its password")
            extracted = proc.returncode == 0 and any(out.iterdir())
            if extracted:
                for f in files:
                    f.unlink(missing_ok=True)  # free the space before copying
                items = list(out.iterdir())
                if len(items) > 1 or job.subfolder or job.rename:
                    # Keep everything together in a folder named after the archive (or the new name).
                    folder = out / ((job.rename or "").strip() or archive_base(archive.name))
                    folder.mkdir(exist_ok=True)
                    for it in items:
                        if it != folder:
                            shutil.move(str(it), str(folder / it.name))
            else:
                shutil.rmtree(out, ignore_errors=True)
                out.mkdir()
        if not extracted:
            # Regular file, a kept-compressed archive, or one 7z couldn't open: copy as is.
            for i, f in enumerate(files):
                name = f.name
                if job.rename and len(files) == 1:
                    name = job.rename.strip()
                shutil.move(str(f), str(out / name))

        job.state, job.speed = "uploading", 0.0
        dest = safe_path(job.dest)
        dest.mkdir(parents=True, exist_ok=True)
        entries = list(out.iterdir())
        for i, e in enumerate(entries, 1):
            await asyncio.to_thread(shutil.move, str(e), str(unique(dest / e.name)))
            job.progress = i / len(entries)
        job.state, job.progress = "done", 1.0
    finally:
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        shutil.rmtree(work, ignore_errors=True)


# Automatic retries after a failure (network drops etc.); the desktop app sets this.
SETTINGS = {"auto_retries": 3}
RETRY_DELAYS = (3, 8, 15, 30, 60)
# Failures that another attempt cannot fix.
_NO_RETRY = ("password", "not found", "no space", "too big", "invalid", "forbidden", "private")


class SettingsIn(BaseModel):
    auto_retries: int = 3


@app.get("/settings", dependencies=auth)
def get_settings():
    return SETTINGS


@app.post("/settings", dependencies=auth)
def set_settings(s: SettingsIn):
    SETTINGS["auto_retries"] = max(0, min(5, s.auto_retries))
    return SETTINGS


async def _worker() -> None:
    while True:
        job_id = await _queue.get()
        job = JOBS.get(job_id)
        if job is None or job.state == "cancelled":
            continue
        runner = {"upload": _run_upload, "link": _run_link}.get(job.kind, _run)
        attempt = 0
        while True:
            task = asyncio.create_task(runner(job))
            TASKS[job.id] = task
            try:
                await task
                break
            except asyncio.CancelledError:
                job.state, job.speed = "cancelled", 0.0
                break
            except Exception as e:  # surface every failure to the UI instead of killing the loop
                if job.state == "cancelled":
                    break
                msg = str(e) or e.__class__.__name__
                if attempt < SETTINGS["auto_retries"] and not any(k in msg.lower() for k in _NO_RETRY):
                    attempt += 1
                    delay = RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)]
                    print(f"[JOB {job.id}] attempt {attempt} failed ({msg}), retrying in {delay}s", flush=True)
                    job.state, job.speed, job.progress = f"retrying {attempt}/{SETTINGS['auto_retries']}", 0.0, 0.0
                    job.error = f"Connection problem, trying again ({attempt}/{SETTINGS['auto_retries']})…"
                    await asyncio.sleep(delay)
                    if job.state == "cancelled":
                        break
                    job.state, job.error = "queued", None
                    continue
                job.state, job.error = "failed", msg
                break
            finally:
                TASKS.pop(job.id, None)


# ---------------------------------------------------------------- Drive -> Telegram

MIB = 1024 * 1024
# Telegram's per-file cap: 2000 MiB for normal accounts, 4000 MiB with Premium.
LIMIT_NORMAL = 2000 * MIB
LIMIT_PREMIUM = 4000 * MIB
# Volumes stay a little under the cap so container overhead never tips a part over.
VOLUME_MARGIN = 50 * MIB


async def _account_limit() -> tuple[bool, int]:
    c = client()
    if not c.is_connected():
        await c.connect()
    me = await c.get_me()
    premium = bool(getattr(me, "premium", False))
    return premium, LIMIT_PREMIUM if premium else LIMIT_NORMAL


def split_plan(size: int, limit: int) -> dict:
    """How a file of `size` bytes fits Telegram's `limit`: as is, or in N volumes."""
    if size <= limit:
        return {"needs_split": False, "parts": 1, "part_size": size}
    vol = limit - VOLUME_MARGIN
    return {"needs_split": True, "parts": -(-size // vol), "part_size": vol}


@app.get("/telegram/targets", dependencies=auth)
async def targets():
    out = [{"id": "me", "title": "Saved Messages", "type": "saved"}]
    async for d in client().iter_dialogs(limit=300):
        if d.is_user and getattr(d.entity, "is_self", False):
            continue
        t = "channel" if d.is_channel and not d.is_group else "group" if d.is_group else "user"
        out.append({"id": str(d.id), "title": d.name or str(d.id), "type": t,
                    "username": getattr(d.entity, "username", None) or ""})
    return out


class CheckIn(BaseModel):
    path: str


# Google Docs/Sheets/Slides in a mounted Drive are cloud pointers, not real files:
# reading them fails with "[Errno 95] Operation not supported".
GOOGLE_DOC_EXTS = {".gdoc", ".gsheet", ".gslides", ".gform", ".gdraw", ".gtable", ".gjam", ".gsite", ".gmap", ".gscript"}
GDOC_MSG = ("this is a Google Docs/Sheets/Slides file — it lives only in the cloud and can't be sent as a file. "
            "Open it in Google Drive, download it as PDF or Word/Excel/PowerPoint, then send that copy")


def _is_gdoc(p: Path) -> bool:
    return p.suffix.lower() in GOOGLE_DOC_EXTS


def _readable(f: Path) -> bool:
    if _is_gdoc(f):
        return False
    try:
        return f.is_file() and f.stat().st_size >= 0
    except OSError:
        return False


def _folder_files(p: Path) -> list[Path]:
    return sorted((f for f in p.rglob("*") if _readable(f)), key=lambda f: str(f.relative_to(p)).lower())


def _skipped_files(p: Path) -> int:
    return sum(1 for f in p.rglob("*") if _is_gdoc(f))


@app.post("/drive/check-upload", dependencies=auth)
async def check_upload(body: CheckIn):
    p = safe_path(body.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="not found in Drive")
    if not p.is_dir() and _is_gdoc(p):
        raise HTTPException(status_code=400, detail=GDOC_MSG)
    premium, limit = await _account_limit()
    if p.is_dir():
        files = _folder_files(p)
        size = sum(f.stat().st_size for f in files)
        biggest = max((f.stat().st_size for f in files), default=0)
        return {"name": p.name, "is_dir": True, "size": size, "total_size": size, "file_count": len(files),
                "premium": premium, "limit": limit, "batch_needs_split": biggest > limit,
                "batch_oversized": sum(1 for f in files if f.stat().st_size > limit),
                "skipped": _skipped_files(p), **split_plan(size, limit)}
    size = p.stat().st_size
    return {"name": p.name, "is_dir": False, "size": size, "file_count": 1,
            "premium": premium, "limit": limit, **split_plan(size, limit)}


class UploadIn(BaseModel):
    path: str
    target: str
    split: bool = False
    caption: str = ""
    target_title: str = ""
    mode: str = "archive"   # folders only: "archive" or "batch"


async def _enqueue_upload(body: UploadIn, label: str = "") -> Job:
    p = safe_path(body.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="not found in Drive")
    is_dir = p.is_dir()
    if is_dir and body.mode not in ("archive", "batch"):
        raise HTTPException(status_code=400, detail="bad folder mode")
    size = sum(f.stat().st_size for f in _folder_files(p)) if is_dir else p.stat().st_size
    job = Job(id=uuid.uuid4().hex[:10], chat_id=0, message_id=0,
              dest=label or body.target_title or body.target, kind="upload",
              src=body.path, target=body.target.strip(), split=body.split,
              mode=body.mode if is_dir else "file",
              caption=body.caption, name=p.name + ("/" if is_dir else ""), size=size)
    gate = asyncio.Event()
    gate.set()
    GATES[job.id] = gate
    JOBS[job.id] = job
    await _queue.put(job.id)
    return job


@app.post("/uploads", dependencies=auth)
async def create_upload(body: UploadIn):
    if not body.target.strip():
        raise HTTPException(status_code=400, detail="choose where to send the file")
    p = safe_path(body.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="not found in Drive")
    if not p.is_dir() and _is_gdoc(p):
        raise HTTPException(status_code=400, detail=GDOC_MSG)
    await _check_target(body.target.strip())
    _, limit = await _account_limit()
    if p.is_dir():
        files = _folder_files(p)
        if not files:
            raise HTTPException(status_code=400, detail="this folder has no files")
        too_big = (sum(f.stat().st_size for f in files) > limit) if body.mode == "archive" \
            else any(f.stat().st_size > limit for f in files)
    else:
        too_big = p.stat().st_size > limit
    if too_big and not body.split:
        raise HTTPException(status_code=409, detail="larger than Telegram allows; confirm splitting it into parts")
    return _public(await _enqueue_upload(body))


async def _resolve_target(c, target: str):
    if target == "me":
        return "me"
    if re.fullmatch(r"-?\d+", target):
        try:
            return await c.get_entity(int(target))
        except Exception:
            async for _ in c.iter_dialogs(limit=300):  # fill the entity cache, then retry
                pass
            return await c.get_entity(int(target))
    return await c.get_entity(target if target.startswith("@") or "t.me/" in target else "@" + target)


async def _check_target(target: str):
    """Make sure the chat exists and we're allowed to post there; raise a clear error otherwise."""
    if not target or target == "me":
        return "me"
    c = client()
    if not c.is_connected():
        await c.connect()
    try:
        entity = await _resolve_target(c, target)
    except Exception:
        raise HTTPException(status_code=404, detail=f"chat '{target}' was not found — it may be deleted, private, or the name is wrong")
    if getattr(entity, "deleted", False):
        raise HTTPException(status_code=404, detail="this account has been deleted")
    if getattr(entity, "left", False) or getattr(entity, "kicked", False):
        raise HTTPException(status_code=403, detail="you are not a member of this chat (left or removed)")
    if getattr(entity, "deactivated", False):
        raise HTTPException(status_code=404, detail="this group was deleted or upgraded")
    if hasattr(entity, "broadcast") or hasattr(entity, "participants_count"):
        try:
            perms = await c.get_permissions(entity, "me")
            if getattr(entity, "broadcast", False):
                allowed = perms.is_creator or (perms.is_admin and getattr(perms, "post_messages", True))
            else:
                allowed = getattr(perms, "send_messages", True) is not False and getattr(perms, "send_media", True) is not False
        except Exception:
            allowed = not getattr(entity, "broadcast", False) or bool(getattr(entity, "creator", False) or getattr(entity, "admin_rights", None))
        if not allowed:
            raise HTTPException(status_code=403, detail="you don't have permission to send files in this channel or group")
    return entity


class TargetIn(BaseModel):
    target: str


@app.post("/telegram/check-target", dependencies=auth)
async def check_target(body: TargetIn):
    e = await _check_target(body.target.strip())
    title = "Saved Messages" if e == "me" else (utils.get_display_name(e) or body.target)
    return {"ok": True, "title": title}


async def _7z(job: Job, args: list[str]) -> None:
    proc = await asyncio.create_subprocess_exec(
        "7z", *args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        _, err = await proc.communicate()
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    if proc.returncode != 0:
        raise RuntimeError(f"{job.state} failed: " + (err or b"").decode(errors="ignore")[-300:])


UP_WORKERS = int(os.environ.get("LS_UP_WORKERS", "8"))
BIG_FILE = 10 * MIB  # Telegram's threshold for SaveBigFilePart / InputFileBig


async def fast_upload(cl, f: Path, cb):
    """Upload a file over several parallel MTProto connections (FastTelethon style).
    A single connection is throttled by Telegram to a few hundred KB/s; 8 run side by side.
    One sequential reader feeds the workers so the mounted Drive is read in big straight runs."""
    size = f.stat().st_size
    parts = (size + PART - 1) // PART
    file_id = secrets.randbits(63)
    dc_id = cl.session.dc_id
    q: asyncio.Queue = asyncio.Queue(maxsize=UP_WORKERS * 4)
    done = 0
    senders: list = []

    async def reader() -> None:
        with open(f, "rb", buffering=8 * MIB) as fh:
            for p in range(parts):
                data = await asyncio.to_thread(fh.read, PART)
                await q.put((p, data))
        for _ in senders:
            await q.put(None)

    async def worker(sender) -> None:
        nonlocal done
        while True:
            item = await q.get()
            if item is None:
                return
            p, data = item
            for attempt in range(6):
                try:
                    ok = await cl._call(sender, SaveBigFilePartRequest(file_id, p, parts, data))
                    if not ok:
                        raise ConnectionError("part rejected")
                    break
                except FloodWaitError as e:
                    await asyncio.sleep(e.seconds + 1)
                except (ConnectionError, asyncio.TimeoutError):
                    if attempt == 5:
                        raise
                    await asyncio.sleep(1 + attempt)
            done += len(data)
            await cb(done, size)

    try:
        first, key = await _open_sender(cl, dc_id, None)
        senders.append(first)
        res = await asyncio.gather(*(_open_sender(cl, dc_id, key) for _ in range(min(UP_WORKERS, parts) - 1)),
                                   return_exceptions=True)
        senders += [r[0] for r in res if not isinstance(r, BaseException)]
        print(f"[UP] {len(senders)} parallel connections to DC {dc_id} (crypto: {CRYPTO_BACKEND})", flush=True)
        rd = asyncio.create_task(reader())
        try:
            await asyncio.gather(rd, *(worker(s) for s in senders))
        finally:
            rd.cancel()
    finally:
        for s in senders:
            try:
                await s.disconnect()
            except Exception:
                pass
    return InputFileBig(id=file_id, parts=parts, name=f.name)


async def _send(c, entity, job: Job, f: Path, cap: str, cb) -> None:
    while True:
        try:
            handle = None
            if f.stat().st_size >= BIG_FILE:
                try:
                    handle = await fast_upload(c, f, cb)
                except FloodWaitError:
                    raise
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    print(f"[UP] parallel upload failed, using single stream: {e!r}", flush=True)
            if handle is not None:
                await c.send_file(entity, handle, caption=cap[:1000], force_document=True,
                                  attributes=[DocumentAttributeFilename(f.name)])
                return
            await c.send_file(entity, str(f), caption=cap[:1000], force_document=True,
                              progress_callback=cb, part_size_kb=512)
            return
        except FloodWaitError as e:
            prev = job.state
            job.state = f"waiting {e.seconds}s (telegram limit)"
            await asyncio.sleep(e.seconds + 1)
            job.state = prev


async def _run_upload(job: Job) -> None:
    await _wait_if_paused(job, "queued")
    c = client()
    if not c.is_connected():
        await c.connect()
    src = safe_path(job.src)
    if not src.exists():
        raise RuntimeError("no longer exists in Drive")
    if not src.is_dir() and _is_gdoc(src):
        raise RuntimeError(GDOC_MSG)
    try:
        entity = await _resolve_target(c, job.target)
    except Exception:
        raise RuntimeError(f"could not find the chat or user '{job.target}'")
    _, limit = await _account_limit()
    is_dir = src.is_dir()

    work = SCRATCH / job.id
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    gate = GATES[job.id]
    try:
        # Build the list of (file, caption) pairs to send, zipping/splitting on Colab's disk first.
        items: list[tuple[Path, str]] = []
        if is_dir and job.mode == "batch":
            for f in _folder_files(src):
                rel = f"{src.name}/{f.relative_to(src)}"
                fsize = f.stat().st_size
                if fsize <= limit:
                    items.append((f, rel))
                    continue
                if not job.split:
                    raise RuntimeError(f"'{rel}' is larger than Telegram allows and splitting was not confirmed")
                job.state, job.progress, job.speed = "splitting", 0.0, 0.0
                sub = work / uuid.uuid4().hex[:6]
                sub.mkdir()
                await _7z(job, ["a", "-y", "-mx0", f"-v{(limit - VOLUME_MARGIN) // MIB}m", str(sub / f"{f.name}.7z"), str(f)])
                vols = sorted(sub.glob(f"{f.name}.7z.*"))
                items += [(v, f"{rel}\nPart {i}/{len(vols)} — open part 1 with 7-Zip to join them")
                          for i, v in enumerate(vols, 1)]
        else:
            size = sum(f.stat().st_size for f in _folder_files(src)) if is_dir else src.stat().st_size
            job.size = size
            plan = split_plan(size, limit)
            if plan["needs_split"] and not job.split:
                raise RuntimeError("larger than Telegram allows and splitting was not confirmed")
            if is_dir:
                if shutil.disk_usage(SCRATCH).free < size * 1.05:
                    raise RuntimeError(f"not enough Colab space to zip, need ~{size * 1.05 / 1e9:.1f} GB")
                job.state, job.progress, job.speed = ("zipping" if not plan["needs_split"] else "splitting"), 0.0, 0.0
                ext = "zip" if not plan["needs_split"] else "7z"
                args = ["a", "-y", "-mx0"]
                if plan["needs_split"]:
                    args.append(f"-v{plan['part_size'] // MIB}m")
                else:
                    args.append("-tzip")
                excl = [f"-xr!*{e}" for e in sorted(GOOGLE_DOC_EXTS)]
                await _7z(job, args + excl + [str(work / f"{src.name}.{ext}"), str(src)])
                files = sorted(work.glob(f"{src.name}.{ext}*"))
            elif plan["needs_split"]:
                if shutil.disk_usage(SCRATCH).free < size * 1.05:
                    raise RuntimeError(f"not enough Colab space to split, need ~{size * 1.05 / 1e9:.1f} GB")
                job.state, job.progress, job.speed = "splitting", 0.0, 0.0
                await _7z(job, ["a", "-y", "-mx0", f"-v{plan['part_size'] // MIB}m", str(work / f"{src.name}.7z"), str(src)])
                files = sorted(work.glob(f"{src.name}.7z.*"))
            else:
                files = [src]
            if not files:
                raise RuntimeError("zipping produced nothing")
            for i, f in enumerate(files, 1):
                cap = job.caption
                if len(files) > 1:
                    cap = (f"{cap}\n" if cap else "") + f"Part {i}/{len(files)} — open part 1 with 7-Zip to join them"
                items.append((f, cap))
        if not items:
            raise RuntimeError("nothing to send")

        batch = is_dir and job.mode == "batch"
        if batch and job.caption:
            items = [(f, f"{job.caption}\n{cap}") for f, cap in items]
        job.parts = len(items)
        total = sum(f.stat().st_size for f, _ in items)
        sent = 0
        started = time.time()
        for i, (f, cap) in enumerate(items, 1):
            await _wait_if_paused(job, job.state)
            if len(items) == 1:
                job.state = "sending"
            elif batch:
                job.state = f"sending file {i}/{len(items)}"
            else:
                job.state = f"sending part {i}/{len(items)}"

            async def cb(done: int, _t: int, base=sent) -> None:
                job.progress = (base + done) / max(total, 1)
                job.speed = (base + done) / max(time.time() - started, 0.1)
                await gate.wait()

            await _send(c, entity, job, f, cap, cb)
            sent += f.stat().st_size
            if batch:
                await asyncio.sleep(1)  # be gentle with Telegram between many small sends
        job.state, job.progress, job.speed = "done", 1.0, 0.0
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- Link -> Drive / Telegram
# Only public / "anyone with the link" shares are supported: no account sign-in is ever asked.

import json
import urllib.parse
import urllib.request
import threading

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
VIDEO_SITES = ("youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "loom.com")
VIDEO_EXT = (".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".wmv", ".flv", ".ts", ".mpg", ".mpeg", ".3gp")
# Already-compressed formats: 7z barely shrinks these, so we don't waste time on them.
PACKED_EXT = ARCHIVE_EXT + (".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp3", ".m4a", ".aac", ".ogg",
                            ".opus", ".flac", ".pdf", ".docx", ".xlsx", ".pptx", ".epub", ".apk", ".heic")
QUALITY_FMT = {
    "1080": "bv*[height<=1080]+ba/b[height<=1080]/b",
    "720": "bv*[height<=720]+ba/b[height<=720]/b",
    "480": "bv*[height<=480]+ba/b[height<=480]/b",
    "audio": "ba[ext=m4a]/ba/b",
}


def _host(url: str) -> str:
    return (urllib.parse.urlparse(url).hostname or "").lower()


def detect_platform(url: str) -> str:
    h = _host(url)
    if not h:
        return ""
    if h.endswith("sharepoint.com") or h in ("1drv.ms", "onedrive.live.com"):
        return "sharepoint"
    if h in ("drive.google.com", "docs.google.com", "drive.usercontent.google.com"):
        return "gdrive"
    if h.endswith("dropbox.com") or h.endswith("dropboxusercontent.com"):
        return "dropbox"
    if h.endswith("mediafire.com"):
        return "mediafire"
    if any(h == s or h.endswith("." + s) for s in VIDEO_SITES):
        return "youtube"
    return "direct"


def _http_get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read(2_000_000).decode("utf-8", errors="ignore")


def resolve_url(raw: str) -> tuple[str, str]:
    """Turn a share/page link into a direct download link. Returns (url, platform)."""
    url = raw.strip()
    platform = detect_platform(url)
    u = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(u.query)
    if platform == "sharepoint":
        share = (qs.get("share") or [""])[0]
        if share and "/_layouts/15/" in u.path:
            # stream.aspx / onedrive.aspx player page -> download.aspx keeps the same share token.
            base = u.path.split("/_layouts/15/")[0]
            return f"{u.scheme}://{u.netloc}{base}/_layouts/15/download.aspx?share={urllib.parse.quote(share)}", platform
        if "download=1" not in url:
            url += ("&" if u.query else "?") + "download=1"
        return url, platform
    if platform == "gdrive":
        m = re.search(r"/d/([\w-]{10,})", u.path)
        fid = m.group(1) if m else (qs.get("id") or [""])[0]
        if not fid:
            raise HTTPException(status_code=400, detail="this Google Drive link has no file id (folders aren't supported yet)")
        return f"https://drive.usercontent.google.com/download?id={fid}&export=download&confirm=t", platform
    if platform == "dropbox":
        q = {k: v for k, v in qs.items() if k != "dl"}
        q["dl"] = ["1"]
        return urllib.parse.urlunparse(u._replace(query=urllib.parse.urlencode(q, doseq=True))), platform
    if platform == "mediafire":
        try:
            page = _http_get_text(url)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"MediaFire page could not be opened: {e}")
        m = re.search(r'href="(https?://download[^"]+)"', page)
        if not m:
            raise HTTPException(status_code=400, detail="MediaFire file not found (deleted or private?)")
        return m.group(1), platform
    return url, platform


def _ydl(opts: dict | None = None):
    try:
        import yt_dlp
    except ImportError:
        subprocess.run([os.sys.executable, "-m", "pip", "-q", "install", "yt-dlp"], check=True)
        import yt_dlp
    return yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noprogress": True, **(opts or {})})


def _filename_from(resp, url: str) -> str:
    cd = resp.headers.get("Content-Disposition") or ""
    m = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", cd, re.I) or re.search(r'filename="?([^";]+)"?', cd, re.I)
    name = urllib.parse.unquote(m.group(1).strip()) if m else ""
    if not name:
        name = urllib.parse.unquote(os.path.basename(urllib.parse.urlparse(resp.url or url).path))
    name = re.sub(r'[\\/:*?"<>|\r\n]+', "_", name).strip(" .")
    if not name or name.lower().endswith(".aspx"):
        name = "download"
    return name[:180]


class LinkCheckIn(BaseModel):
    url: str


@app.post("/links/inspect", dependencies=auth)
async def inspect_link(body: LinkCheckIn):
    url = body.url.strip()
    platform = detect_platform(url)
    if not platform or not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="paste a full link starting with https://")
    out = {"platform": platform, "quality": platform == "youtube", "playlist": False,
           "title": "", "count": 1, "size": 0}
    if platform == "youtube":
        try:
            info = await asyncio.to_thread(
                lambda: _ydl({"extract_flat": "in_playlist", "skip_download": True}).extract_info(url, download=False))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"video not available: {str(e)[-200:]}")
        entries = [e for e in (info.get("entries") or []) if e]
        out.update(title=info.get("title") or "", playlist=bool(entries), count=len(entries) or 1)
        return out
    direct, _ = await asyncio.to_thread(resolve_url, url)

    def head():
        req = urllib.request.Request(direct, headers={"User-Agent": UA, "Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = (r.headers.get("Content-Type") or "").lower()
            cr = r.headers.get("Content-Range") or ""
            size = int(cr.split("/")[-1]) if "/" in cr and cr.split("/")[-1].isdigit() else int(r.headers.get("Content-Length") or 0)
            return _filename_from(r, direct), size, ctype
    try:
        name, size, ctype = await asyncio.to_thread(head)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"the link could not be opened — is it shared with 'anyone with the link'? ({e})")
    if "text/html" in ctype:
        raise HTTPException(status_code=400, detail="this link opens a web page, not a file — make sure it's shared with 'anyone with the link'")
    out.update(title=name, size=size)
    return out


class LinkIn(BaseModel):
    url: str
    to: str = "drive"          # "drive" or "telegram"
    dest: str = ""             # drive folder
    target: str = ""           # telegram chat
    target_title: str = ""
    quality: str = "720"
    compress: bool = False
    bundle: bool = False       # playlists: one 7z archive (split for Telegram) instead of video by video


async def _enqueue_link(body: LinkIn) -> Job:
    if body.to not in ("drive", "telegram"):
        raise HTTPException(status_code=400, detail="choose Google Drive or Telegram")
    if body.quality not in QUALITY_FMT:
        raise HTTPException(status_code=400, detail="bad quality")
    platform = detect_platform(body.url)
    if not platform:
        raise HTTPException(status_code=400, detail="bad link")
    if body.to == "drive":
        safe_path(body.dest).mkdir(parents=True, exist_ok=True)
        dest = body.dest
    else:
        if not body.target.strip():
            raise HTTPException(status_code=400, detail="choose where to send the file")
        dest = body.target_title or body.target
    job = Job(id=uuid.uuid4().hex[:10], chat_id=0, message_id=0, dest=dest, kind="link",
              url=body.url.strip(), platform=platform, quality=body.quality, compress=body.compress,
              bundle=body.bundle, to=body.to, target=body.target.strip(), name=body.url.strip()[:80])
    gate = asyncio.Event()
    gate.set()
    GATES[job.id] = gate
    JOBS[job.id] = job
    await _queue.put(job.id)
    return job


@app.post("/links", dependencies=auth)
async def create_link(body: LinkIn):
    if body.to == "telegram":
        await _check_target(body.target.strip())
    return _public(await _enqueue_link(body))


def _http_download(job: Job, url: str, work: Path, gate_ok, on_chunk) -> Path:
    """Stream a direct link to disk; 8 parallel ranges when the server allows it."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        name = _filename_from(r, url)
        cr = r.headers.get("Content-Range") or ""
        ranged = r.status == 206 and "/" in cr and cr.split("/")[-1].isdigit()
        total = int(cr.split("/")[-1]) if ranged else int(r.headers.get("Content-Length") or 0)
        if "text/html" in (r.headers.get("Content-Type") or "").lower():
            raise RuntimeError("the link opens a web page, not a file — is it shared with 'anyone with the link'?")
    job.name, job.size = name, total
    if total and shutil.disk_usage(SCRATCH).free < total * (2.2 if job.compress else 1.1):
        raise RuntimeError(f"not enough Colab space, need ~{total * 2.2 / 1e9:.1f} GB")
    target = work / name
    done = 0
    lock = threading.Lock()

    def add(n: int) -> None:
        nonlocal done
        with lock:
            done += n
        on_chunk(done, total)

    def fetch(start: int | None, end: int | None, fh_path: Path, offset: int) -> None:
        hdr = {"User-Agent": UA}
        if start is not None:
            hdr["Range"] = f"bytes={start}-{end}"
        for attempt in range(5):
            got = 0
            if start is not None:
                hdr["Range"] = f"bytes={start}-{end}"
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=60) as resp, \
                        open(fh_path, "r+b") as f:
                    f.seek(offset)
                    while True:
                        if job.state == "cancelled":
                            raise RuntimeError("cancelled")
                        gate_ok()
                        chunk = resp.read(1024 * 1024)
                        if not chunk:
                            return
                        f.write(chunk)
                        got += len(chunk)
                        add(len(chunk))
                    return
            except RuntimeError:
                raise
            except urllib.error.HTTPError as e:
                if 400 <= e.code < 500 or attempt == 4:
                    raise  # refused (e.g. 429 too many connections): let the caller fall back
                time.sleep(1 + attempt)
                if start is not None:
                    start, offset = start + got, offset + got
                    if start > end:
                        return
            except Exception:
                if attempt == 4 or start is None:
                    raise
                time.sleep(1 + attempt)
                # resume this range where it stopped
                start, offset = start + got, offset + got
                if start > end:
                    return

    with open(target, "wb") as fh:
        if total:
            fh.truncate(total)
    if ranged and total > 16 * MIB:
        n = 8
        step = -(-total // n)
        threads = []
        errors: list[BaseException] = []

        def run(s, e):
            try:
                fetch(s, e, target, s)
            except BaseException as ex:
                errors.append(ex)
        for i in range(n):
            s, e = i * step, min(total - 1, (i + 1) * step - 1)
            if s > e:
                break
            t = threading.Thread(target=run, args=(s, e), daemon=True)
            t.start()
            threads.append(t)
        for t in threads:
            t.join()
        if errors:
            if job.state == "cancelled":
                raise errors[0]
            # Some hosts refuse several connections at once (HTTP 429/403): fall back to one stream.
            print(f"[LINK] parallel download refused ({errors[0]}), retrying with one connection", flush=True)
            done = 0
            fetch(None, None, target, 0)
    else:
        fetch(None, None, target, 0)
    if not job.size:
        job.size = target.stat().st_size
    return target


def _video_items(job: Job) -> tuple[str, list[str]]:
    """(playlist title or "", list of video URLs)."""
    info = _ydl({"extract_flat": "in_playlist", "skip_download": True}).extract_info(job.url, download=False)
    entries = [e for e in (info.get("entries") or []) if e]
    if not entries:
        return "", [job.url]
    urls = [e.get("url") or e.get("webpage_url") or f"https://www.youtube.com/watch?v={e.get('id')}" for e in entries]
    return re.sub(r'[\\/:*?"<>|]+', "_", info.get("title") or "Playlist").strip()[:120], urls


def _ytdlp_download(job: Job, url: str, work: Path, index: int, total_items: int, gate_ok, on_chunk) -> Path:
    def hook(d):
        if job.state == "cancelled":
            raise RuntimeError("cancelled")
        gate_ok()
        if d.get("status") == "downloading":
            on_chunk(d.get("downloaded_bytes") or 0, d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
    prefix = f"{index:02d} - " if total_items > 1 else ""
    opts = {"format": QUALITY_FMT[job.quality], "outtmpl": str(work / f"{prefix}%(title).150B.%(ext)s"),
            "progress_hooks": [hook], "concurrent_fragment_downloads": 8, "restrictfilenames": False,
            "windowsfilenames": True}
    if job.quality != "audio":
        opts["merge_output_format"] = "mp4"
    with _ydl(opts) as y:
        info = y.extract_info(url, download=True)
        path = Path(y.prepare_filename(info))
    if not path.exists():
        alts = [p for p in work.iterdir() if p.is_file() and p.stem == path.stem]
        if not alts:
            raise RuntimeError("download produced no file")
        path = alts[0]
    if job.quality != "audio" and path.suffix.lower() != ".mp4":
        mp4 = path.with_suffix(".mp4")
        if mp4.exists():
            path = mp4
    return path


# Width cap per requested quality: compression never downgrades the resolution the user chose.
MAX_W = {"1080": 1920, "720": 1280, "480": 854}


async def _ffmpeg_shrink(job: Job, src: Path) -> Path:
    """Lecture profile: H.264 CRF 26 keeps slide text sharp at a fraction of the size."""
    out = src.with_name(src.stem + " (compressed).mp4")
    dur = 0.0
    try:
        p = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(src),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        o, _ = await p.communicate()
        dur = float(json.loads(o or b"{}").get("format", {}).get("duration") or 0)
    except Exception:
        pass
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-vf", f"scale='min({MAX_W.get(job.quality, 1280)},iw)':-2",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", str(out),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            m = re.match(rb"out_time_us=(\d+)", line)
            if m and dur:
                job.progress = min(0.99, int(m.group(1)) / 1e6 / dur)
        await proc.wait()
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        return src  # compression failed: keep the original instead of losing it
    if out.stat().st_size >= src.stat().st_size:
        out.unlink(missing_ok=True)
        return src  # already efficient: the original is smaller
    final = src.with_name(src.stem + ".mp4")
    src.unlink(missing_ok=True)
    out.rename(final)
    return final


async def _shrink(job: Job, f: Path) -> Path:
    n = f.name.lower()
    if n.endswith(VIDEO_EXT):
        job.state, job.progress, job.speed = "compressing video", 0.0, 0.0
        return await _ffmpeg_shrink(job, f)
    if n.endswith(PACKED_EXT):
        return f  # already compressed: 7z would gain almost nothing
    job.state, job.progress, job.speed = "compressing", 0.0, 0.0
    out = f.with_name(f.name + ".7z")
    try:
        await _7z(job, ["a", "-y", "-mx9", "-mmt=on", str(out), str(f)])
    except RuntimeError:
        out.unlink(missing_ok=True)
        return f
    if out.stat().st_size >= f.stat().st_size:
        out.unlink(missing_ok=True)
        return f
    f.unlink(missing_ok=True)
    return out


async def _deliver(job: Job, f: Path, work: Path, folder: str, entity, limit: int) -> None:
    if job.to == "drive":
        job.state, job.progress, job.speed = "uploading", 0.0, 0.0
        dest = safe_path(job.dest + ("/" + folder if folder else ""))
        dest.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.move, str(f), str(unique(dest / f.name)))
        return
    c = client()
    files = [f]
    if f.stat().st_size > limit:
        # Over Telegram's per-file cap: cut into 7z volumes (store only, no recompression).
        job.state, job.progress, job.speed = "splitting", 0.0, 0.0
        sub = work / ("split-" + uuid.uuid4().hex[:6])
        sub.mkdir()
        await _7z(job, ["a", "-y", "-mx0", f"-v{(limit - VOLUME_MARGIN) // MIB}m", str(sub / f"{f.name}.7z"), str(f)])
        f.unlink(missing_ok=True)
        files = sorted(sub.glob(f"{f.name}.7z.*"))
    started = time.time()
    total = sum(x.stat().st_size for x in files)
    sent = 0
    gate = GATES[job.id]
    for i, x in enumerate(files, 1):
        job.state = "sending" if len(files) == 1 else f"sending part {i}/{len(files)}"
        cap = (folder + "\n" if folder else "") + f.name
        if len(files) > 1:
            cap += f"\nPart {i}/{len(files)} — open part 1 with 7-Zip to join them"

        async def cb(done: int, _t: int, base=sent) -> None:
            job.progress = (base + done) / max(total, 1)
            job.speed = (base + done) / max(time.time() - started, 0.1)
            await gate.wait()
        await _send(c, entity, job, x, cap, cb)
        sent += x.stat().st_size
        x.unlink(missing_ok=True)


async def _run_bundle(job: Job, urls: list[str], folder: str, work: Path, gate_ok, entity, limit: int) -> None:
    """Playlist as one archive: download every video, pack them with 7z, deliver once."""
    pack = work / "pack"
    pack.mkdir()
    failed = 0
    for i, u in enumerate(urls, 1):
        await _wait_if_paused(job, "downloading")
        # Each video needs room for itself plus its share of the archive afterwards.
        if shutil.disk_usage(SCRATCH).free < 2 * 1024 ** 3:
            raise RuntimeError("Colab disk is almost full — use 'separate videos' for this playlist")
        job.state, job.progress, job.speed = f"downloading {i}/{len(urls)}", 0.0, 0.0
        t0 = time.time()

        def on_chunk(d: int, t: int) -> None:
            job.progress = d / t if t else 0.0
            job.speed = d / max(time.time() - t0, 0.1)

        item = work / f"item{i}"
        item.mkdir()
        try:
            f = await asyncio.to_thread(_ytdlp_download, job, u, item, i, len(urls), gate_ok, on_chunk)
            if job.compress:
                f = await _shrink(job, f)
            await asyncio.to_thread(shutil.move, str(f), str(unique(pack / f"{i:03d} - {f.name}")))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if job.state == "cancelled":
                raise asyncio.CancelledError()
            failed += 1
            print(f"[LINK] bundle item {i} failed: {e}", flush=True)
        finally:
            shutil.rmtree(item, ignore_errors=True)
    if failed == len(urls):
        raise RuntimeError("no item could be downloaded")
    raw = sum(x.stat().st_size for x in pack.iterdir())
    if shutil.disk_usage(SCRATCH).free < raw * 1.05:
        raise RuntimeError(f"not enough Colab space to build the archive, need ~{raw * 1.05 / 1e9:.1f} GB free")
    name = re.sub(r'[\\/:*?"<>|\r\n]+', "_", folder or "playlist").strip(" .")[:150] or "playlist"
    job.state, job.progress, job.speed = "packing archive", 0.0, 0.0
    out_dir = work / "out"
    out_dir.mkdir()
    args = ["a", "-y", "-mx9", "-mmt=on"]
    if job.to == "telegram" and raw > limit:
        args.append(f"-v{(limit - VOLUME_MARGIN) // MIB}m")
    await _7z(job, args + [str(out_dir / f"{name}.7z"), str(pack) + "/*"])
    shutil.rmtree(pack, ignore_errors=True)
    files = sorted(out_dir.glob(f"{name}.7z*"))
    job.name = files[0].name if len(files) == 1 else f"{name}.7z ({len(files)} parts)"
    job.size = sum(x.stat().st_size for x in files)
    if job.to == "drive":
        job.state, job.progress, job.speed = "uploading", 0.0, 0.0
        dest = safe_path(job.dest)
        dest.mkdir(parents=True, exist_ok=True)
        for x in files:
            await asyncio.to_thread(shutil.move, str(x), str(unique(dest / x.name)))
    else:
        c = client()
        started, sent, gate = time.time(), 0, GATES[job.id]
        for i, x in enumerate(files, 1):
            job.state = "sending" if len(files) == 1 else f"sending part {i}/{len(files)}"
            cap = f"{name} — {len(urls) - failed} videos"
            if len(files) > 1:
                cap += f"\nPart {i}/{len(files)} — download all parts, then open part 1 with 7-Zip"

            async def cb(done: int, _t: int, base=sent) -> None:
                job.progress = (base + done) / max(job.size, 1)
                job.speed = (base + done) / max(time.time() - started, 0.1)
                await gate.wait()
            await _send(c, entity, job, x, cap, cb)
            sent += x.stat().st_size
            x.unlink(missing_ok=True)
    job.state, job.progress, job.speed = "done", 1.0, 0.0
    if failed:
        job.error = f"{failed} of {len(urls)} video(s) were skipped (private or removed)"


async def _run_link(job: Job) -> None:
    await _wait_if_paused(job, "queued")
    gate = GATES[job.id]
    loop = asyncio.get_running_loop()

    def gate_ok() -> None:
        # called from download threads: block while the job is paused
        while not gate.is_set() and job.state != "cancelled":
            job.speed = 0.0
            time.sleep(0.5)

    entity, limit = None, LIMIT_NORMAL
    if job.to == "telegram":
        c = client()
        if not c.is_connected():
            await c.connect()
        try:
            entity = await _resolve_target(c, job.target)
        except Exception:
            raise RuntimeError(f"could not find the chat or user '{job.target}'")
        _, limit = await _account_limit()

    work = SCRATCH / job.id
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    try:
        job.state = "preparing"
        if job.platform == "youtube":
            folder, urls = await asyncio.to_thread(_video_items, job)
            if folder:
                job.name = folder + "/"
        else:
            folder, urls = "", [job.url]
        job.parts = len(urls)
        if job.bundle and len(urls) > 1:
            await _run_bundle(job, urls, folder, work, gate_ok, entity, limit)
            return
        failed = 0
        for i, u in enumerate(urls, 1):
            await _wait_if_paused(job, "downloading")
            step = f" {i}/{len(urls)}" if len(urls) > 1 else ""
            job.state, job.progress, job.speed = "downloading" + step, 0.0, 0.0
            t0 = time.time()

            def on_chunk(d: int, t: int) -> None:
                job.progress = d / t if t else 0.0
                job.speed = d / max(time.time() - t0, 0.1)

            item = work / f"item{i}"
            item.mkdir()
            try:
                if job.platform == "youtube":
                    f = await asyncio.to_thread(_ytdlp_download, job, u, item, i, len(urls), gate_ok, on_chunk)
                    if len(urls) == 1:
                        job.name = f.name
                else:
                    direct, _ = await asyncio.to_thread(resolve_url, u)
                    f = await asyncio.to_thread(_http_download, job, direct, item, gate_ok, on_chunk)
                if job.compress:
                    f = await _shrink(job, f)
                await _deliver(job, f, item, folder, entity, limit)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if job.state == "cancelled":
                    raise asyncio.CancelledError()
                if len(urls) == 1:
                    raise
                failed += 1  # one bad video must not stop the whole playlist
                print(f"[LINK] item {i} failed: {e}", flush=True)
            finally:
                shutil.rmtree(item, ignore_errors=True)
        if failed == len(urls):
            raise RuntimeError("no item could be downloaded")
        job.state, job.progress, job.speed = "done", 1.0, 0.0
        if failed:
            job.error = f"{failed} of {len(urls)} item(s) were skipped (private or removed)"
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(_worker())
    asyncio.create_task(_auth_watch())
