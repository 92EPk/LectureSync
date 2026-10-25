<div align="center">

<img src="build/icon.png" width="96" alt="LectureSync logo" />

# LectureSync

**A zero-bandwidth desktop orchestrator that extracts and migrates multi-gigabyte lecture archives from Telegram directly to Google Drive via ephemeral cloud compute.**

[![Release](https://img.shields.io/github/v/release/92EPK/LectureSync?display_name=tag)](https://github.com/92EPK/LectureSync/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/92EPK/LectureSync/release.yml?label=build)](https://github.com/92EPK/LectureSync/actions/workflows/release.yml)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-informational)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[Download](#download) · [Quick start](#quick-start) · [Architecture](#architecture) · [Security](#security--privacy) · [System design](SYSTEM_DESIGN.md)

</div>

---

## Why

Course recordings are often shared as large (0.5–4 GB), compressed and split archives inside Telegram groups. Getting them into Google Drive normally means downloading to a home PC, extracting, and uploading again — paying for every byte twice on metered, asymmetric consumer connections, and needing roughly 2× the archive size in free disk space.

LectureSync removes the user's machine from the data path. The desktop app is a **control plane** only; a disposable Google Colab VM owned by the user performs download, extraction and upload entirely inside datacenter networks.

| | Manual workflow | LectureSync |
|---|---|---|
| Data over the user's connection | ≈ 2 × file size | < 1 MB of JSON per session |
| Local disk required | ≈ 2.2 × file size | none |
| Archive handling | manual | automatic (zip, rar, 7z, tar, split volumes) |
| Telegram throughput | single stream | 8 parallel MTProto streams |

## Features

- **Zero local bandwidth** — lecture bytes travel `Telegram → Colab → Drive` only.
- **Type-aware pipeline** — archives are extracted; multi-file archives get their own folder; regular files (PDF, MP4, …) are copied as-is; failed extraction falls back to copying the original.
- **Parallel downloads** — 512 KB-aligned ranges fetched by 8 concurrent workers, with automatic sequential fallback.
- **QR-code Telegram login** — no SMS required (SMS is unreliable on many mobile networks and blocked for datacenter IPs). Phone code + 2FA remain available.
- **Drive file manager** — browse, search, create, rename and delete (to Drive trash) folders without leaving the app.
- **Stable notebook reuse** — one Colab notebook per user, reopened every session; no notebook sprawl.
- **Light / dark theme**, responsive layout, native notifications.
- **Bring-your-own credentials** — every user runs on their own Google account and Telegram API keys.

## Download

Get the latest build from **[Releases](https://github.com/92EPK/LectureSync/releases)**.

| Platform | File | First launch |
|---|---|---|
| Windows 10/11 (x64) — portable | `LectureSync-Portable-<version>-x64.exe` | SmartScreen → **More info → Run anyway** |
| Windows 10/11 (x64) — installer | `LectureSync Setup <version>.exe` | same as above |
| macOS 11+ Apple Silicon (M1–M4) | `LectureSync-<version>-arm64.dmg` | drag to Applications → right-click → **Open** |
| macOS 11+ Intel | `LectureSync-<version>-x64.dmg` | same as above |
| Linux x86-64 (any distro) | `LectureSync-<version>-x86_64.AppImage` | `chmod +x` then run |
| Debian / Ubuntu | `LectureSync_<version>_amd64.deb` | `sudo apt install ./LectureSync_*.deb` |

> **Why the OS warning?** Builds are not yet code-signed (Authenticode / Apple Developer ID). The warning is shown for every unsigned binary and is not a malware detection. Verify the download with the checksums below. If macOS reports the app as "damaged", run `xattr -cr /Applications/LectureSync.app` once.

### Verify your download

Each release ships `SHA256SUMS.txt`, generated in CI from the exact artifacts it publishes.

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

```powershell
# Windows (PowerShell)
Get-FileHash .\LectureSync-Portable-1.0.0-x64.exe -Algorithm SHA256
```

## Quick start

**Prerequisites:** a Google account, a Telegram account, and your own Telegram **API ID / API Hash** from [my.telegram.org](https://my.telegram.org) → *API development tools*.

1. **Enter your keys.** Launch LectureSync, open *my.telegram.org* from step 1, create an app, and paste the API ID and Hash. They are encrypted with the OS keychain.
2. **Start the engine.** Click **Start Colab engine**. Colab opens in your default browser (Google rejects sign-in inside embedded browsers). The worker script is already on your clipboard — click the cell, press `Ctrl/⌘ + A`, `Ctrl/⌘ + V`, then `Ctrl/⌘ + Enter`.
3. **Allow Drive access** when Colab asks. After ~60 s the app detects the tunnel and turns green.
4. **Sign in to Telegram** (first time only) by scanning the QR code from *Telegram → Settings → Devices → Link Desktop Device*. The session is stored in your own Drive.
5. **Sync.** Pick a Drive folder, pick a Telegram file, press **Send to Drive**, and watch the job progress.

Keep the app and the Colab tab open while jobs run.

## Architecture

```text
 ┌──────────── Your computer ────────────┐          ┌────────── Your Google Colab VM ──────────┐
 │  LectureSync (Electron)               │  HTTPS   │  cloudflared ─► FastAPI + Telethon        │
 │  control plane · JSON only            │◄────────►│  data plane                               │
 └───────────────────────────────────────┘  token   │    Telegram ══► scratch ══► 7-Zip ══► Drive│
                                                    └───────────────────────────────────────────┘
```

Full design, threat model and decision records: **[SYSTEM_DESIGN.md](SYSTEM_DESIGN.md)**.

## Build from source

Requires Node.js 18+.

```bash
git clone https://github.com/92EPK/LectureSync.git
cd LectureSync
npm install
npm start               # run in development
```

| Host OS | Command | Output in `release/` |
|---|---|---|
| Windows | `npm run build:win` | portable `.exe` + NSIS installer |
| Linux | `npm run build:linux` | `.AppImage` + `.deb` |
| macOS | `npm run build:mac` | `.dmg` + `.zip` (x64 + arm64) |

macOS images can only be produced on macOS; the CI pipeline handles all three.

### Releasing

```bash
# bump "version" in package.json first
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions builds on native Windows, Linux and macOS runners in parallel, computes SHA-256 checksums and publishes a Release (≈10 min). Builds can also be started manually from **Actions → Release → Run workflow**.

## Project structure

```text
LectureSync/
├── .github/workflows/release.yml   CI: 3-OS build matrix + GitHub Release
├── build/                          application icons (ico / png)
├── ui/                             renderer: HTML, CSS, vanilla JS
├── worker/server.py                Colab worker (FastAPI + Telethon), bundled into the app
├── main.cjs                        main process: secrets, worker client, Colab orchestration
├── preload.cjs                     contextBridge — the only renderer ↔ main interface
├── package.json                    dependencies and electron-builder targets
├── SYSTEM_DESIGN.md
└── LICENSE
```

## Security & privacy

- No telemetry, no analytics, no author-operated servers.
- API hash and access token encrypted at rest via Electron `safeStorage` (DPAPI · Keychain · libsecret).
- Every worker call is authenticated with a 192-bit random token; the tunnel URL alone grants nothing.
- Renderer runs with `contextIsolation`, no Node integration, and an allow-listed IPC surface.
- Drive operations are confined to `My Drive`; deletes go to Drive trash and require typing the exact name.

## Terms of service & responsible use

LectureSync is an educational utility. It uses only official interfaces — the Telegram client API (MTProto, user-issued keys) and Colab's built-in `google.colab.drive` mount — and runs on standard CPU runtimes for the duration of an interactive session. It does not mine, proxy, torrent or host public services. Users are responsible for moving only content they are entitled to access, and for complying with the terms of Google Colab and Telegram.

## Limitations

- Colab free-tier sessions have idle and maximum-length limits set by Google.
- Quick-tunnel URLs are ephemeral; the app rediscovers them automatically.
- Telegram file limit: 2 GB (4 GB with Premium).
- Colab UI automation depends on Colab's page structure and may need updates when it changes.

## License

[MIT](LICENSE) © 2026 Ahmed Omran

**Author:** Ahmed Omran · [B9x@outlook.com](mailto:B9x@outlook.com) · GitHub [@92EPK](https://github.com/92EPK)
