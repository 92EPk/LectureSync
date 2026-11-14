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
    od = _ms_quota()
    if od:
        out["onedrive"] = od
    return out


_MS_QUOTA = {"t": 0.0, "v": None}


def _ms_quota():
    """OneDrive free space (cached 60s so the 15s status poll stays fast)."""
    try:
        if not ms_ready():
            return None
        if time.time() - _MS_QUOTA["t"] < 60:
            return _MS_QUOTA["v"]
        q = (_g("GET", "/me/drive?$select=quota").get("quota") or {})
        v = {"total": q.get("total") or 0, "used": q.get("used") or 0, "free": q.get("remaining") or 0} if q else None
        _MS_QUOTA.update(t=time.time(), v=v)
        return v
    except Exception:
        _MS_QUOTA.update(t=time.time(), v=None)
        return None


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
    if is_ms(path):
        return ms_list(path)
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
    if is_ms(body.path):
        ms_mkdir(body.path)
        return {"ok": True}
    safe_path(body.path).mkdir(parents=True, exist_ok=False)
    return {"ok": True}


@app.post("/drive/rename", dependencies=auth)
def drive_rename(body: RenameIn):
    if "/" in body.new_name or body.new_name in ("", ".", ".."):
        raise HTTPException(status_code=400, detail="bad name")
    if is_ms(body.path):
        ms_rename(body.path, body.new_name)
        return {"ok": True}
    src = safe_path(body.path)
    src.rename(src.with_name(body.new_name))
    return {"ok": True}


@app.post("/drive/delete", dependencies=auth)
def drive_delete(body: PathIn):
    if is_ms(body.path):
        ms_delete(body.path)
        return {"ok": True}
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
    compress: bool = False


def _public(j: Job) -> dict:
    d = asdict(j)
    d["has_password"] = bool(d.pop("password"))
    return d


async def _enqueue(body: JobIn) -> Job:
    await asyncio.to_thread(_check_dest, body.dest)
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


def move_with_progress(job: "Job", src: Path, dest: Path, chunk: int = 16 * 1024 * 1024) -> None:
    """Move into the Drive FUSE mount in chunks so progress/speed stay live (shutil.move blocks silently)."""
    if src.is_dir():
        files = [f for f in src.rglob("*") if f.is_file()]
        total = sum(f.stat().st_size for f in files) or 1
        done, t0 = 0, time.time()
        dest.mkdir(parents=True, exist_ok=True)
        for f in files:
            out = dest / f.relative_to(src)
            out.parent.mkdir(parents=True, exist_ok=True)
            done = _copy_chunks(job, f, out, chunk, done, total, t0)
        shutil.rmtree(src, ignore_errors=True)
        return
    total = src.stat().st_size or 1
    _copy_chunks(job, src, dest, chunk, 0, total, time.time())
    src.unlink(missing_ok=True)


def _copy_chunks(job, src: Path, dest: Path, chunk: int, done: int, total: int, t0: float) -> int:
    with open(src, "rb") as fi, open(dest, "wb") as fo:
        while True:
            if job.state == "cancelled":
                raise RuntimeError("cancelled")
            b = fi.read(chunk)
            if not b:
                break
            fo.write(b)
            done += len(b)
            job.progress = min(done / total, 1.0)
            job.speed = done / max(time.time() - t0, 0.1)
    return done


def ensure_space(dest: Path, need: int) -> None:
    """Fail early if the target Drive can't hold the job (avoids a long download that fails at the end)."""
    try:
        free = shutil.disk_usage(dest).free
    except OSError:
        return
    if need and free < need:
        raise RuntimeError(f"Not enough space in Drive: need {need / 1024**3:.2f} GB, only {free / 1024**3:.2f} GB free")


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
    try:
        ensure_space(_dest_dir(job), total)
    except RuntimeError:
        raise
    except Exception:
        pass  # destination not resolvable yet; checked again when moving

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

        if job.compress:
            # Shrink before saving: lecture-profile ffmpeg for videos, 7z for other files.
            for f in sorted(p for p in out.rglob("*") if p.is_file()):
                await _shrink(job, f)

        job.state, job.speed = "uploading", 0.0
        dest = _dest_dir(job)
        entries = list(out.iterdir())
        for e in entries:
            await asyncio.to_thread(move_with_progress, job, e, unique(dest / e.name))
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
        runner = {"upload": _run_upload, "link": _run_link, "copy": _run_copy}.get(job.kind, _run)
        if is_ms(job.dest) and job.kind != "upload" and not (job.kind == "link" and job.to == "telegram"):
            runner = _with_ms_push(runner)
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
    if is_ms(body.path):
        name, is_dir, sizes = await asyncio.to_thread(ms_info, body.path)
        premium, limit = await _account_limit()
        size, biggest = sum(sizes), max(sizes, default=0)
        out = {"name": name, "is_dir": is_dir, "size": size, "file_count": len(sizes), "premium": premium,
               "limit": limit, **split_plan(size, limit)}
        if is_dir:
            out.update(total_size=size, batch_needs_split=biggest > limit,
                       batch_oversized=sum(1 for s in sizes if s > limit), skipped=0)
        return out
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


async def _enqueue_upload(body: UploadIn, label: str = "", ms: tuple | None = None) -> Job:
    if ms:
        name, is_dir, sizes = ms
        size = sum(sizes)
    else:
        p = safe_path(body.path)
        if not p.exists():
            raise HTTPException(status_code=404, detail="not found in Drive")
        name, is_dir = p.name, p.is_dir()
        size = sum(f.stat().st_size for f in _folder_files(p)) if is_dir else p.stat().st_size
    if is_dir and body.mode not in ("archive", "batch"):
        raise HTTPException(status_code=400, detail="bad folder mode")
    job = Job(id=uuid.uuid4().hex[:10], chat_id=0, message_id=0,
              dest=label or body.target_title or body.target, kind="upload",
              src=body.path, target=body.target.strip(), split=body.split,
              mode=body.mode if is_dir else "file",
              caption=body.caption, name=name + ("/" if is_dir else ""), size=size)
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
    if is_ms(body.path):
        info = await asyncio.to_thread(ms_info, body.path)
        if not info[2]:
            raise HTTPException(status_code=400, detail="this folder has no files")
        await _check_target(body.target.strip())
        _, limit = await _account_limit()
        sizes = info[2]
        too_big = (sum(sizes) > limit if body.mode == "archive" else max(sizes) > limit) if info[1] else sizes[0] > limit
        if too_big and not body.split:
            raise HTTPException(status_code=409, detail="larger than Telegram allows; confirm splitting it into parts")
        return _public(await _enqueue_upload(body, ms=info))
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
    from_ms = is_ms(job.src)
    src = None if from_ms else safe_path(job.src)
    if src is not None and not src.exists():
        raise RuntimeError("no longer exists in Drive")
    if src is not None and not src.is_dir() and _is_gdoc(src):
        raise RuntimeError(GDOC_MSG)
    try:
        entity = await _resolve_target(c, job.target)
    except Exception:
        raise RuntimeError(f"could not find the chat or user '{job.target}'")
    _, limit = await _account_limit()

    work = SCRATCH / job.id
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    gate = GATES[job.id]
    try:
        if from_ms:
            src = await _ms_fetch(job, job.src, work / "src")
        is_dir = src.is_dir()
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

import html
import json
import urllib.parse
import urllib.request
import threading

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
VIDEO_SITES = ("youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "loom.com",
               "facebook.com", "fb.watch", "x.com", "twitter.com", "soundcloud.com", "ted.com")
MEGA_HOSTS = ("mega.nz", "mega.co.nz", "mega.io")
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
    if any(h == s or h.endswith("." + s) for s in MEGA_HOSTS):
        return "mega"
    if any(h == s or h.endswith("." + s) for s in VIDEO_SITES):
        return "youtube"
    return "direct"


def _http_get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read(2_000_000).decode("utf-8", errors="ignore")


def _gdrive_direct(fid: str) -> str:
    """Big public files (>100 MB) return a "can't scan for viruses" page; read its form to get the real link."""
    base = f"https://drive.usercontent.google.com/download?id={fid}&export=download&confirm=t"
    try:
        req = urllib.request.Request(base, headers={"User-Agent": UA, "Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            if "text/html" not in (r.headers.get("Content-Type") or "").lower():
                return base
            page = r.read(500_000).decode("utf-8", errors="ignore")
    except Exception:
        return base
    m = re.search(r'<form[^>]+action="([^"]+)"(.*?)</form>', page, re.S)
    if not m:
        if "accounts.google.com" in page or "ServiceLogin" in page:
            raise HTTPException(status_code=400, detail="this Google Drive file isn't public — share it as 'anyone with the link'")
        if "quota" in page.lower():
            raise HTTPException(status_code=400, detail="Google Drive download limit reached for this file today — try again later")
        return base
    fields = {}
    for attrs in re.findall(r"<input([^>]*)>", m.group(2)):
        n = re.search(r'name=["\']([^"\']+)["\']', attrs)
        v = re.search(r'value=["\']([^"\']*)["\']', attrs)
        if n and v:
            fields[n.group(1)] = v.group(1)
    fields.setdefault("id", fid)
    action = urllib.parse.urljoin("https://drive.usercontent.google.com/", m.group(1).replace("&amp;", "&"))
    return action + ("&" if "?" in action else "?") + urllib.parse.urlencode(fields)


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
            raise HTTPException(status_code=400, detail="this Google Drive link has no file id")
        return _gdrive_direct(fid), platform
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


# ---- whole-folder links (Google Drive folders, Dropbox shared folders, MEGA)

def is_folder_link(url: str, platform: str) -> bool:
    u = urllib.parse.urlparse(url.strip())
    if platform == "gdrive":
        return "/folders/" in u.path or "folderview" in u.path
    if platform == "dropbox":
        return u.path.startswith(("/sh/", "/scl/fo/"))
    if platform == "mega":
        return "/folder/" in u.path or u.fragment.startswith("F!")
    return False


def _clean_part(name: str) -> str:
    """One safe path component from a remote name (no traversal, no separators)."""
    n = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", html.unescape(name or "")).strip().strip(".")
    return n[:180] or "untitled"


def _gdrive_folder_id(url: str) -> str:
    u = urllib.parse.urlparse(url)
    m = re.search(r"/folders/([\w-]{10,})", u.path)
    fid = m.group(1) if m else (urllib.parse.parse_qs(u.query).get("id") or [""])[0]
    if not fid:
        raise HTTPException(status_code=400, detail="this Google Drive folder link has no folder id")
    return fid


GDOC_EXPORT = {"document": "docx", "spreadsheets": "xlsx", "presentation": "pptx"}


def _gdrive_tree(url: str) -> tuple[str, list[tuple[str, str, str]]]:
    """Public Drive folder -> (folder name, [(file id, file name, sub-path)]) walking every sub-folder."""
    root_id = _gdrive_folder_id(url)
    out: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    root_name = ""

    def walk(fid: str, rel: str, depth: int) -> None:
        nonlocal root_name
        if fid in seen or depth > 25 or len(out) > 10000:
            return
        seen.add(fid)
        try:
            page = _http_get_text(f"https://drive.google.com/embeddedfolderview?id={fid}")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Google Drive folder could not be opened: {e}")
        if "flip-entry" not in page and ("accounts.google.com" in page or "ServiceLogin" in page):
            raise HTTPException(status_code=400, detail="this Google Drive folder isn't public — share it as 'anyone with the link'")
        if depth == 0:
            t = re.search(r"<title>(.*?)</title>", page, re.S)
            root_name = _clean_part(t.group(1) if t else "Drive folder")
        for m in re.finditer(r'<div class="flip-entry" id="entry-([\w-]+)".*?<a href="([^"]+)".*?'
                             r'<div class="flip-entry-title">(.*?)</div>', page, re.S):
            iid, href, title = m.group(1), m.group(2), _clean_part(m.group(3))
            if "/folders/" in href:
                walk(iid, f"{rel}/{title}" if rel else title, depth + 1)
            elif "docs.google.com/" in href:
                # Google Docs / Sheets / Slides have no file to download: export them as Office files.
                kind = next((k for k in GDOC_EXPORT if f"/{k}/" in href), "")
                if kind:
                    ext = GDOC_EXPORT[kind]
                    url_ = f"https://docs.google.com/{kind}/d/{iid}/export?format={ext}"
                    out.append(("url:" + url_, title if title.lower().endswith("." + ext) else f"{title}.{ext}", rel))
            else:
                out.append((iid, title, rel))

    walk(root_id, "", 0)
    if not out:
        raise HTTPException(status_code=400, detail="this Google Drive folder is empty or not shared publicly")
    return root_name, out


def _ensure_megatools() -> None:
    if shutil.which("megadl"):
        return
    subprocess.run(["apt-get", "install", "-y", "-qq", "megatools"], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not shutil.which("megadl"):
        raise RuntimeError("MEGA support could not be installed on this Colab session (megatools)")


def _tree_size(p: Path) -> int:
    try:
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    except OSError:
        return 0


async def _mega_download(job: Job, url: str, out: Path) -> None:
    await asyncio.to_thread(_ensure_megatools)
    out.mkdir(parents=True, exist_ok=True)
    proc = await asyncio.create_subprocess_exec(
        "megadl", "--no-progress", "--path", str(out), url.strip(),
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    t0 = time.time()
    try:
        while proc.returncode is None:
            if job.state == "cancelled":
                raise asyncio.CancelledError()
            try:
                await asyncio.wait_for(proc.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            got = _tree_size(out)
            job.speed = got / max(time.time() - t0, 0.1)
            if job.size:
                job.progress = min(got / job.size, 0.99)
        err = (await proc.stderr.read()).decode(errors="ignore") if proc.stderr else ""
        if proc.returncode != 0:
            low = err.lower()
            if "quota" in low or "bandwidth" in low or "509" in low:
                raise RuntimeError("MEGA transfer quota reached for this Colab session — wait a few hours or restart the cloud engine and try again")
            if "enoent" in low or "not found" in low or "-9" in low:
                raise RuntimeError("MEGA: this link was removed or is invalid")
            if "key" in low and "invalid" in low:
                raise RuntimeError("MEGA: the link is missing its decryption key (the part after #)")
            raise RuntimeError("MEGA: " + (err.strip().splitlines() or ["download failed (link removed or quota reached)"])[-1][-200:])
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass


async def _run_tree(job: Job, work: Path, gate_ok, entity, limit: int) -> None:
    """Folder links and MEGA: pull the whole tree and recreate it at the destination."""
    loop_files: list[tuple[Path, str]] = []
    if job.platform == "gdrive":
        root, items = await asyncio.to_thread(_gdrive_tree, job.url)
        job.parts, failed = len(items), 0
        for i, (fid, fname, rel) in enumerate(items, 1):
            await _wait_if_paused(job, "downloading")
            job.state, job.progress, job.speed = f"downloading {i}/{len(items)}", 0.0, 0.0
            t0 = time.time()

            def on_chunk(d: int, t: int, t0=t0) -> None:
                job.progress = d / t if t else 0.0
                job.speed = d / max(time.time() - t0, 0.1)
            item = work / f"item{i}"
            item.mkdir()
            try:
                direct = fid[4:] if fid.startswith("url:") else await asyncio.to_thread(_gdrive_direct, fid)
                f = await asyncio.to_thread(_http_download, job, direct, item, gate_ok, on_chunk)
                if f.name != fname and fname:
                    f = f.rename(f.with_name(fname))
                if job.compress:
                    f = await _shrink(job, f)
                await _deliver(job, f, item, f"{root}/{rel}" if rel else root, entity, limit)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if job.state == "cancelled":
                    raise asyncio.CancelledError()
                failed += 1
                print(f"[FOLDER] {fname} failed: {e}", flush=True)
            finally:
                shutil.rmtree(item, ignore_errors=True)
        job.name = root + "/"
        if failed == len(items):
            raise RuntimeError("no file of this folder could be downloaded")
        job.state, job.progress, job.speed = "done", 1.0, 0.0
        if failed:
            job.error = f"{failed} of {len(items)} file(s) were skipped (private, removed or download limit)"
        return

    tree = work / "tree"
    if job.platform == "dropbox":
        job.state = "downloading"
        t0 = time.time()

        def on_chunk(d: int, t: int) -> None:
            job.progress = d / t if t else 0.0
            job.speed = d / max(time.time() - t0, 0.1)
        direct, _ = await asyncio.to_thread(resolve_url, job.url)
        z = await asyncio.to_thread(_http_download, job, direct, work, gate_ok, on_chunk)
        root = _clean_part(re.sub(r"\.zip$", "", z.name, flags=re.I))
        job.state, job.progress, job.speed = "extracting", 0.0, 0.0
        await _7z(job, ["x", "-y", f"-o{tree / root}", str(z)])
        z.unlink(missing_ok=True)
    else:  # mega: file or folder
        job.state, job.progress, job.speed = "downloading", 0.0, 0.0
        await _mega_download(job, job.url, tree)
    for f in sorted(tree.rglob("*")):
        if f.is_file():
            rel = f.parent.relative_to(tree).as_posix()
            loop_files.append((f, "" if rel == "." else "/".join(_clean_part(x) for x in rel.split("/"))))
    if not loop_files:
        raise RuntimeError("the folder is empty")
    tops = {f.relative_to(tree).parts[0] for f, _ in loop_files}
    job.parts = len(loop_files)
    for i, (f, sub) in enumerate(loop_files, 1):
        await _wait_if_paused(job, "uploading")
        if job.compress:
            f = await _shrink(job, f)
        await _deliver(job, f, f.parent, sub, entity, limit)
    job.name = (next(iter(tops)) + "/") if len(tops) == 1 and len(loop_files) > 1 else loop_files[0][0].name
    job.state, job.progress, job.speed = "done", 1.0, 0.0


def _ydl(opts: dict | None = None):
    try:
        import yt_dlp
    except ImportError:
        subprocess.run([os.sys.executable, "-m", "pip", "-q", "install", "yt-dlp"], check=True)
        import yt_dlp
    base = {"quiet": True, "no_warnings": True, "noprogress": True,
            "http_headers": {"User-Agent": UA}, "retries": 5, "fragment_retries": 5}
    return yt_dlp.YoutubeDL({**base, **(opts or {})})


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
           "title": "", "count": 1, "size": 0, "folder": False}
    if platform == "gdrive" and is_folder_link(url, platform):
        root, items = await asyncio.to_thread(_gdrive_tree, url)
        out.update(title=root, folder=True, count=len(items))
        return out
    if platform == "mega":
        out.update(title="MEGA folder" if is_folder_link(url, platform) else "MEGA file",
                   folder=is_folder_link(url, platform), count=0)
        return out
    if platform == "dropbox" and is_folder_link(url, platform):
        # Shared folders answer HEAD with an HTML page; the dl=1 zip is fetched later by _run_tree.
        m = re.search(r"/(?:sh|scl/fo)/[^/]+/(?:[^/]+/)?([^/?#]+)", urllib.parse.urlparse(url).path)
        name = urllib.parse.unquote(m.group(1)) if m and not re.fullmatch(r"[\w-]{10,}", m.group(1)) else "Dropbox folder"
        out.update(title=_clean_part(name), folder=True, count=0)
        return out
    if platform == "youtube":
        try:
            info = await asyncio.to_thread(
                lambda: _ydl({"extract_flat": "in_playlist", "skip_download": True}).extract_info(url, download=False))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"video not available: {str(e)[-200:]}")
        entries = [e for e in (info.get("entries") or []) if e]
        out.update(title=info.get("title") or "", playlist=bool(entries), count=len(entries) or 1)
        return out
    if platform == "sharepoint" and ms_ready():
        try:
            it = await asyncio.to_thread(_ms_share, url)
            out.update(title=it.get("name") or "", size=int(it.get("size") or 0), folder="folder" in it,
                       count=(it.get("folder") or {}).get("childCount", 1) if "folder" in it else 1, signed_in=True)
            return out
        except Exception:
            pass  # not reachable with this account: try it as a public link
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
    if platform == "dropbox" and is_folder_link(url, platform):
        out.update(title=re.sub(r"\.zip$", "", name, flags=re.I), folder=True, count=0)
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
        await asyncio.to_thread(_check_dest, body.dest)
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


_NVENC: bool | None = None


def _video_codec() -> list[str]:
    """Use Colab's GPU encoder when the user picked a GPU runtime; otherwise the fastest CPU profile."""
    global _NVENC
    if _NVENC is None:
        try:
            r = subprocess.run(["ffmpeg", "-hide_banner", "-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1",
                                "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True, timeout=20)
            _NVENC = r.returncode == 0
        except Exception:
            _NVENC = False
    if _NVENC:
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "30", "-b:v", "0"]
    # HandBrake-style lecture profile: full resolution, CRF 28 keeps slide text sharp at a much smaller size.
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"]


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
    youtube = job.platform == "youtube"
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
        "-map", "0:v:0", "-map", "0:a?",
        *_video_codec(), "-threads", "0", "-pix_fmt", "yuv420p",
        # Keep the original resolution; only YouTube jobs (where the user picked a quality) get a size cap.
        *(["-vf", f"scale='min({MAX_W.get(job.quality, 1920)},iw)':-2"] if youtube else []),
        # Direct links: copy the original audio untouched (no quality loss, no size bloat).
        *(["-c:a", "aac", "-b:a", "128k"] if youtube else ["-c:a", "copy"]),
        "-movflags", "+faststart", "-progress", "pipe:1", str(out),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
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
        dest = _dest_dir(job, folder)
        await asyncio.to_thread(move_with_progress, job, f, unique(dest / f.name))
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
        dest = _dest_dir(job)
        for x in files:
            await asyncio.to_thread(move_with_progress, job, x, unique(dest / x.name))
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
        if job.platform == "mega" or is_folder_link(job.url, job.platform):
            await _run_tree(job, work, gate_ok, entity, limit)
            return
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
                elif job.platform == "sharepoint" and ms_ready() and await _ms_link(job, u, item, entity, limit):
                    continue  # whole share (file or folder tree) already delivered
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


# ---------------------------------------------------------------- Microsoft OneDrive / SharePoint
# Microsoft Graph over plain HTTPS (no extra packages). Sign-in uses the OAuth device-code flow:
# the user types a short code at microsoft.com/devicelogin, so no password ever reaches this worker.
# Locations are written "ms:<drive id>/<folder path>"; "ms:" alone lists the user's libraries.
import base64
from datetime import datetime

# Built-in public client ID so students can sign in with school accounts without registering an app
# (their university usually blocks app registration). Settings can override it with a custom ID.
MS_DEFAULT_CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c"
MS_CLIENT_ID = os.environ.get("LS_MS_CLIENT_ID", "").strip() or MS_DEFAULT_CLIENT_ID
MS_TENANT = "common"  # a custom single-tenant app needs its own tenant (e.g. "must.edu.eg")
MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0"
# Built-in app keeps SharePoint access; a custom app asks only for the user's own files,
# which students may grant without admin approval.
MS_SCOPES_FULL = "offline_access User.Read Files.ReadWrite.All Sites.Read.All"
MS_SCOPES_LIGHT = "offline_access User.Read Files.ReadWrite"
MS_SCOPES = MS_SCOPES_FULL
GRAPH = "https://graph.microsoft.com/v1.0"
MS_CHUNK = 320 * 1024 * 32       # 10 MiB; upload sessions need multiples of 320 KiB
MS_SMALL = 4 * MIB               # below this a single PUT is enough
MS: dict = {"access": "", "refresh": "", "exp": 0.0, "user": "", "flow": None, "roots": None, "labels": {}}


class MsError(RuntimeError):
    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code = code


def is_ms(path: str | None) -> bool:
    return bool(path) and path.startswith("ms:")


def ms_ready() -> bool:
    return bool(MS["refresh"] or MS["access"])


def _form_post(url: str, data: dict) -> dict:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"error": f"http {e.code}"}


def _ms_store(r: dict) -> None:
    MS["access"] = r["access_token"]
    MS["refresh"] = r.get("refresh_token") or MS["refresh"]
    MS["exp"] = time.time() + int(r.get("expires_in") or 3600)


def _ms_token() -> str:
    if not ms_ready():
        raise MsError(428, "Microsoft account not connected — press 'Connect Microsoft' first")
    if time.time() > MS["exp"] - 120:
        if not MS["refresh"]:
            # Signed in from the PC's browser: the desktop app refreshes and hands over new tokens.
            if time.time() < MS["exp"]:
                return MS["access"]
            raise MsError(428, "Microsoft sign-in expired — keep the LectureSync app open or sign in again")
        r = _form_post(f"{MS_AUTH}/token", {"client_id": MS_CLIENT_ID, "grant_type": "refresh_token",
                                             "refresh_token": MS["refresh"], "scope": MS_SCOPES})
        if "access_token" not in r:
            MS.update(access="", refresh="")
            raise MsError(428, "Microsoft sign-in expired — connect your Microsoft account again")
        _ms_store(r)
    return MS["access"]


def _g(method: str, path: str, body=None, data: bytes | None = None, headers: dict | None = None,
       signed: bool = True) -> dict:
    """One Graph call with retries on throttling / transient errors."""
    url = path if path.startswith("http") else GRAPH + path
    for attempt in range(5):
        h = {"Authorization": f"Bearer {_ms_token()}"} if signed else {}
        h.update(headers or {})
        payload = data
        if body is not None:
            payload = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=payload, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 4:
                time.sleep(int(e.headers.get("Retry-After") or 0) or 2 ** attempt)
                continue
            if e.code == 401 and signed and attempt == 0:
                MS["exp"] = 0  # token revoked or expired early: refresh once
                continue
            try:
                msg = (json.loads(e.read()).get("error") or {}).get("message") or ""
            except Exception:
                msg = ""
            if e.code == 404:
                msg = "not found in OneDrive/SharePoint"
            elif e.code == 403:
                msg = "forbidden — your Microsoft account has no access here"
            raise MsError(e.code, f"Microsoft: {msg or 'HTTP ' + str(e.code)}")
        except urllib.error.URLError:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)
    raise MsError(503, "Microsoft is not answering, try again")


def _ms_http(e: Exception) -> HTTPException:
    return HTTPException(status_code=getattr(e, "code", 400) if isinstance(e, MsError) else 400, detail=str(e))


def _ms_split(path: str) -> tuple[str, str]:
    d, _, rel = path[3:].strip("/").partition("/")
    return d, rel.strip("/")


def _ms_item(d: str, rel: str) -> str:
    return f"/drives/{d}/root" + (f":/{urllib.parse.quote(rel)}:" if rel else "")


def _ms_label(d: str) -> str:
    if d not in MS["labels"]:
        try:
            MS["labels"][d] = _g("GET", f"/drives/{d}?$select=name").get("name") or "Library"
        except MsError:
            MS["labels"][d] = "Library"
    return MS["labels"][d]


def _ms_roots() -> list[dict]:
    """My OneDrive plus every SharePoint document library the user can reach."""
    if MS["roots"] is None:
        roots = []
        me = _g("GET", "/me/drive?$select=id,name")
        MS["labels"][me["id"]] = "My OneDrive"
        roots.append({"name": "My OneDrive", "id": me["id"]})
        try:
            sites = _g("GET", "/sites?search=*&$top=40&$select=id,displayName,name").get("value", [])
        except MsError:
            sites = []  # personal Microsoft accounts have no SharePoint
        for s in sites:
            try:
                drives = _g("GET", f"/sites/{s['id']}/drives?$select=id,name").get("value", [])
            except MsError:
                continue
            for dr in drives:
                label = f"{s.get('displayName') or s.get('name') or 'Site'} — {dr.get('name') or 'Documents'}"
                MS["labels"][dr["id"]] = label
                roots.append({"name": label, "id": dr["id"]})
        MS["roots"] = roots
    return MS["roots"]


def _ms_ts(s: str | None) -> float:
    try:
        return datetime.fromisoformat((s or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def ms_list(path: str) -> dict:
    try:
        d, rel = _ms_split(path)
        if not d:
            items = [{"name": r["name"], "dir": True, "size": 0, "modified": 0, "path": f"ms:{r['id']}", "library": True}
                     for r in _ms_roots()]
            return {"path": "ms:", "items": items, "mounted": True, "provider": "ms", "label": "", "user": MS["user"]}
        items, url = [], _ms_item(d, rel) + "/children?$top=999&$select=name,size,folder,file,lastModifiedDateTime"
        while url:
            r = _g("GET", url)
            for c in r.get("value", []):
                if "folder" not in c and "file" not in c:
                    continue  # OneNote notebooks and other non-file items
                items.append({"name": c["name"], "dir": "folder" in c, "size": 0 if "folder" in c else c.get("size", 0),
                              "modified": _ms_ts(c.get("lastModifiedDateTime"))})
            url = r.get("@odata.nextLink")
    except MsError as e:
        raise _ms_http(e)
    items.sort(key=lambda x: (not x["dir"], x["name"].lower()))
    return {"path": f"ms:{d}" + (f"/{rel}" if rel else ""), "items": items, "mounted": True,
            "provider": "ms", "label": _ms_label(d), "user": MS["user"]}


def _ms_need_folder(path: str) -> tuple[str, str]:
    d, rel = _ms_split(path)
    if not d:
        raise HTTPException(status_code=400, detail="open My OneDrive or a SharePoint library first")
    return d, rel


def ms_mkdir(path: str) -> None:
    d, rel = _ms_need_folder(path)
    parent, _, name = rel.rpartition("/")
    if not name:
        raise HTTPException(status_code=400, detail="bad name")
    try:
        _g("POST", _ms_item(d, parent) + "/children",
           body={"name": name, "folder": {}, "@microsoft.graph.conflictBehavior": "fail"})
    except MsError as e:
        raise _ms_http(e)


def _ms_mkdirs(d: str, rel: str) -> None:
    """Create every folder of rel (inside drive d) that does not exist yet."""
    parts = [p for p in rel.split("/") if p]
    for i in range(len(parts)):
        try:
            _g("POST", _ms_item(d, "/".join(parts[:i])) + "/children",
               body={"name": parts[i], "folder": {}, "@microsoft.graph.conflictBehavior": "fail"})
        except MsError as e:
            if e.code != 409:  # 409 = already there
                raise


def ms_rename(path: str, new_name: str) -> None:
    d, rel = _ms_need_folder(path)
    if not rel:
        raise HTTPException(status_code=400, detail="libraries can't be renamed here")
    try:
        _g("PATCH", _ms_item(d, rel), body={"name": new_name})
    except MsError as e:
        raise _ms_http(e)


def ms_delete(path: str) -> None:
    d, rel = _ms_need_folder(path)
    if not rel:
        raise HTTPException(status_code=400, detail="refusing to delete a whole library")
    try:
        _g("DELETE", _ms_item(d, rel))  # goes to the OneDrive / SharePoint recycle bin
    except MsError as e:
        raise _ms_http(e)


def _ms_tree(d: str, item: dict, prefix: str) -> list[tuple[str, int, str, str]]:
    """Every file under item as (relative path, size, drive id, item id)."""
    if "file" in item:
        return [(prefix, int(item.get("size") or 0), d, item["id"])]
    if "folder" not in item:
        return []
    out, url = [], f"/drives/{d}/items/{item['id']}/children?$top=999"
    while url:
        r = _g("GET", url)
        for c in r.get("value", []):
            cd = (c.get("parentReference") or {}).get("driveId") or d
            out += _ms_tree(cd, c, f"{prefix}/{c['name']}" if prefix else c["name"])
        url = r.get("@odata.nextLink")
    return out


def _ms_get(path: str) -> tuple[str, dict]:
    d, rel = _ms_need_folder(path)
    return d, _g("GET", _ms_item(d, rel))


def ms_info(path: str) -> tuple[str, bool, list[int]]:
    """(name, is folder, size of every file inside) for the size checks before sending."""
    try:
        d, item = _ms_get(path)
        files = _ms_tree(d, item, item["name"])
    except MsError as e:
        raise _ms_http(e)
    return item["name"], "folder" in item, [s for _, s, _, _ in files]


def _ms_share(url: str) -> dict:
    """A OneDrive / SharePoint sharing link -> its driveItem (works for files and whole folders)."""
    token = "u!" + base64.urlsafe_b64encode(url.strip().encode()).decode().rstrip("=")
    return _g("GET", f"/shares/{token}/driveItem")


def _gate_blocker(job: Job):
    gate = GATES[job.id]

    def gate_ok() -> None:
        while not gate.is_set() and job.state != "cancelled":
            job.speed = 0.0
            time.sleep(0.5)
        if job.state == "cancelled":
            raise RuntimeError("cancelled")
    return gate_ok


async def _ms_fetch_item(job: Job, d: str, item: dict, into: Path) -> Path:
    """Download a file or a whole folder tree from Microsoft onto Colab's disk; returns its local path."""
    files = await asyncio.to_thread(_ms_tree, d, item, item["name"])
    if not files and "folder" not in item:
        raise RuntimeError("this item can't be downloaded (OneNote notebook or shortcut?)")
    total = sum(s for _, s, _, _ in files)
    if shutil.disk_usage(SCRATCH).free < total * 1.1:
        raise RuntimeError(f"not enough Colab space, need ~{total * 1.1 / 1e9:.1f} GB")
    into.mkdir(parents=True, exist_ok=True)
    name, gate_ok = item["name"], _gate_blocker(job)
    job.name, job.size = name + ("/" if "folder" in item else ""), total
    done, t0 = 0, time.time()
    for i, (rel, size, fd, iid) in enumerate(files, 1):
        await _wait_if_paused(job, "downloading")
        job.state = "downloading" + (f" {i}/{len(files)}" if len(files) > 1 else "")
        target = into / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if size == 0:
            target.touch()
            continue
        meta = await asyncio.to_thread(_g, "GET", f"/drives/{fd}/items/{iid}")
        link = meta.get("@microsoft.graph.downloadUrl")
        if not link:
            raise RuntimeError(f"'{rel}' can't be downloaded (blocked by the owner?)")
        tmp = into / f".part-{i}"
        tmp.mkdir()

        def on_chunk(n: int, _t: int, base=done) -> None:
            job.progress = (base + n) / max(total, 1)
            job.speed = (base + n) / max(time.time() - t0, 0.1)
        f = await asyncio.to_thread(_http_download, job, link, tmp, gate_ok, on_chunk)
        shutil.move(str(f), str(target))
        shutil.rmtree(tmp, ignore_errors=True)
        done += size
    job.name, job.size = name + ("/" if "folder" in item else ""), total
    out = into / name
    out.mkdir(exist_ok=True) if "folder" in item and not out.exists() else None
    return out


async def _ms_fetch(job: Job, path: str, into: Path) -> Path:
    try:
        d, item = await asyncio.to_thread(_ms_get, path)
    except HTTPException as e:
        raise RuntimeError(e.detail)
    return await _ms_fetch_item(job, d, item, into)


def _ms_upload_file(job: Job, f: Path, d: str, rel_parent: str, prog, gate_ok) -> None:
    rel = f"{rel_parent}/{f.name}" if rel_parent else f.name
    size = f.stat().st_size
    if size <= MS_SMALL:
        _g("PUT", _ms_item(d, rel) + "/content?@microsoft.graph.conflictBehavior=rename",
           data=f.read_bytes(), headers={"Content-Type": "application/octet-stream"})
        prog(size)
        return
    sess = _g("POST", _ms_item(d, rel) + "/createUploadSession",
              body={"item": {"@microsoft.graph.conflictBehavior": "rename"}})
    up, pos, sent, fails = sess["uploadUrl"], 0, 0, 0
    with open(f, "rb") as fh:
        while pos < size:
            gate_ok()
            fh.seek(pos)
            chunk = fh.read(MS_CHUNK)
            end = pos + len(chunk) - 1
            try:
                _g("PUT", up, data=chunk, signed=False,
                   headers={"Content-Range": f"bytes {pos}-{end}/{size}", "Content-Length": str(len(chunk))})
                pos, fails = end + 1, 0
            except MsError as e:
                if e.code in (404, 410):
                    # Upload sessions expire (~15 min idle / lifetime): open a fresh one and resume.
                    sess = _g("POST", _ms_item(d, rel) + "/createUploadSession",
                              body={"item": {"@microsoft.graph.conflictBehavior": "rename"}})
                    up = sess["uploadUrl"]
                    nxt = sess.get("nextExpectedRanges") or []
                    pos = int(nxt[0].split("-")[0]) if nxt else 0
                    fails += 1
                    if fails > 5:
                        raise
                    continue
                fails += 1
                if fails > 5:
                    raise
                time.sleep(2 * fails)
            except (urllib.error.URLError, TimeoutError):
                fails += 1
                if fails > 5:
                    raise
                time.sleep(2 * fails)
                # Ask the session where it stopped and carry on from there.
                nxt = (_g("GET", up, signed=False).get("nextExpectedRanges") or ["0-"])[0]
                pos = int(nxt.split("-")[0])
            prog(pos - sent)
            sent = pos


async def _ms_push(job: Job, entries: list[Path]) -> None:
    """Upload local files/folders into the job's Microsoft destination, keeping the folder tree."""
    d, base = _ms_split(job.dest)
    files: list[tuple[Path, str]] = []
    for e in entries:
        if e.is_dir():
            files += [(f, f.parent.relative_to(e.parent).as_posix()) for f in sorted(e.rglob("*")) if _readable(f)]
        elif _readable(e):
            files.append((e, ""))
    if not files:
        return
    total = sum(f.stat().st_size for f, _ in files)
    sent, t0, gate_ok, made = 0, time.time(), _gate_blocker(job), set()
    job.progress, job.speed = 0.0, 0.0

    def prog(n: int) -> None:
        nonlocal sent
        sent += n
        job.progress = sent / max(total, 1)
        job.speed = sent / max(time.time() - t0, 0.1)
    for i, (f, sub) in enumerate(files, 1):
        await _wait_if_paused(job, "uploading")
        job.state = "uploading to Microsoft" + (f" {i}/{len(files)}" if len(files) > 1 else "")
        parent = "/".join(x for x in (base, sub) if x)
        if sub and parent not in made:
            await asyncio.to_thread(_ms_mkdirs, d, parent)
            made.add(parent)
        await asyncio.to_thread(_ms_upload_file, job, f, d, parent, prog, gate_ok)


def _ms_staging(job: Job) -> Path:
    return SCRATCH / f"ms-{job.id}"


def _dest_dir(job: Job, sub: str = "") -> Path:
    """Local folder a pipeline drops its results into: Drive itself, or a staging area for Microsoft."""
    if is_ms(job.dest):
        p = _ms_staging(job) / sub if sub else _ms_staging(job)
    else:
        p = safe_path(job.dest + ("/" + sub if sub else ""))
    p.mkdir(parents=True, exist_ok=True)
    return p


def _with_ms_push(runner):
    """Run a normal pipeline into the staging folder, then upload the result to OneDrive/SharePoint."""
    async def run(job: Job) -> None:
        st = _ms_staging(job)
        shutil.rmtree(st, ignore_errors=True)
        try:
            await runner(job)
            if st.exists():
                await _ms_push(job, sorted(st.iterdir()))
            job.state, job.progress, job.speed = "done", 1.0, 0.0
        finally:
            shutil.rmtree(st, ignore_errors=True)
    return run


def _check_dest(dest: str) -> None:
    if is_ms(dest):
        d, rel = _ms_split(dest)
        if not d:
            raise HTTPException(status_code=400, detail="open My OneDrive or a SharePoint library first")
        try:
            item = _g("GET", _ms_item(d, rel) + "?$select=folder")
        except MsError as e:
            raise _ms_http(e)
        if "folder" not in item:
            raise HTTPException(status_code=400, detail="not a folder")
    else:
        safe_path(dest).mkdir(parents=True, exist_ok=True)


# ---- sign-in

async def _ms_poll(flow: dict) -> None:
    while time.time() < flow["expires"] and MS["flow"] is flow:
        await asyncio.sleep(flow["interval"])
        r = await asyncio.to_thread(_form_post, f"{MS_AUTH}/token", {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "client_id": MS_CLIENT_ID, "device_code": flow["device_code"]})
        if "access_token" in r:
            _ms_store(r)
            MS["roots"], MS["labels"] = None, {}
            try:
                me = await asyncio.to_thread(_g, "GET", "/me?$select=displayName,mail,userPrincipalName")
                MS["user"] = me.get("mail") or me.get("userPrincipalName") or me.get("displayName") or ""
            except Exception:
                MS["user"] = ""
            flow["state"] = "connected"
            return
        err = r.get("error")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            flow["interval"] += 5
            continue
        flow["state"] = "error"
        flow["error"] = (r.get("error_description") or err or "sign-in failed").split("\r\n")[0]
        return
    if flow["state"] == "pending":
        flow["state"], flow["error"] = "error", "the code expired — start again"


@app.get("/ms/status", dependencies=auth)
def ms_status():
    f = MS["flow"]
    return {"configured": bool(MS_CLIENT_ID), "connected": ms_ready(), "user": MS["user"],
            "flow": {"state": f["state"], "error": f.get("error", "")} if f else None}


@app.post("/ms/auth/start", dependencies=auth)
async def ms_auth_start():
    if not MS_CLIENT_ID:
        raise HTTPException(status_code=428, detail="Microsoft sign-in is not set up in this engine yet (missing app ID)")
    r = await asyncio.to_thread(_form_post, f"{MS_AUTH}/devicecode", {"client_id": MS_CLIENT_ID, "scope": MS_SCOPES})
    if "device_code" not in r:
        raise HTTPException(status_code=400, detail=(r.get("error_description") or r.get("error") or "Microsoft refused").split("\r\n")[0])
    flow = {"device_code": r["device_code"], "interval": int(r.get("interval") or 5),
            "expires": time.time() + int(r.get("expires_in") or 900), "state": "pending"}
    MS["flow"] = flow
    asyncio.create_task(_ms_poll(flow))
    return {"user_code": r["user_code"], "verification_uri": r.get("verification_uri") or "https://microsoft.com/devicelogin",
            "expires_in": int(r.get("expires_in") or 900)}


class MsConfigIn(BaseModel):
    client_id: str
    tenant: str = ""
    personal: bool = False  # Outlook/Hotmail: no SharePoint, so no Sites.Read.All


@app.post("/ms/configure", dependencies=auth)
def ms_configure(body: MsConfigIn):
    """The desktop app hands over the Microsoft app ID (kept on the PC), like the Telegram keys."""
    global MS_CLIENT_ID, MS_TENANT, MS_AUTH, MS_SCOPES
    cid = body.client_id.strip() or MS_DEFAULT_CLIENT_ID
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", cid):
        raise HTTPException(status_code=400, detail="the Microsoft app ID looks like 00000000-0000-0000-0000-000000000000")
    tenant = body.tenant.strip().lower() or "common"
    if not re.fullmatch(r"[a-z0-9.-]{1,100}", tenant):
        raise HTTPException(status_code=400, detail="the organization looks like university.edu or a tenant ID")
    scopes = MS_SCOPES_LIGHT if (body.personal or cid != MS_DEFAULT_CLIENT_ID) else MS_SCOPES_FULL
    if cid != MS_CLIENT_ID or tenant != MS_TENANT or scopes != MS_SCOPES:
        MS.update(access="", refresh="", exp=0.0, user="", flow=None, roots=None, labels={})
    MS_CLIENT_ID, MS_TENANT = cid, tenant
    MS_AUTH = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0"
    MS_SCOPES = scopes
    return {"ok": True}


class MsTokenIn(BaseModel):
    access_token: str
    expires_in: int = 3600
    user: str = ""


@app.post("/ms/token", dependencies=auth)
def ms_token_in(body: MsTokenIn):
    """Token from a sign-in done in the PC's own browser (passes university IP/device rules)."""
    first = not MS["access"]
    MS.update(access=body.access_token.strip(), refresh="", exp=time.time() + max(60, body.expires_in), flow=None)
    if body.user:
        MS["user"] = body.user
    if first:
        MS["roots"], MS["labels"] = None, {}
    return {"ok": True}


@app.post("/ms/logout", dependencies=auth)
def ms_logout():
    MS.update(access="", refresh="", exp=0.0, user="", flow=None, roots=None, labels={})
    return {"ok": True}


async def _ms_link(job: Job, url: str, work: Path, entity, limit: int) -> bool:
    """Fetch a OneDrive/SharePoint sharing link with the signed-in account. False = fall back to public download."""
    try:
        it = await asyncio.to_thread(_ms_share, url)
    except Exception:
        return False
    d = (it.get("parentReference") or {}).get("driveId")
    if not d:
        return False
    local = await _ms_fetch_item(job, d, it, work / "ms")
    files = [(f, f.parent.relative_to(local.parent).as_posix()) for f in sorted(local.rglob("*")) if f.is_file()] \
        if local.is_dir() else [(local, "")]
    for f, sub in files:
        await _wait_if_paused(job, "downloading")
        if job.compress:
            f = await _shrink(job, f)
        await _deliver(job, f, f.parent, sub, entity, limit)
    return True


# ---- cloud <-> cloud copies (Google Drive <-> OneDrive/SharePoint)

class CopyIn(BaseModel):
    src: str
    dest: str


@app.post("/copies", dependencies=auth)
async def create_copy(body: CopyIn):
    if is_ms(body.src) == is_ms(body.dest) and not is_ms(body.src):
        raise HTTPException(status_code=400, detail="pick a OneDrive/SharePoint folder on one side")
    if is_ms(body.src):
        name, is_dir, sizes = await asyncio.to_thread(ms_info, body.src)
    else:
        p = safe_path(body.src)
        if not p.exists():
            raise HTTPException(status_code=404, detail="not found in Drive")
        name, is_dir = p.name, p.is_dir()
        sizes = [f.stat().st_size for f in _folder_files(p)] if is_dir else [p.stat().st_size]
    await asyncio.to_thread(_check_dest, body.dest)
    job = Job(id=uuid.uuid4().hex[:10], chat_id=0, message_id=0, dest=body.dest, kind="copy",
              src=body.src, name=name + ("/" if is_dir else ""), size=sum(sizes))
    gate = asyncio.Event()
    gate.set()
    GATES[job.id] = gate
    JOBS[job.id] = job
    await _queue.put(job.id)
    return _public(job)


async def _run_copy(job: Job) -> None:
    await _wait_if_paused(job, "queued")
    work = SCRATCH / job.id
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    try:
        if is_ms(job.src):
            local = await _ms_fetch(job, job.src, work / "src")
        else:
            local = safe_path(job.src)
            if not local.exists():
                raise RuntimeError("no longer exists in Drive")
        if is_ms(job.dest) and not is_ms(job.src):
            await _ms_push(job, [local])          # straight from the mounted Drive, no extra copy
        else:
            job.state, job.progress, job.speed = "copying", 0.0, 0.0
            await asyncio.to_thread(move_with_progress, job, local, unique(_dest_dir(job) / local.name))
        job.state, job.progress, job.speed = "done", 1.0, 0.0
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(_worker())
    asyncio.create_task(_auth_watch())
