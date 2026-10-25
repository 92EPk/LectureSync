/*
 * LectureSync - main process
 * Author: Ahmed Omran <B9x@outlook.com> · https://github.com/92EPK
 *
 * Owns three things the page must never touch directly:
 *   - the saved settings (Telegram keys + per-run access token, DPAPI-encrypted)
 *   - every HTTP call to the Colab worker
 *   - the embedded Colab window: it pastes the bundled worker cell, runs it,
 *     and reads the tunnel URL back out of the cell output.
 */
const {
  app, BrowserWindow, ipcMain, safeStorage, Notification, clipboard, shell, session,
} = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

// Google refuses sign-in from anything that says "Electron" in the UA.
// Match the real engine version so Google's checks don't see a mismatch.
const CHROME_MAJOR = (process.versions.chrome || "108.0.0.0").split(".")[0];
const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
app.userAgentFallback = CHROME_UA;
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
// Let passkeys use Windows Hello (PIN / fingerprint) instead of only USB keys.
app.commandLine.appendSwitch("enable-features", "WebAuthentication,WebAuthenticationWindows");

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
let colabWin = null;
let urlWatch = null;

function sendToUi(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

async function pasteAndRun(wc) {
  // Colab's editor needs a focused cell before a paste lands in it.
  const focused = await wc.executeJavaScript(`(() => {
    const ed = document.querySelector('.cell .monaco-editor textarea, .cell .inputarea, .cell textarea');
    if (!ed) return false;
    ed.focus();
    return true;
  })()`).catch(() => false);
  if (!focused) return false;
  // Saved notebooks already hold an older copy of the cell: replace it, don't append.
  wc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
  wc.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
  await new Promise((r) => setTimeout(r, 200));
  wc.paste();
  await new Promise((r) => setTimeout(r, 700));
  wc.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["control"] });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: ["control"] });
  return true;
}

async function scanForUrl() {
  if (!colabWin || colabWin.isDestroyed()) return;
  // Cell output renders inside cross-origin iframes, so look in every frame.
  const frames = colabWin.webContents.mainFrame.framesInSubtree;
  for (const f of frames) {
    const text = await f.executeJavaScript("document.body ? document.body.innerText : ''").catch(() => "");
    const m = /LECTURE_SYNC_URL=(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/.exec(text || "");
    if (m) return connectTo(m[1]);
  }
}

async function connectTo(url) {
  const { token } = readConfig();
  try {
    await call("GET", "/disk", null, { url, token });
  } catch {
    return; // tunnel printed but worker not up yet, keep watching
  }
  clearInterval(urlWatch);
  urlWatch = null;
  writeConfig({ url });
  if (colabWin && !colabWin.isDestroyed()) colabWin.hide(); // keep it alive, the runtime needs the tab
  sendToUi("colab:connected", { url });
}

// Google's sign-in checks compare the UA with what the JS engine really is.
// Pretending to be Firefox inside Chromium is an obvious mismatch and gets the
// "browser may not be secure" page, so present the real engine: plain Chrome UA
// with the same major version, no "Electron"/app name, and untouched Client
// Hints (they already report Chromium and match navigator.userAgentData).
let googleSessionReady = false;
function prepareGoogleSession() {
  const s = session.fromPartition("persist:colab");
  if (googleSessionReady) return s;
  googleSessionReady = true;
  s.setUserAgent(CHROME_UA, "en-US,en");
  s.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = d.requestHeaders;
    h["User-Agent"] = CHROME_UA;
    cb({ requestHeaders: h });
  });
  return s;
}

// ------------------------------------------------------------ system-browser fallback
// When Google still refuses the in-app window, the user runs the cell in their own
// browser and just copies the LECTURE_SYNC_URL line; we pick it up from the clipboard.
let clipWatch = null;
function watchClipboard() {
  clearInterval(clipWatch);
  const started = Date.now();
  clipWatch = setInterval(() => {
    if (Date.now() - started > 30 * 60 * 1000) return clearInterval(clipWatch);
    const text = clipboard.readText() || "";
    rememberNotebook(text.trim()); // user copied the notebook address from the browser bar
    const m = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/.exec(text);
    if (m) {
      clearInterval(clipWatch);
      clipWatch = null;
      connectTo(m[1]);
    }
  }, 1500);
}

// One token per install, so a saved notebook's cell keeps working across launches.
function getToken() {
  const c = readConfig();
  if (c.token) return c.token;
  const token = crypto.randomBytes(24).toString("hex");
  writeConfig({ token });
  return token;
}

const NOTEBOOK_RE = /^https:\/\/colab\.research\.google\.com\/drive\/[A-Za-z0-9_-]+/;
const NEW_NOTEBOOK = "https://colab.research.google.com/#create=true";
// Saved notebook first; a fresh one only when none is saved (or the user reset it).
function notebookUrl() {
  const { notebook } = readConfig();
  return notebook && NOTEBOOK_RE.test(notebook) ? notebook : NEW_NOTEBOOK;
}
function rememberNotebook(url) {
  const m = NOTEBOOK_RE.exec(url || "");
  if (!m || readConfig().notebook === m[0]) return;
  writeConfig({ notebook: m[0] });
  sendToUi("colab:notebook", { notebook: m[0] });
}

function startColabExternal() {
  const token = getToken();
  writeConfig({ url: "" });
  clipboard.writeText(buildCell(token));
  if (colabWin && !colabWin.isDestroyed()) colabWin.destroy();
  clearInterval(urlWatch);
  // Give the user a moment to paste the cell before we start reading the clipboard.
  setTimeout(watchClipboard, 8000);
  shell.openExternal(notebookUrl());
  sendToUi("colab:stage", "external");
}

function startColab() {
  const token = getToken();
  writeConfig({ url: "" });
  clipboard.writeText(buildCell(token));

  if (colabWin && !colabWin.isDestroyed()) colabWin.destroy();
  const colabSession = prepareGoogleSession();
  colabWin = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Google Colab - LectureSync engine",
    parent: mainWin,
    backgroundColor: "#ffffff",
    webPreferences: { session: colabSession, contextIsolation: true, nodeIntegration: false },
  });
  colabWin.setMenuBarVisibility(false);
  colabWin.webContents.setUserAgent(CHROME_UA);
  // Google sign-in and the Drive permission prompt open popups; keep them in the same session.
  colabWin.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      parent: colabWin,
      webPreferences: { session: colabSession, contextIsolation: true, nodeIntegration: false },
    },
  }));
  colabWin.webContents.on("did-create-window", (w) => w.webContents.setUserAgent(CHROME_UA));
  colabWin.on("closed", () => {
    colabWin = null;
    sendToUi("colab:closed");
  });

  let tries = 0;
  const tryPaste = async () => {
    if (!colabWin) return;
    const url = colabWin.webContents.getURL();
    if (!url.includes("colab.research.google.com")) return; // still on the Google login page
    if (await pasteAndRun(colabWin.webContents)) return sendToUi("colab:stage", "running");
    if (++tries < 15) setTimeout(tryPaste, 1500);
    else sendToUi("colab:stage", "manual");
  };
  colabWin.webContents.on("did-finish-load", () => setTimeout(tryPaste, 3000));
  // A new notebook gets its /drive/<id> address after Colab saves it; remember it.
  const track = (_e, u) => rememberNotebook(u);
  colabWin.webContents.on("did-navigate", track);
  colabWin.webContents.on("did-navigate-in-page", track);
  colabWin.webContents.on("did-fail-load", (_e, code, _d, u, isMain) => {
    // Saved notebook deleted or unreachable: fall back to a new one once.
    if (isMain && u !== NEW_NOTEBOOK && code !== -3) {
      writeConfig({ notebook: "" });
      colabWin.loadURL(NEW_NOTEBOOK);
    }
  });
  colabWin.loadURL(notebookUrl());

  clearInterval(urlWatch);
  urlWatch = setInterval(scanForUrl, 2500);
  sendToUi("colab:stage", "opening");
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
ipcMain.handle("colab:external", () => startColabExternal());
ipcMain.handle("colab:show", () => colabWin && colabWin.show());
ipcMain.handle("colab:copy", () => clipboard.writeText(buildCell(getToken())));
ipcMain.handle("colab:notebook:get", () => readConfig().notebook || "");
ipcMain.handle("colab:notebook:set", (_e, url) => {
  const v = String(url || "").trim();
  if (v && !NOTEBOOK_RE.test(v)) throw new Error("Paste a link like https://colab.research.google.com/drive/…");
  writeConfig({ notebook: v ? NOTEBOOK_RE.exec(v)[0] : "" });
});
ipcMain.handle("open", (_e, url) => {
  // Only the handful of links the UI actually shows.
  if (/^https:\/\/(my\.telegram\.org|github\.com\/92EPK|drive\.google\.com)/.test(url)) shell.openExternal(url);
  else if (url.startsWith("mailto:B9x@outlook.com")) shell.openExternal(url);
});
ipcMain.handle("notify", (_e, title, body) => new Notification({ title, body }).show());

app.whenReady().then(() => {
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
  // Mirror page console into the terminal so UI failures are visible.
  mainWin.webContents.on("console-message", (_e, level, message, line, source) => {
    console.log(`[ui:${level}] ${message} (${source}:${line})`);
  });
  if (process.env.LS_DEBUG === "1") mainWin.webContents.openDevTools({ mode: "detach" });
  mainWin.loadFile(path.join(__dirname, "ui", "index.html"));
});

app.on("window-all-closed", () => app.quit());
