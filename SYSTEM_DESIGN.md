# LectureSync — System Design

| | |
|---|---|
| **Author** | Ahmed Omran · B9x@outlook.com · GitHub [@92EPK](https://github.com/92EPK) |
| **Version** | 1.0 |
| **Status** | In production use by a postgraduate diploma cohort |
| **Platforms** | Windows 10/11 · macOS 11+ (x64, arm64) · Linux x86-64 |
| **Repository** | https://github.com/92EPK/LectureSync |

---

## Abstract

LectureSync is a cross-platform desktop application that moves large, frequently compressed lecture archives from Telegram into Google Drive without the data ever crossing the user's own network link. It achieves this by separating a lightweight **control plane** (an Electron desktop client) from a **data plane** (a disposable worker on the user's own Google Colab VM), connected through an authenticated, ephemeral HTTPS tunnel. The design targets resource-constrained environments — metered, asymmetric consumer bandwidth, limited local storage, and unreliable SMS delivery — and requires no infrastructure owned or operated by the author.

---

## 1. Problem statement

Lecture recordings (0.5–4 GB each) are distributed as zip/rar/7z archives, often split into volumes, inside Telegram groups. Students need them organised in Google Drive. The conventional path — download, extract, re-upload — exhibits three structural problems in the target environment (Egypt):

1. **Bandwidth cost.** Each lecture consumes ≈ 2 × its size of metered quota, and consumer upload rates make the re-upload the dominant time cost.
2. **Storage pressure.** Extraction needs ≈ 2.2 × the archive size of free disk space.
3. **Authentication friction.** Telegram SMS codes are frequently undelivered on local carriers and rejected for datacenter IPs; Google rejects interactive sign-in inside embedded browsers.

## 2. Goals, non-goals and invariants

| ID | Goal | Acceptance measure |
|---|---|---|
| G1 | Zero lecture bytes over the user's link | Desktop exchanges only JSON control messages (< 1 MB per session) |
| G2 | Zero infrastructure cost, zero operator | No author-owned server; compute is the user's own free Colab VM |
| G3 | Per-user credential isolation | Each user supplies their own Google account and Telegram API keys |
| G4 | Non-technical usability | Single executable, no Python or CLI, guided three-step setup |
| G5 | Cross-platform delivery | One codebase; reproducible CI builds for Windows, macOS, Linux |

**Non-goals.** Hosting, indexing or redistributing content; multi-user servers; integration with any third-party platform backend.

**Invariants.**

- *I1 — Data-plane confinement:* lecture bytes flow only `Telegram DC → Colab VM → Google Drive`.
- *I2 — Zero custody:* the author never receives credentials, sessions, or content.
- *I3 — Least authority:* the renderer cannot reach the network or the filesystem directly.

---

## 3. Architecture

```text
┌──────────────────────── Control plane · Desktop (Electron 33) ─────────────────────────┐
│                                                                                        │
│  Renderer (ui/)              contextBridge              Main process (main.cjs)        │
│  · setup wizard        ─────  preload.cjs  ─────►       · config + safeStorage secrets │
│  · Telegram pane             (allow-listed IPC)         · authenticated worker client  │
│  · Drive pane                                           · Colab cell builder           │
│  · Jobs pane                                            · notebook / tunnel discovery  │
│  · theme, responsive                                    · external-link allow-list     │
└───────────────────────────────────────────────────────────────┬────────────────────────┘
                     HTTPS · x-access-token · JSON only          │  opens Colab
                                                                 │  (system browser)
┌──────────────────────── Data plane · Google Colab VM (per user) ▼──────────────────────┐
│  cloudflared quick tunnel ─► uvicorn ─► worker/server.py (FastAPI + Telethon)          │
│                                             │                         │                │
│             Telegram MTProto  ◄─────────────┘                         └──► Drive FUSE  │
│             8 parallel range streams          /content/scratch ─► 7-Zip ─► My Drive    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Components

| Component | Technology | Responsibility |
|---|---|---|
| Renderer | HTML, CSS, vanilla JS | UI state, filtering/search, theming, responsive layout. No Node APIs, no network. |
| Preload | Electron `contextBridge` | Exposes a fixed, enumerated set of IPC calls — the sole renderer/main interface. |
| Main process | Node.js (Electron 33) | Secret storage, worker HTTP client, Colab orchestration, URL allow-listing. |
| Worker | Python 3, FastAPI, Telethon, uvicorn | Telegram session, transfer, extraction, Drive file operations, job queue. |
| Tunnel | Cloudflare quick tunnel | Ephemeral public HTTPS endpoint without accounts, ports, or DNS. |

### 3.2 Why a split control/data plane

Placing compute next to both the source (Telegram datacenters) and the sink (Google Drive) converts a consumer-bandwidth problem into a datacenter-bandwidth one. The desktop client becomes stateless with respect to content, which also removes local disk requirements and makes the client trivially portable across operating systems.

---

## 4. Session lifecycle

1. **Bootstrap.** The main process loads — or generates once and persists — a 192-bit random access token, then builds a single self-contained Python cell: base64-embedded `server.py`, the token, dependency installation, and tunnel launch. The cell is placed on the clipboard.
2. **Notebook reuse.** The app opens the user's saved notebook (`colab.research.google.com/drive/<id>`). Only on first run, or after an explicit reset, is a new notebook created; its URL is captured and persisted. This bounds notebook count to one per user.
3. **Google sign-in.** Delegated to the operating system's default browser. Google's BotGuard fingerprints embedded Chromium; delegation is the industry-standard remedy (VS Code, Slack, Discord) and avoids user-agent spoofing.
4. **Worker start.** The cell mounts Drive, installs dependencies (Telethon, FastAPI, 7-Zip, cloudflared), starts uvicorn on `127.0.0.1:8000`, and prints `LECTURE_SYNC_URL=https://….trycloudflare.com`.
5. **Discovery and verification.** The app detects the URL from the clipboard (or manual entry), verifies it with an authenticated `GET /disk`, and persists it.
6. **Telegram authentication.** The worker loads `MyDrive/.lecture-sync/telegram-<api_id>.session`. If unauthorised, **QR login** (`client.qr_login()`) is the primary flow; the user approves from an already-signed-in phone, eliminating SMS. Phone code and 2FA password remain as fallback.
7. **Teardown.** Closing Colab discards the VM. The Telegram session persists in the user's Drive, so the next session requires no re-authentication.

---

## 5. Transfer pipeline

```text
queued ─► downloading ─► extracting ─► uploading ─► done
              │              │             │
              └──────────────┴─────────────┴──────► failed (reason recorded)
```

| Stage | Mechanism |
|---|---|
| Admission control | Job rejected up front if free scratch space < size × 2.2. |
| Download | File partitioned into 512 KB-aligned ranges; 8 concurrent `upload.GetFileRequest` workers write by offset. Any part error triggers fallback to Telethon's sequential downloader. Observed throughput rose from ≈ 1.3 MB/s (sequential) to tens of MB/s. |
| Classification | Extension and split-volume patterns (`.zip .rar .7z .tar .gz .bz2 .xz .tgz`, `.001`, `.partN.rar`, `.zNN`). |
| Extraction | `7z x` into an isolated scratch directory. |
| Placement | One top-level item → moved as-is. Multiple items → wrapped in a folder named after the archive (all archive suffixes stripped). Non-archives → moved directly. |
| Safety net | If extraction fails, the original file is uploaded rather than discarded. |
| Naming | Collision-safe: `name (2).ext`, `name (3).ext`; never overwrites. |
| Back-pressure | Telegram `FloodWait` is honoured by sleeping; jobs run serially to stay within rate limits. |

---

## 6. Worker API

All routes except `/health` require the `x-access-token` header.

| Method · Route | Purpose |
|---|---|
| `GET /health` | Liveness, key configuration, Telegram authorisation state |
| `GET /disk` | Scratch-disk usage; also used for token verification |
| `POST /telegram/configure` | `{api_id, api_hash}` → open the per-user client |
| `POST /telegram/qr/start` · `GET /telegram/qr/status` · `POST /telegram/qr/password` | QR login and 2FA |
| `POST /telegram/send-code` · `POST /telegram/sign-in` | Phone-code fallback |
| `GET /telegram/chats` | Dialog list |
| `GET /telegram/files?chat_id=&q=` | Documents in a chat, with server-side search |
| `GET /drive/list?path=` | Directory listing under My Drive (fault-tolerant per entry) |
| `POST /drive/mkdir` · `POST /drive/rename` · `POST /drive/delete` | Folder management, path-confined |
| `POST /jobs` · `GET /jobs` | Enqueue a transfer; poll progress |

---

## 7. Security model

### 7.1 Trust boundaries

1. Renderer ↔ main process (IPC, allow-listed).
2. Desktop ↔ worker (public internet, token-authenticated TLS).
3. Worker ↔ Telegram / Google (official APIs, user credentials).

### 7.2 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Tunnel URL leaked or guessed | Every request requires a 192-bit token; the URL alone confers no access. |
| Secrets at rest on the desktop | API hash and token encrypted with Electron `safeStorage` → DPAPI (Windows), Keychain (macOS), libsecret (Linux). |
| Renderer compromise (XSS) | `contextIsolation: true`, `nodeIntegration: false`, enumerated preload API; all network I/O in the main process. |
| Malicious or phishing links | `shell.openExternal` restricted to an explicit domain allow-list. |
| Path traversal on Drive | Paths resolved and required to remain under `/content/drive/MyDrive`; root deletion refused. |
| Destructive user error | Deletion requires typing the exact name and moves items to Drive trash (30-day recovery). |
| Privilege escalation | Runs as invoker; no services, no elevation. |
| Supply-chain tampering of binaries | Artifacts built in clean CI runners from tagged source; SHA-256 manifest published with every release. |
| Author access to user data | Architecturally impossible: no author-run infrastructure, no telemetry (invariant I2). |

**OAuth scope note.** The consent screen shown by `drive.mount()` belongs to Google's own Colab/Drive client. LectureSync registers no OAuth client and requests no scopes of its own.

---

## 8. Fault tolerance

| Failure | Behaviour |
|---|---|
| Unreadable Drive entry (FUSE `OSError`, broken link) | Entry skipped; listing still succeeds. |
| Saved notebook deleted | Load failure detected; a new notebook is opened and remembered. |
| Colab UI changes break automation | Clipboard-based cell delivery and manual tunnel entry remain available. |
| Colab VM recycled | Telegram session survives on Drive; the app reconnects to the new tunnel. |
| Parallel download part fails | Automatic fallback to sequential download. |
| Archive extraction fails | Original file uploaded instead (no data loss). |

---

## 9. Build, release and distribution

### 9.1 Pipeline

`.github/workflows/release.yml` defines a three-runner matrix executed in parallel:

```text
tag vX.Y.Z ─► ┌ windows-latest ─ electron-builder → NSIS + portable .exe ┐
              ├ ubuntu-latest  ─ electron-builder → AppImage + .deb       ├─► artifacts ─► SHA256SUMS.txt ─► GitHub Release
              └ macos-latest   ─ electron-builder → .dmg + .zip (x64,arm64)┘
```

- **Native runners** are required: Apple restricts `.dmg` creation to macOS, and Windows installers are most reliably produced on Windows.
- `fail-fast: false` isolates platform failures so one OS never blocks the others.
- The release job runs only for tags and depends on all builds.
- A manual `workflow_dispatch` trigger produces the same artifacts without publishing.

### 9.2 Artifacts

| OS | Artifacts |
|---|---|
| Windows | `LectureSync-Portable-<v>-x64.exe`, `LectureSync Setup <v>.exe` |
| macOS | `LectureSync-<v>-arm64.dmg`, `LectureSync-<v>-x64.dmg`, matching `.zip` |
| Linux | `LectureSync-<v>-x86_64.AppImage`, `LectureSync_<v>_amd64.deb` |

### 9.3 Code signing

Current releases are unsigned; Windows SmartScreen and macOS Gatekeeper therefore display first-run warnings. Integrity is provided by the CI-generated SHA-256 manifest. Authenticode signing and Apple notarisation are configuration-only additions to the existing pipeline (certificates supplied as repository secrets).

---

## 10. Compliance and responsible use

- **Official interfaces only:** Telegram client API with user-issued keys; Colab's built-in Drive mount.
- **Resource stewardship:** standard CPU runtime, interactive sessions only, no GPU/TPU use, no persistent or public services, no mining, proxying or peer-to-peer traffic.
- **Rate-limit respect:** serial job queue and honoured `FloodWait`.
- **Scope of use:** transfers only content the user is already entitled to access, into the user's own storage.

---

## 11. Known limitations

- Colab free-tier idle and maximum-session limits are set by Google and not published as fixed values.
- Quick-tunnel URLs are ephemeral; rediscovery is automatic but requires the Colab cell to run.
- Telegram per-file limit: 2 GB (4 GB with Premium).
- Colab automation depends on Colab's DOM; selectors are isolated to minimise change surface.

## 12. Future work

- Code signing and notarisation for all platforms.
- Resumable downloads across VM recycling using persisted range checkpoints.
- Concurrent jobs with adaptive rate control.
- Automated end-to-end tests against a mocked worker API.

---

## 13. Architectural decision records

| # | Decision | Alternatives | Rationale |
|---|---|---|---|
| ADR-1 | Colab as compute | Rented VPS; home PC | Free, datacenter bandwidth, native Drive mount, no operator (G1, G2). |
| ADR-2 | Bring-your-own Telegram keys | One shared application key | Credential isolation, no single point of ban, no custody (G3, I2). |
| ADR-3 | QR login as primary | SMS code only | SMS blocked for datacenter IPs and unreliable on local carriers. |
| ADR-4 | System browser for Google sign-in | Spoofed user agent in Electron | BotGuard fingerprints embedded Chromium; spoofing is fragile and contrary to policy. |
| ADR-5 | Electron | Tauri; native per-OS apps | One JS codebase, mature packaging for three OSes, bundled Chromium. |
| ADR-6 | Cloudflare quick tunnel | ngrok; port forwarding | No account, no ports, free TLS; token supplies authentication. |
| ADR-7 | Serial job queue | Unbounded concurrency | Predictable disk use and Telegram rate-limit safety. |
| ADR-8 | Standalone repository | Monorepo with other projects | Independent versioning, releases and audit; no shared blast radius. |
