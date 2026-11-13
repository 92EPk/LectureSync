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
  app, BrowserWindow, ipcMain, safeStorage, Notification, clipboard, shell, dialog, powerSaveBlocker,
  Tray, Menu, nativeImage,
} = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");

const PROTOCOL = "lecturesync";
const NOTEBOOK_URL = "https://colab.research.google.com/github/92EPK/LectureSync/blob/main/LectureSync.ipynb";

const SECRET_KEYS = ["token", "apiHash", "msRefresh"];
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
    "subprocess.run('pip -q install telethon qrcode fastapi \"uvicorn[standard]\"', shell=True, check=True)",
    "subprocess.run('pip -q install tgcrypto', shell=True)",
    "subprocess.run('pip -q install -U yt-dlp', shell=True)",
    "subprocess.run('apt-get -qq install -y p7zip-full p7zip-rar ffmpeg > /dev/null', shell=True)",
    "if not os.path.exists('/usr/local/bin/cloudflared'):",
    "    subprocess.run('wget -q -O /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared', shell=True, check=True)",
    `open('/content/server.py', 'wb').write(base64.b64decode('${b64}'))`,
    `os.environ['LS_ACCESS_TOKEN'] = '${token}'`,
    "subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '8000'],",
    "                 cwd='/content', stdout=open('/content/worker.log', 'w'), stderr=subprocess.STDOUT)",
    "tunnel = subprocess.Popen(['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8000', '--no-autoupdate'],",
    "                          stderr=subprocess.PIPE, text=True)",
    "url = None",
    "for line in tunnel.stderr:",
    "    m = re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com', line)",
    "    if m:",
    "        url = m.group(0)",
    "        break",
    "# keep reading so cloudflared never blocks on a full pipe",
    "threading.Thread(target=lambda: [None for _ in tunnel.stderr], daemon=True).start()",
    "import urllib.request",
    "for _ in range(60):",
    "    try:",
    "        urllib.request.urlopen(url + '/health', timeout=5); break",
    "    except Exception as e:",
    "        if getattr(e, 'code', None): break",
    "        time.sleep(2)",
    "from IPython.display import HTML, display",
    `link = f'lecturesync://connect?url={url}&token=${token}'`,
    "display(HTML(f'''<div style=\"font-family:sans-serif;padding:16px;border:1px solid #2e7d32;border-radius:10px;max-width:560px\">",
    "<p style=\"margin:0 0 12px\">Engine is ready. Click the button, then choose <b>Open LectureSync</b> if your browser asks.</p>",
    "<a href=\"{link}\" target=\"_blank\" style=\"display:inline-block;background:#2e7d32;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600\">Connect to LectureSync</a>",
    "<p style=\"margin:12px 0 0;font-size:12px;color:#777\">Button not working? Copy this line and the app connects by itself:<br><code>{url}</code></p></div>'''))",
    "print('LECTURE_SYNC_URL=' + url)",
    "# Keep-alive: a silent audio tone stops the browser from freezing this tab.",
    "display(HTML('<script>try{const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();g.gain.value=0.0001;o.connect(g);g.connect(c.destination);o.start();document.addEventListener(\"click\",()=>c.resume());}catch(e){}</script>'))",
    "while True:",
    "    time.sleep(60)",
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
  return { url: c.url || "", apiId: c.apiId || "", hasApiHash: Boolean(c.apiHash), hasMsClientId: Boolean(c.msClientId), msClientId: c.msClientId || "", msTenant: c.msTenant || "", version: app.getVersion() };
});
ipcMain.handle("config:telegram", (_e, { apiId, apiHash }) => {
  writeConfig({ apiId: String(apiId).trim(), ...(apiHash ? { apiHash: apiHash.trim() } : {}) });
});
ipcMain.handle("config:url", async (_e, url) => {
  // Manual fallback: the token still comes from the last cell we generated.
  await call("GET", "/disk", null, { url });
  writeConfig({ url });
});
// Disconnect: forget this Colab session (URL + token); Telegram API keys are kept.
ipcMain.handle("config:disconnect", () => {
  writeConfig({ url: "", token: "" });
});
ipcMain.handle("telegram:configure", () => {
  const { apiId, apiHash } = readConfig();
  if (!apiId || !apiHash) throw new Error("Add your Telegram API ID and API Hash in Settings first");
  return call("POST", "/telegram/configure", { api_id: Number(apiId), api_hash: apiHash });
});
ipcMain.handle("config:microsoft", (_e, clientId, tenant) => writeConfig({ msClientId: String(clientId || "").trim(), msTenant: String(tenant || "").trim() }));
// Built-in public Microsoft app ID; sent whenever the user has no custom one,
// so sign-in works even if the Colab engine is an older build without it.
const MS_DEFAULT_CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c";
ipcMain.handle("microsoft:configure", () => {
  const { msClientId, msTenant } = readConfig();
  return call("POST", "/ms/configure", { client_id: msClientId || MS_DEFAULT_CLIENT_ID, tenant: msClientId ? msTenant || "" : "" });
});
// ---- Microsoft sign-in in the PC's own browser (PKCE + localhost redirect).
// University rules (error 53003) block sign-ins that start from Colab's US datacenter;
// signing in here uses the user's own IP and device, then only the token goes to Colab.
const MS_LIGHT_SCOPES = "openid profile offline_access User.Read Files.ReadWrite";
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const msAuthority = () => `https://login.microsoftonline.com/${readConfig().msTenant || "organizations"}/oauth2/v2.0`;

function postForm(url, data) {
  const body = new URLSearchParams(data).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(url), { method: "POST", timeout: 20000,
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } }, (res) => {
      let raw = ""; res.setEncoding("utf8"); res.on("data", (c) => (raw += c));
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error("Microsoft answered " + res.statusCode)); } });
    });
    req.on("timeout", () => req.destroy(new Error("Microsoft did not answer in time")));
    req.on("error", reject); req.write(body); req.end();
  });
}

function idUser(idToken) {
  try {
    const p = JSON.parse(Buffer.from(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return p.preferred_username || p.email || p.name || "";
  } catch { return ""; }
}

async function msHandOver(r) {
  if (!r.access_token) throw new Error((r.error_description || r.error || "Microsoft sign-in failed").split("\r\n")[0]);
  const user = idUser(r.id_token || "") || readConfig().msUser || "";
  writeConfig({ ...(r.refresh_token ? { msRefresh: r.refresh_token } : {}), msUser: user });
  await call("POST", "/ms/token", { access_token: r.access_token, expires_in: Number(r.expires_in) || 3600, user });
  return { ok: true, user };
}

ipcMain.handle("microsoft:browser-login", async () => {
  const { msClientId } = readConfig();
  if (!msClientId) throw new Error("Add your Microsoft app ID in Settings first");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const { code, redirect } = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname !== "/") { res.writeHead(404); return res.end(); }
      const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<body style="font-family:system-ui;background:#0c0d0e;color:#eee;display:grid;place-items:center;height:100vh"><h2>${ok ? "Signed in — you can close this tab and go back to LectureSync." : "Sign-in failed — go back to LectureSync and try again."}</h2></body>`);
      clearTimeout(timer); srv.close();
      if (ok) resolve({ code: u.searchParams.get("code"), redirect: `http://localhost:${srv.address()?.port || port}` });
      else reject(new Error((u.searchParams.get("error_description") || u.searchParams.get("error") || "sign-in cancelled").split("\r\n")[0]));
    });
    let port = 0;
    const timer = setTimeout(() => { srv.close(); reject(new Error("Sign-in timed out — try again")); }, 5 * 60 * 1000);
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      port = srv.address().port;
      const q = new URLSearchParams({ client_id: msClientId, response_type: "code", redirect_uri: `http://localhost:${port}`,
        response_mode: "query", scope: MS_LIGHT_SCOPES, state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" });
      shell.openExternal(`${msAuthority()}/authorize?${q}`);
    });
  });
  const r = await postForm(`${msAuthority()}/token`, { client_id: msClientId, grant_type: "authorization_code", code,
    redirect_uri: redirect, code_verifier: verifier, scope: MS_LIGHT_SCOPES });
  return msHandOver(r);
});

// Refresh on the PC and hand the fresh token to Colab (Colab never refreshes it itself).
ipcMain.handle("microsoft:push", async () => {
  const { msClientId, msRefresh } = readConfig();
  if (!msClientId || !msRefresh) return { ok: false };
  const r = await postForm(`${msAuthority()}/token`, { client_id: msClientId, grant_type: "refresh_token",
    refresh_token: msRefresh, scope: MS_LIGHT_SCOPES });
  if (!r.access_token) { writeConfig({ msRefresh: "" }); return { ok: false }; }
  return msHandOver(r);
});
ipcMain.handle("microsoft:forget", () => writeConfig({ msRefresh: "", msUser: "" }));

ipcMain.handle("api", (_e, method, route, body) => call(method, route, body));
ipcMain.handle("colab:start", () => startColab());
// Fallback: classic copy/paste of the cell into the user's own notebook.
ipcMain.handle("colab:external", () => startColabExternal());
ipcMain.handle("colab:copy", () => clipboard.writeText(buildCell(getToken())));
ipcMain.handle("open", (_e, url) => {
  // Only the handful of links the UI actually shows.
  if (/^https:\/\/(my\.telegram\.org|github\.com\/92EPK|drive\.google\.com|microsoft\.com\/devicelogin|login\.microsoft\.com\/device|entra\.microsoft\.com|cs-fgssr\.pages\.dev)/i.test(url)) shell.openExternal(url);
  else if (url.startsWith("mailto:B9x@outlook.com")) shell.openExternal(url);
});
ipcMain.handle("notify", (_e, title, body) => new Notification({ title, body }).show());
// Stop the computer from sleeping while transfers run; released as soon as the queue is idle.
let awakeId = null;
ipcMain.handle("power:keep-awake", (_e, on) => {
  if (on && awakeId === null) awakeId = powerSaveBlocker.start("prevent-app-suspension");
  else if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
});

// ------------------------------------------------------------ system tray
// Window behaviour chosen by the user in Settings, plus whether transfers are running.
const winPrefs = { trayMinimize: false, closeToTray: true };
let jobsActive = false;
let tray = null;
let quitting = false;
ipcMain.handle("jobs:active", (_e, on) => { jobsActive = Boolean(on); updateTray(); });
ipcMain.handle("window:prefs", (_e, p) => {
  winPrefs.trayMinimize = Boolean(p && p.trayMinimize);
  winPrefs.closeToTray = Boolean(p && p.closeToTray);
});

function showMain() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.setSkipTaskbar(false);
  mainWin.show();
  mainWin.focus();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(jobsActive ? "LectureSync · transferring…" : "LectureSync");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: jobsActive ? "Transfers running" : "No transfers running", enabled: false },
    { type: "separator" },
    { label: "Open LectureSync", click: showMain },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, "ui", "assets", "logo.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on("click", showMain);
  tray.on("double-click", showMain);
  updateTray();
}

function hideToTray(reason) {
  createTray();
  mainWin.hide();
  mainWin.setSkipTaskbar(true);
  if (reason && Notification.isSupported()) {
    new Notification({ title: "LectureSync is still running", body: reason }).show();
  }
}

// ------------------------------------------------------------ update check
// Asks GitHub for the latest release and compares it with this build. No
// auto-install: works the same for installer, portable, dmg and AppImage.
const RELEASES_API = "https://api.github.com/repos/92EPK/LectureSync/releases/latest";

function newerThan(a, b) {
  const pa = String(a).replace(/^v/i, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function pickAsset(assets) {
  const names = assets.map((a) => ({ a, n: a.name.toLowerCase() }));
  const arch = process.arch;
  const find = (fn) => (names.find(fn) || {}).a;
  if (process.platform === "win32") {
    const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
    return portable
      ? find(({ n }) => n.includes("portable") && n.endsWith(".exe"))
      : find(({ n }) => n.endsWith(".exe") && !n.includes("portable"));
  }
  if (process.platform === "darwin") {
    return find(({ n }) => n.endsWith(".dmg") && n.includes(arch)) || find(({ n }) => n.endsWith(".dmg"));
  }
  return find(({ n }) => n.endsWith(".appimage")) || find(({ n }) => n.endsWith(".deb"));
}

function checkForUpdate() {
  return new Promise((resolve) => {
    const req = https.get(RELEASES_API, {
      headers: { "User-Agent": "LectureSync/" + app.getVersion(), Accept: "application/vnd.github+json" },
      timeout: 10000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) return resolve({ ok: false, error: "GitHub replied " + res.statusCode });
          const r = JSON.parse(body);
          const latest = String(r.tag_name || "").replace(/^v/i, "");
          const current = app.getVersion();
          const asset = pickAsset(r.assets || []);
          resolve({
            ok: true, current, latest,
            available: Boolean(latest) && newerThan(latest, current),
            notes: String(r.body || "").slice(0, 4000),
            url: asset ? asset.browser_download_url : r.html_url,
            page: r.html_url,
          });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

ipcMain.handle("update:check", () => checkForUpdate());
ipcMain.handle("update:download", (_e, url) => {
  if (/^https:\/\/github\.com\/92EPK\/LectureSync\//i.test(String(url))) shell.openExternal(url);
});

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
    backgroundColor: "#07090c",
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
  mainWin.on("minimize", (e) => {
    if (!winPrefs.trayMinimize) return;
    e.preventDefault();
    hideToTray();
  });
  mainWin.on("close", (e) => {
    if (quitting || !winPrefs.closeToTray || !jobsActive) return;
    e.preventDefault();
    hideToTray("Your transfers keep going. Click the tray icon to open the app.");
  });
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

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => app.quit());
