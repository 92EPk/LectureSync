/*
 * LectureSync - main process
 * Author: Ahmed Omran <B9x@outlook.com> · https://github.com/92EPK
 * A student initiative - CS Diploma, Faculty of Graduate Studies for Statistical
 * Research (FGSSR), Cairo University · https://cs-fgssr.pages.dev/
 *
 * Owns three things the page must never touch directly:
 *   - the saved settings (Telegram keys + access token, OS-encrypted)
 *   - every HTTP call to the Colab worker
 *   - the lecturesync:// deep link that the hosted Colab notebook uses to
 *     hand the tunnel URL + token back to the app.
 *
 * Google sign-in never happens inside Electron (Google blocks embedded
 * browsers). Colab is always opened in the user's real default browser.
 */
const {
  app, BrowserWindow, ipcMain, safeStorage, Notification, clipboard, shell, dialog,
} = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const PROTOCOL = "lecturesync";
const NOTEBOOK_URL = "https://colab.research.google.com/github/92EPK/LectureSync/blob/main/LectureSync.ipynb";

const SECRET_KEYS = ["token", "apiHash"];
const cfgFile = () => path.join(app.getPath("userData"), "config.json");
const canEncrypt = () => safeStorage.isEncryptionAvailable();

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgFile(), "utf8"));
    for (const k of SECRET_KEYS) {
      if (raw[k] && raw.encrypted) raw[k] = safeStorage.decryptString(Buffer.from(raw[k], "base64"));
    }
    return raw;
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const out = { ...readConfig(), ...patch, encrypted: canEncrypt() };
  for (const k of SECRET_KEYS) {
    if (out[k] && out.encrypted) out[k] = safeStorage.encryptString(out[k]).toString("base64");
  }
  fs.writeFileSync(cfgFile(), JSON.stringify(out));
}

// ------------------------------------------------------------ worker HTTP

function call(method, route, body, override) {
  const cfg = { ...readConfig(), ...override };
  if (!cfg.url) return Promise.reject(new Error("Not connected to Colab yet"));
  // Electron 22 ships Node 16 without a stable global fetch, so use https directly.
  const target = new URL(cfg.url.replace(/\/$/, "") + route);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(target, {
      method,
      timeout: 20000,
      headers: {
        "content-type": "application/json",
        "x-access-token": cfg.token || "",
        ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        if (res.statusCode >= 400) reject(new Error(data.detail || `Worker answered ${res.statusCode}`));
        else resolve(data);
      });
    });
    req.on("timeout", () => req.destroy(new Error("Colab did not answer in time")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------ Colab cell

function workerSource() {
  // In a packed build worker/ sits inside app.asar next to this file.
  return fs.readFileSync(path.join(__dirname, "worker", "server.py"));
}

function buildCell(token) {
  const b64 = workerSource().toString("base64");
  return [
    "#@title LectureSync worker (pasted by the desktop app - just leave it running)",
    "import base64, os, re, subprocess, sys, threading, time",
    "from google.colab import drive",
    "drive.mount('/content/drive')",
    "print('Installing tools, about a minute the first time...')",
    "subprocess.run('pip -q install telethon cryptg qrcode fastapi \"uvicorn[standard]\"', shell=True, check=True)",
    "subprocess.run('apt-get -qq install -y p7zip-full p7zip-rar > /dev/null', shell=True)",
    "if not os.path.exists('/usr/local/bin/cloudflared'):",
    "    subprocess.run('wget -q -O /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared', shell=True, check=True)",
    `open('/content/server.py', 'wb').write(base64.b64decode('${b64}'))`,
    `os.environ['LS_ACCESS_TOKEN'] = '${token}'`,
    "subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '8000'],",
    "                 cwd='/content', stdout=open('/content/worker.log', 'w'), stderr=subprocess.STDOUT)",
    "tunnel = subprocess.Popen(['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8000', '--no-autoupdate'],",
    "                          stderr=subprocess.PIPE, text=True)",
    "for line in tunnel.stderr:",
    "    m = re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com', line)",
    "    if m:",
    "        print('LECTURE_SYNC_URL=' + m.group(0))",
    "        break",
    "# keep reading so cloudflared never blocks on a full pipe",
    "threading.Thread(target=lambda: [None for _ in tunnel.stderr], daemon=True).start()",
    "while True:",
    "    time.sleep(300)",
    "    print(time.strftime('%H:%M'), 'worker alive')",
  ].join("\n");
}

let mainWin = null;
let pendingLink = null;

function sendToUi(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

function focusMain() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

// Verify the worker answers with this token, then save and go green.
async function connectTo(url, token) {
  const t = token || readConfig().token;
  await call("GET", "/disk", null, { url, token: t });
  writeConfig({ url, token: t });
  sendToUi("colab:connected", { url });
  return true;
}

// ------------------------------------------------------------ deep link
// The hosted notebook ends with a button pointing at
//   lecturesync://connect?url=https://xxxx.trycloudflare.com&token=<random>
// The OS hands that link to this app. No local server, no open ports.
const TUNNEL_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/;

function parseDeepLink(link) {
  try {
    const u = new URL(link);
    if (u.protocol !== `${PROTOCOL}:`) return null;
    const action = (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
    if (action !== "connect") return null;
    const url = (u.searchParams.get("url") || "").trim();
    const token = (u.searchParams.get("token") || "").trim();
    if (!TUNNEL_RE.test(url) || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
    return { url: url.replace(/\/$/, ""), token };
  } catch {
    return null;
  }
}

async function handleDeepLink(link) {
  if (!mainWin || mainWin.isDestroyed() || mainWin.webContents.isLoading()) {
    pendingLink = link; // delivered once the window is ready
    return;
  }
  focusMain();
  const p = parseDeepLink(link);
  if (!p) return sendToUi("colab:link-error", "That link isn't a valid LectureSync connect link.");
  // Any web page can fire a custom-protocol link, so the user confirms the address.
  const { response } = await dialog.showMessageBox(mainWin, {
    type: "question",
    buttons: ["Connect", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "Connect LectureSync",
    message: "Connect to your Colab engine?",
    detail: `Only press Connect if you just clicked the button in YOUR Colab notebook.\n\n${p.url}`,
  });
  if (response !== 0) return;
  sendToUi("colab:stage", "linking");
  try {
    await connectTo(p.url, p.token);
  } catch (e) {
    sendToUi("colab:link-error", "Colab isn't answering yet. Wait a few seconds and click the button again.");
  }
}

// ------------------------------------------------------------ open Colab
// Google blocks sign-in inside embedded browsers (Electron included), so Colab
// is ALWAYS opened in the user's real default browser where they're already signed in.
function startColab() {
  shell.openExternal(NOTEBOOK_URL);
  sendToUi("colab:stage", "browser");
}

// Fallback for users who prefer their own notebook: copy the cell, then catch
// the LECTURE_SYNC_URL line from the clipboard.
let clipWatch = null;
function watchClipboard() {
  clearInterval(clipWatch);
  const started = Date.now();
  clipWatch = setInterval(() => {
    if (Date.now() - started > 30 * 60 * 1000) return clearInterval(clipWatch);
    const m = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/.exec(clipboard.readText() || "");
    if (m) connectTo(m[1]).then(() => { clearInterval(clipWatch); clipWatch = null; }, () => {});
  }, 1500);
}

// One token per install for the copy/paste cell.
function getToken() {
  const c = readConfig();
  if (c.token) return c.token;
  const token = crypto.randomBytes(24).toString("hex");
  writeConfig({ token });
  return token;
}

function startColabExternal() {
  clipboard.writeText(buildCell(getToken()));
  setTimeout(watchClipboard, 8000);
  shell.openExternal("https://colab.research.google.com/#create=true");
  sendToUi("colab:stage", "external");
}

// ------------------------------------------------------------ IPC

ipcMain.handle("config:get", () => {
  const c = readConfig();
  return { url: c.url || "", apiId: c.apiId || "", hasApiHash: Boolean(c.apiHash), version: app.getVersion() };
});
ipcMain.handle("config:telegram", (_e, { apiId, apiHash }) => {
  writeConfig({ apiId: String(apiId).trim(), ...(apiHash ? { apiHash: apiHash.trim() } : {}) });
});
ipcMain.handle("config:url", async (_e, url) => {
  // Manual fallback: the token still comes from the last cell we generated.
  await call("GET", "/disk", null, { url });
  writeConfig({ url });
});
ipcMain.handle("telegram:configure", () => {
  const { apiId, apiHash } = readConfig();
  if (!apiId || !apiHash) throw new Error("Add your Telegram API ID and API Hash in Settings first");
  return call("POST", "/telegram/configure", { api_id: Number(apiId), api_hash: apiHash });
});
ipcMain.handle("api", (_e, method, route, body) => call(method, route, body));
ipcMain.handle("colab:start", () => startColab());
// Fallback: classic copy/paste of the cell into the user's own notebook.
ipcMain.handle("colab:external", () => startColabExternal());
ipcMain.handle("colab:copy", () => clipboard.writeText(buildCell(getToken())));
ipcMain.handle("open", (_e, url) => {
  // Only the handful of links the UI actually shows.
  if (/^https:\/\/(my\.telegram\.org|github\.com\/92EPK|drive\.google\.com|cs-fgssr\.pages\.dev)/i.test(url)) shell.openExternal(url);
  else if (url.startsWith("mailto:B9x@outlook.com")) shell.openExternal(url);
});
ipcMain.handle("notify", (_e, title, body) => new Notification({ title, body }).show());

// ------------------------------------------------------------ deep link wiring

// Only one copy of the app runs; a second launch (from the browser link) hands
// its arguments to the first and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.defaultApp && process.argv.length >= 2) {
    // `npm start` during development: register with the electron binary + script path.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
  });
  // macOS delivers links through this event instead of argv.
  app.on("open-url", (e, link) => {
    e.preventDefault();
    handleDeepLink(link);
  });

  app.whenReady().then(() => {
    createMainWindow();
    // Windows/Linux: the app may have been cold-started by the link itself.
    const link = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
  });
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#0e1116",
    title: "LectureSync",
    icon: path.join(__dirname, "ui", "assets", "logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The packaged (asar) preload fails to load under the Windows sandbox,
      // leaving window.ls undefined; isolation still keeps Node away from the page.
      sandbox: false,
    },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.webContents.on("preload-error", (_e, file, err) => {
    console.error("Preload failed:", file, err);
    mainWin.webContents.openDevTools();
  });
  mainWin.webContents.on("before-input-event", (_e, input) => {
    const devKey = input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i");
    if (input.type === "keyDown" && devKey) mainWin.webContents.toggleDevTools();
  });
  mainWin.webContents.on("console-message", (_e, level, message, line, source) => {
    console.log(`[ui:${level}] ${message} (${source}:${line})`);
  });
  // The page must never navigate away or open windows of its own.
  mainWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWin.webContents.on("did-finish-load", () => {
    if (pendingLink) { const l = pendingLink; pendingLink = null; handleDeepLink(l); }
  });
  if (process.env.LS_DEBUG === "1") mainWin.webContents.openDevTools({ mode: "detach" });
  mainWin.loadFile(path.join(__dirname, "ui", "index.html"));
}

app.on("window-all-closed", () => app.quit());
