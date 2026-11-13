// node apply-redesign.cjs
// بيعدّل app.js و main.cjs و preload.cjs. لو أي تعديل ملقاش مكانه بالظبط: مفيش حاجة بتتكتب.
const fs = require("fs");
const path = require("path");

const ICON_DOWN = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>';
const ICON_UP = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>';

const MAIN_CHROME = [
  'const CHROME = {',
  '  dark:  { color: "#0d1116", symbolColor: "#eef1f4" },',
  '  light: { color: "#e9edea", symbolColor: "#0d1512" },',
  '};',
  'ipcMain.handle("theme:set", (_e, t) => {',
  '  const theme = t === "light" ? "light" : "dark";',
  '  nativeTheme.themeSource = theme;',
  '  if (process.platform === "win32" && mainWin && !mainWin.isDestroyed())',
  '    mainWin.setTitleBarOverlay({ ...CHROME[theme], height: 40 });',
  '});',
  '',
  'function createMainWindow() {',
].join("\n");

const MAIN_WINDOW = [
  'const wa = screen.getPrimaryDisplay().workAreaSize;',
  '  mainWin = new BrowserWindow({',
  '    width: Math.min(1280, wa.width),',
  '    height: Math.min(820, wa.height),',
  '    minWidth: Math.min(980, wa.width),',
  '    minHeight: Math.min(640, wa.height),',
  '    backgroundColor: "#0b0e12",',
  '    ...(process.platform === "win32"',
  '      ? { titleBarStyle: "hidden", titleBarOverlay: { ...CHROME.dark, height: 40 } }',
  '      : {}),',
].join("\n");

const PLATFORM = [
  'const PLATFORM_NAME = {',
  '  sharepoint: "SharePoint / OneDrive", gdrive: "Google Drive", dropbox: "Dropbox",',
  '  mediafire: "MediaFire", youtube: "YouTube / video site", direct: "Direct link",',
  '};',
].join("\n");

const PLAN = {
  "ui/app.js": [
    ["win class", /const \$ = \(id\) => document\.getElementById\(id\);/,
      'const $ = (id) => document.getElementById(id);\nif (/Windows/.test(navigator.userAgent)) document.documentElement.classList.add("win");'],
    ["icons", /const ICONS = \{/,
      "const ICONS = {\n  download: '" + ICON_DOWN + "',\n  upload: '" + ICON_UP + "',"],
    ["accTg text", /\$\("accTg"\)\.textContent = signedIn[^\n]*/,
      '$("accTg").textContent = signedIn ? "Telegram" : "Telegram · sign in";'],
    ["accG text", /\$\("accG"\)\.textContent = d\.drive[^\n]*/,
      '$("accG").textContent = d.drive ? "Google Drive" : "Drive · not mounted";'],
    ["disk text", /\$\("diskText"\)\.textContent = `Colab disk[^\n]*/,
      '$("diskText").textContent = `Colab ${fmtSize(d.free)} free` +'],
    ["ms badge", /if \(s && s\.connected\) b\.textContent = [^\n]*/,
      'if (s && s.connected) { b.textContent = "Sign out"; b.title = (s.user || "Microsoft") + " · Sign out"; }'],
    ["ms chip", /a\.textContent = s && s\.connected \?[^\n]*/,
      'a.textContent = s && s.connected ? "OneDrive" : "OneDrive · Sign in";'],
    ["platform names", /const PLATFORM_NAME = \{[\s\S]*?\n\};/, PLATFORM],
    ["show app", /\$\("workspace"\)\.classList\.toggle\("hidden", !ready\);/,
      '$("app").classList.toggle("hidden", !ready);'],
    ["modeBar line", /\$\("modeBar"\)\.classList\.toggle\("hidden", !ready\);/, ""],
    ["keyboard guard", /\$\("workspace"\)\.classList\.contains\("hidden"\)/,
      '$("app").classList.contains("hidden")'],
    ["theme sync", /document\.documentElement\.dataset\.theme = t;/,
      'document.documentElement.dataset.theme = t;\n  Promise.resolve(ls.setTheme && ls.setTheme(t)).catch(() => {});'],
    ["saved columns", /saved\.length === 3/, "saved.length === 2"],
  ],
  "main.cjs": [
    ["electron imports", /const \{\s*app, BrowserWindow[\s\S]*?\} = require\("electron"\);/,
      'const {\n  app, BrowserWindow, ipcMain, safeStorage, Notification, clipboard, shell, dialog, powerSaveBlocker,\n  Tray, Menu, nativeImage, screen, nativeTheme,\n} = require("electron");'],
    ["theme handler", /function createMainWindow\(\) \{/, MAIN_CHROME],
    ["window options", /mainWin = new BrowserWindow\(\{\s*width: 1280,\s*height: 820,\s*minWidth: 980,\s*minHeight: 640,\s*backgroundColor: "#07090c",/, MAIN_WINDOW],
  ],
  "preload.cjs": [
    ["setTheme bridge", /notify: \(title, body\) => ipcRenderer\.invoke\("notify", title, body\),/,
      'notify: (title, body) => ipcRenderer.invoke("notify", title, body),\n  setTheme: (t) => ipcRenderer.invoke("theme:set", t),'],
  ],
};

const MARK = "/*redesign-applied*/";
const out = [];
for (const [file, edits] of Object.entries(PLAN)) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) throw new Error("File not found: " + file + " (run this from the project root)");
  const raw = fs.readFileSync(p, "utf8");
  if (raw.includes(MARK)) { console.log("already patched, skipped:", file); continue; }
  const crlf = raw.includes("\r\n");
  let s = raw.replace(/\r\n/g, "\n");
  for (const [name, re, to] of edits) {
    const hits = s.match(new RegExp(re.source, "g")) || [];
    if (hits.length !== 1) throw new Error(`${file}: step "${name}" matched ${hits.length} times (expected 1). Nothing was written.`);
    s = s.replace(re, () => to);
  }
  s += "\n" + MARK + "\n";
  if (crlf) s = s.replace(/\n/g, "\r\n");
  out.push([p, raw, s]);
}
for (const [p, raw, s] of out) {
  fs.writeFileSync(p + ".bak", raw);
  fs.writeFileSync(p, s);
  console.log("patched:", path.relative(__dirname, p), "(backup: .bak)");
}
console.log("Done. Now run: npm start");