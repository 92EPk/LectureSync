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
from telethon import TelegramClient
from telethon.errors import FloodWaitError, SessionPasswordNeededError

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
async def health():
    authorized = tg is not None and await tg.is_user_authorized()
    return {"ok": True, "telegram_ready": tg is not None, "telegram": authorized}


@app.get("/disk", dependencies=auth)
def disk():
    u = shutil.disk_usage(SCRATCH)
    return {"total": u.total, "used": u.used, "free": u.free}


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
    global tg, _tg_key
    key = (body.api_id, body.api_hash)
    if tg is not None and _tg_key == key:
        return {"ok": True, "telegram": await tg.is_user_authorized()}
    if tg is not None:
        await tg.disconnect()
    # One session file per api_id, so two people sharing a Drive never collide.
    tg = TelegramClient(str(STATE_DIR / f"telegram-{body.api_id}"), body.api_id, body.api_hash)
    await tg.connect()
    _tg_key = key
    return {"ok": True, "telegram": await tg.is_user_authorized()}


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
    if await c.is_user_authorized():
        return {"state": "done"}
    login = await c.qr_login()
    _qr.update(login=login, state="waiting", error=None)
    asyncio.create_task(_qr_wait(login))
    return {"state": "waiting", "svg": _qr_svg(login.url), "expires": login.expires.timestamp()}


@app.get("/telegram/qr/status", dependencies=auth)
async def qr_status():
    return {"state": _qr["state"], "error": _qr["error"]}


class PasswordIn(BaseModel):
    password: str


@app.post("/telegram/qr/password", dependencies=auth)
async def qr_password(body: PasswordIn):
    await client().sign_in(password=body.password)
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
            })
    return out


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
    state: str = "queued"      # queued -> downloading -> extracting -> uploading -> done | failed
    progress: float = 0.0
    speed: float = 0.0
    error: str | None = None
    created: float = field(default_factory=time.time)


JOBS: dict[str, Job] = {}
# One job at a time: Colab's disk is the bottleneck, and Telegram gets
# grumpy (FloodWait) when several big downloads run from one account.
_queue: asyncio.Queue[str] = asyncio.Queue()


class JobIn(BaseModel):
    chat_id: int
    message_id: int
    dest: str


@app.post("/jobs", dependencies=auth)
async def create_job(body: JobIn):
    safe_path(body.dest).mkdir(parents=True, exist_ok=True)
    job = Job(id=uuid.uuid4().hex[:10], **body.model_dump())
    JOBS[job.id] = job
    await _queue.put(job.id)
    return asdict(job)


@app.get("/jobs", dependencies=auth)
def list_jobs():
    return [asdict(j) for j in sorted(JOBS.values(), key=lambda j: -j.created)]


# Telethon pulls a file over one request at a time, which Telegram caps at ~1-1.5 MB/s.
# Splitting the file into ranges and fetching them concurrently (512 KB requests, the
# API maximum) multiplies throughput on Colab's fast link.
PART = 512 * 1024
WORKERS = int(os.environ.get("LS_DL_WORKERS", "8"))


async def fast_download(cl, msg, work: Path, on_chunk) -> Path:
    total = msg.file.size
    name = msg.file.name or f"message-{msg.id}{msg.file.ext or ''}"
    target = work / os.path.basename(name)
    if total < 8 * PART:
        return Path(await cl.download_media(msg, file=str(target), progress_callback=on_chunk))
    parts = (total + PART - 1) // PART
    per = (parts + WORKERS - 1) // WORKERS
    done = 0
    with open(target, "wb") as fh:
        fh.truncate(total)

    async def seg(first: int, count: int) -> None:
        nonlocal done
        pos = first * PART
        with open(target, "r+b") as f:
            async for chunk in cl.iter_download(msg.media, offset=pos, limit=count,
                                                request_size=PART, chunk_size=PART, file_size=total):
                f.seek(pos)
                f.write(chunk)
                pos += len(chunk)
                done += len(chunk)
                on_chunk(done, total)

    try:
        await asyncio.gather(*(seg(i * per, min(per, parts - i * per))
                               for i in range(WORKERS) if i * per < parts))
    except FloodWaitError:
        raise
    except Exception:
        # Anything unexpected: fall back to the plain single-stream download.
        target.unlink(missing_ok=True)
        return Path(await cl.download_media(msg, file=str(target), progress_callback=on_chunk))
    return target


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


async def _run(job: Job) -> None:
    msg = await client().get_messages(job.chat_id, ids=job.message_id)
    if not msg or not msg.file:
        raise RuntimeError("message has no file")

    need = msg.file.size * EXTRACT_FACTOR
    if shutil.disk_usage(SCRATCH).free < need:
        raise RuntimeError(f"not enough scratch space, need ~{need / 1e9:.1f} GB")

    work = SCRATCH / job.id
    work.mkdir()
    try:
        job.state = "downloading"
        started, total = time.time(), msg.file.size

        def on_chunk(done: int, _total: int) -> None:
            job.progress = done / total
            job.speed = done / max(time.time() - started, 0.1)

        while True:
            try:
                archive = await fast_download(client(), msg, work, on_chunk)
                break
            except FloodWaitError as e:
                job.state = f"waiting {e.seconds}s (telegram limit)"
                await asyncio.sleep(e.seconds + 1)
                job.state = "downloading"

        out = work / "out"
        out.mkdir()
        extracted = False
        if is_archive(archive.name):
            job.state, job.progress = "extracting", 0.0
            # 7z handles zip, rar, 7z, tar, gz and split volumes; -aoa avoids prompts.
            proc = await asyncio.create_subprocess_exec(
                "7z", "x", "-y", "-aoa", f"-o{out}", str(archive),
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            await proc.communicate()
            extracted = proc.returncode == 0 and any(out.iterdir())
            if extracted:
                archive.unlink()  # free the space before copying
                items = list(out.iterdir())
                if len(items) > 1:
                    # Several files: keep them together in a folder named after the archive.
                    folder = out / archive_base(archive.name)
                    folder.mkdir()
                    for it in items:
                        shutil.move(str(it), str(folder / it.name))
            else:
                shutil.rmtree(out, ignore_errors=True)
                out.mkdir()
        if not extracted:
            # Regular file (or an archive 7z couldn't open): copy it to Drive as it is.
            shutil.move(str(archive), str(out / archive.name))

        job.state = "uploading"
        dest = safe_path(job.dest)
        dest.mkdir(parents=True, exist_ok=True)
        entries = list(out.iterdir())
        for i, e in enumerate(entries, 1):
            await asyncio.to_thread(shutil.move, str(e), str(unique(dest / e.name)))
            job.progress = i / len(entries)
        job.state, job.progress = "done", 1.0
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def _worker() -> None:
    while True:
        job = JOBS[await _queue.get()]
        try:
            await _run(job)
        except Exception as e:  # surface every failure to the UI instead of killing the loop
            job.state, job.error = "failed", str(e)


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(_worker())
