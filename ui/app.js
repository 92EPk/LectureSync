// Lecture Sync UI - Ahmed Omran <B9x@outlook.com>
// Wrapped in a function so local names never collide with the `ls` global the preload exposes.
(() => {
const $ = (id) => document.getElementById(id);
if (/Windows/.test(navigator.userAgent)) document.documentElement.classList.add("win");
// If the bridge is missing, keep the page alive with a stub so every button still
// gets wired; calls that need the main process then show a clear error instead.
const bridgeMissing = !window.ls;
const ls = window.ls || new Proxy({}, {
  get: (_t, key) => (String(key).startsWith("on")
    ? () => {}
    : () => Promise.reject(new Error("Internal bridge not loaded. Press F12 and check the Console."))),
});
if (bridgeMissing) {
  const bar = document.createElement("div");
  bar.className = "bridge-error";
  bar.textContent = "Lecture Sync could not start its internal bridge. Press F12 to see the error.";
  document.body.prepend(bar);
  console.error("window.ls is undefined: preload.cjs did not load");
}
const api = ls.api;

let cwd = localStorage.getItem("ls-last-folder") || "";
// Last folder opened in each cloud, so "Copy to other cloud" knows where to go.
const lastIn = { g: localStorage.getItem("ls-last-g") || "", ms: localStorage.getItem("ls-last-ms") || "ms:" };
const isMs = (p) => typeof p === "string" && p.startsWith("ms:");
let msLabel = "";
// Human name for any destination: "/My Drive/x" or "OneDrive › Library › x".
function placeName(p, label) {
  if (!isMs(p)) return "/" + (p || "My Drive");
  const rest = p.slice(3).split("/").slice(1).join("/");
  return `${label || "OneDrive / SharePoint"}${rest ? " › " + rest.replace(/\//g, " › ") : ""}`;
}
let connected = false;
let signedIn = false;
const seenDone = new Set();

// ------------------------------------------------ small helpers

const ICONS = {
  cloud: '<path d="M17.5 19H8a5 5 0 1 1 1.6-9.7A6 6 0 0 1 21 12.5 3.5 3.5 0 0 1 17.5 19z"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  colab: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  drive: '<path d="M8 3h8l6 10-4 7H6l-4-7z"/><path d="M8 3l6 10H2M16 3l-6 10 4 7"/>',
  jobs: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  video: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="m16 10 6-3v10l-6-3"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  pdf: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 14h8M8 17h5"/>',
  archive: '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>',
};
const svg = (name, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;

for (const n of document.querySelectorAll("[data-icon]")) n.insertAdjacentHTML("afterbegin", svg(n.dataset.icon));

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}
const icon = (name) => {
  const s = el("span");
  s.innerHTML = svg(name, "ico");
  return s.firstChild;
};

const fmtSize = (b) => {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
};

function fileKind(name) {
  if (/\.(mp4|mkv|mov|avi|webm|m4v|wmv|flv)$/i.test(name)) return "video";
  if (/\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i.test(name) || /\.(\d{3}|z\d{2}|r\d{2})$/i.test(name) || /\.part\d+\.rar$/i.test(name)) return "archive";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.(docx?|pptx?|xlsx?|txt|odt|odp|ods|rtf|csv|md|epub)$/i.test(name)) return "doc";
  if (/\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|wma)$/i.test(name)) return "audio";
  if (/\.(jpe?g|png|webp|gif|bmp|heic|svg|tiff?)$/i.test(name)) return "image";
  return "file";
}
const KIND_LABEL = { video: "Video", archive: "Archive", pdf: "PDF", doc: "Doc", audio: "Audio", image: "Image" };
const kindBadge = (name) => { const k = fileKind(name); return KIND_LABEL[k] ? el("span", { className: "kbadge k-" + k, textContent: KIND_LABEL[k] }) : ""; };
const fileIcon = (name) => { const k = fileKind(name); return ["doc", "audio", "image"].includes(k) ? "file" : k; };
// "Lec 1.part2.rar" -> "lec 1": used to spot volumes of one split archive.
const archiveBase = (n) => n.replace(/\.(part\d+\.rar|\d{3}|z\d{2}|r\d{2})$/i, "").replace(/\.(zip|rar|7z)$/i, "").toLowerCase();
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; } };

let toastTimer;
function toast(text, isError = false) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast" + (isError ? " error" : "");
  // Popover puts the toast in the top layer, above open dialogs and their backdrop.
  try { if (t.showPopover) { if (t.matches(":popover-open")) t.hidePopover(); t.showPopover(); } } catch {}
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.add("hidden"); try { t.hidePopover?.(); } catch {} }, 4500);
}

function ask(text, value = "") {
  return new Promise((resolve) => {
    const d = $("prompt");
    $("promptText").textContent = text;
    $("promptInput").value = value ?? "";
    $("promptInput").classList.toggle("hidden", value === null);
    d.onclose = () => resolve(d.returnValue === "ok" ? $("promptInput").value : null);
    d.returnValue = "";
    $("promptCancel").onclick = () => d.close("cancel");
    d.showModal();
  });
}

async function guard(fn) {
  try { return await fn(); } catch (e) { toast(cleanError(e), true); }
}
// IPC wraps errors as "Error invoking remote method 'api': Error: ..."
const cleanError = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

for (const a of document.querySelectorAll("[data-open]")) {
  a.onclick = (e) => { e.preventDefault(); ls.open(a.dataset.open); };
}

// ------------------------------------------------ setup flow

function setStatus(text, kind) {
  $("status").textContent = text;
  $("status").className = "pill" + (kind ? " " + kind : "");
}

function setStep(n, state) {
  const s = $("step" + n);
  s.classList.remove("active", "complete", "locked");
  if (state) s.classList.add(state);
  const p = $("prog" + n);
  if (p) { p.classList.remove("active", "complete", "locked"); if (state) p.classList.add(state); }
}

async function renderSetup() {
  const cfg = await ls.getConfig();
  const hasKeys = Boolean(cfg.apiId && cfg.hasApiHash);
  $("step1Done").classList.toggle("hidden", !hasKeys);

  setStep(1, hasKeys ? "complete" : "active");
  setStep(2, !hasKeys ? "locked" : connected ? "complete" : "active");
  setStep(3, !connected ? "locked" : signedIn ? "complete" : "active");
  $("startColab").disabled = !hasKeys;
  const needQr = connected && !signedIn;
  $("tgLogin").classList.toggle("hidden", !needQr);
  // Show the code right away instead of waiting for a click.
  if (needQr && !qrTimer && !qrBusy && $("qrPwBox").classList.contains("hidden")) guard(startQr);
  if (!needQr) stopQr();

  const ready = connected && signedIn;
  $("onboarding").classList.toggle("hidden", ready);
  $("app").classList.toggle("hidden", !ready);
  
  $("disconnect").classList.toggle("hidden", !connected);
  return hasKeys;
}

const STAGES = {
  browser: "Waiting for the engine in your browser…",
  linking: "Linking to your cloud engine…",
  external: "",
};
ls.onStage((stage) => {
  setStatus("Starting Colab…", "wait");
  $("stageText").textContent = STAGES[stage] || "";
  $("externalHelp").classList.toggle("hidden", stage !== "external");
});
ls.onConnected(() => {
  toast("Connected to Colab.");
  $("stageText").textContent = "";
  boot();
});
ls.onLinkError((msg) => toast(msg, true));

// ------------------------------------------------ status

let failStreak = 0;
async function refreshStatus(fresh = false) {
  try {
    const h = await api("GET", "/health");
    const d = await api("GET", fresh ? "/disk?refresh=1" : "/disk");
    failStreak = 0;
    connected = true;
    signedIn = Boolean(h.telegram);
    setStatus(signedIn ? "Connected" : "Connected · Telegram sign-in needed", signedIn ? "on" : "wait");
    $("disk").classList.remove("hidden");
    $("accounts").classList.remove("hidden");
    $("accTg").classList.toggle("ok", signedIn);
    $("accTg").textContent = signedIn ? "Telegram" : "Telegram · sign in";
    $("accG").classList.toggle("ok", Boolean(d.drive));
    $("accG").textContent = d.drive ? "Google Drive" : "Google Drive · not mounted";
    const pct = (q) => q && q.total ? Math.min(100, Math.round((q.used / q.total) * 100)) : 0;
    $("diskText").textContent = `Colab ${fmtSize(d.free)} free`;
    $("diskFill").style.width = `${pct(d)}%`;
    $("dkDrive").classList.toggle("hidden", !d.drive);
    if (d.drive) { $("driveText").textContent = `Google Drive ${fmtSize(d.drive.free)} free`; $("driveFill").style.width = `${pct(d.drive)}%`; }
    $("dkMs").classList.toggle("hidden", !d.onedrive);
    if (d.onedrive) { $("msText").textContent = `OneDrive ${fmtSize(d.onedrive.free)} free`; $("msFill").style.width = `${pct(d.onedrive)}%`; }
    return h;
  } catch {
    // Tolerate brief tunnel hiccups: only drop after 3 failures in a row.
    failStreak++;
    if (connected && failStreak < 3) return null;
    connected = false;
    signedIn = false;
    if (!$("status").classList.contains("wait")) setStatus("Not connected");
    $("disk").classList.add("hidden");
    return null;
  }
}

// ------------------------------------------------ telegram

let allChats = [];
// Narrow the chat dropdown while typing; picks the first match so its files load right away.
function filterChats(q) {
  const s = q.trim().toLowerCase();
  const cur = $("chat").value;
  const list = s ? allChats.filter((c) => String(c.title).toLowerCase().includes(s)) : allChats;
  $("chat").replaceChildren(...list.map((c) => el("option", { value: c.id, textContent: c.title })));
  if (!list.length) {
    tgList = [];
    selected.clear();
    $("tgFiles").replaceChildren(el("li", { className: "muted", textContent: "No matching chats" }));
    return;
  }
  if (list.some((c) => String(c.id) === cur)) $("chat").value = cur;
  else guard(loadTgFiles);
}

async function loadChats() {
  const chats = await api("GET", "/telegram/chats");
  const prev = $("chat").value;
  allChats = chats;
  $("chatSearch").value = "";
  $("chat").replaceChildren(...chats.map((c) => el("option", { value: c.id, textContent: c.title })));
  const want = prev || localStorage.getItem("ls-last-chat");
  if (want && chats.some((c) => String(c.id) === want)) $("chat").value = want;
  if (chats.length) await loadTgFiles();
}

let tgList = [];
const selected = new Map(); // message id -> file
let kind = "all";

async function loadTgFiles() {
  const chatId = $("chat").value;
  if (!chatId) return;
  localStorage.setItem("ls-last-chat", chatId);
  const q = tgQuery.trim();
  const files = await api("GET", `/telegram/files?chat_id=${chatId}${q ? `&q=${encodeURIComponent(q)}&limit=200` : ""}`);
  tgList = files;
  selected.clear();
  renderTgFiles(chatId);
}

function renderTgFiles(chatId) {
  const files = tgList;
  $("tgEmpty").classList.toggle("hidden", files.length > 0);
  $("tgFiles").replaceChildren(...files.map((f) => {
    const pick = el("input", { type: "checkbox", className: "pick", title: "Select" });
    pick.checked = selected.has(f.id);
    pick.onchange = () => { pick.checked ? selected.set(f.id, f) : selected.delete(f.id); renderSel(); };
    const send = el("button", { className: "primary small", textContent: "Send", title: "Send to the open cloud folder" });
    send.onclick = () => guard(() => sendFiles(Number(chatId), [f]));
    const sub = [fmtDate(f.date), f.caption].filter(Boolean).join(" · ");
    const li = el("li", { className: "kind-" + fileKind(f.name) },
      pick, icon(fileIcon(f.name)),
      el("div", { className: "info" },
        el("span", { className: "name", textContent: f.name, title: f.name }),
        sub ? el("div", { className: "subrow" },
          el("span", { className: "sub", textContent: sub, title: f.caption || "" }),
          f.caption ? copyBtn(f.caption) : "") : ""),
      kindBadge(f.name),
      el("span", { className: "meta", textContent: fmtSize(f.size) }),
      send);
    li.dataset.kind = fileKind(f.name);
    return li;
  }));
  applyKind();
  renderSel();
  if (!tgQuery) filterList("tgFiles", $("tgSearch").value);
}

function copyBtn(text) {
  const b = el("button", { className: "copy-cap", type: "button", title: "Copy caption", ariaLabel: "Copy caption" });
  b.append(icon("copy"));
  b.onclick = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); toast("Description copied."); }
    catch { toast("Couldn't copy. Select the text and press Ctrl+C.", true); }
  };
  return b;
}

// Draggable column splitters; widths are remembered.
(function initSplitters() {
  const ws = $("workspace");
  const saved = JSON.parse(localStorage.getItem("ls-cols") || "null");
  const apply = (c) => c.forEach((v, i) => ws.style.setProperty(`--c${i + 1}`, v + "fr"));
  if (Array.isArray(saved) && saved.length === 2) apply(saved);
  for (const sp of ws.querySelectorAll(".splitter")) {
    sp.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const panes = [...ws.querySelectorAll(":scope > .pane")];
      const w = panes.map((p) => p.getBoundingClientRect().width);
      const i = Number(sp.dataset.split), x0 = e.clientX, min = 220;
      const pair = w[i] + w[i + 1];
      sp.setPointerCapture(e.pointerId);
      sp.classList.add("dragging"); document.body.classList.add("resizing");
      const move = (ev) => {
        const a = Math.max(min, Math.min(pair - min, w[i] + ev.clientX - x0));
        const c = [...w]; c[i] = a; c[i + 1] = pair - a;
        apply(c); localStorage.setItem("ls-cols", JSON.stringify(c));
      };
      const up = () => {
        sp.removeEventListener("pointermove", move); sp.removeEventListener("pointerup", up);
        sp.classList.remove("dragging"); document.body.classList.remove("resizing");
      };
      sp.addEventListener("pointermove", move); sp.addEventListener("pointerup", up);
    });
    sp.addEventListener("dblclick", () => { localStorage.removeItem("ls-cols"); ["--c1","--c2","--c3"].forEach((k) => ws.style.removeProperty(k)); });
  }
})();

// Vertical splitter above the Jobs drawer; height is remembered.
(function initRowSplitter() {
  const sp = $("jobsSplit"), ws = $("workspace");
  if (!sp) return;
  const set = (h) => ws.style.setProperty("--jobs-h", h + "px");
  const saved = Number(localStorage.getItem("ls-jobs-h"));
  if (saved) set(saved);
  sp.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const h0 = $("jobsPane").getBoundingClientRect().height, y0 = e.clientY;
    const max = ws.getBoundingClientRect().height - 220;
    sp.setPointerCapture(e.pointerId);
    sp.classList.add("dragging"); document.body.classList.add("resizing-v");
    if (document.body.classList.contains("jobs-min")) $("toggleJobs").click();
    const move = (ev) => {
      const h = Math.round(Math.max(90, Math.min(max, h0 - (ev.clientY - y0))));
      set(h); localStorage.setItem("ls-jobs-h", String(h));
    };
    const up = () => {
      sp.removeEventListener("pointermove", move); sp.removeEventListener("pointerup", up);
      sp.classList.remove("dragging"); document.body.classList.remove("resizing-v");
    };
    sp.addEventListener("pointermove", move); sp.addEventListener("pointerup", up);
  });
  sp.addEventListener("dblclick", () => { localStorage.removeItem("ls-jobs-h"); ws.style.removeProperty("--jobs-h"); });
})();

function applyKind() {
  for (const li of $("tgFiles").children) li.classList.toggle("kind-out", kind !== "all" && li.dataset.kind !== kind);
}

function renderSel() {
  $("selBar").classList.toggle("hidden", selected.size === 0);
  const total = [...selected.values()].reduce((a, f) => a + f.size, 0);
  $("selCount").textContent = `${selected.size} selected · ${fmtSize(total)}`;
}

// Opens the options dialog, then queues one job (or one per file).
function sendDialog(files) {
  return new Promise((resolve) => {
    const d = $("sendDlg");
    const where = placeName(cwd, msLabel);
    const archives = files.filter((f) => fileKind(f.name) === "archive");
    const sameBase = archives.length > 1 && archives.length === files.length &&
      new Set(archives.map((f) => archiveBase(f.name))).size === 1;
    $("sendWhat").textContent = files.length === 1
      ? `"${files[0].name}" (${fmtSize(files[0].size)}) → ${where}`
      : `${files.length} files (${fmtSize(files.reduce((a, f) => a + f.size, 0))}) → ${where}`;
    $("renameBox").classList.toggle("hidden", files.length !== 1);
    $("sendRename").value = files.length === 1 ? files[0].name : "";
    $("archiveOpts").classList.toggle("hidden", archives.length === 0);
    $("multiBox").classList.toggle("hidden", archives.length < 2);
    $("sendMulti").checked = sameBase;
    $("sendExtract").checked = true;
    $("sendSub").checked = false;
    $("sendPw").value = "";
    $("sendCompress").checked = false;
    d.onclose = () => resolve(d.returnValue === "ok" ? {
      rename: $("sendRename").value.trim(),
      extract: $("sendExtract").checked,
      multi: $("sendMulti").checked && archives.length > 1,
      subfolder: $("sendSub").checked,
      password: $("sendPw").value || null,
      compress: $("sendCompress").checked,
    } : null);
    d.returnValue = "";
    d.showModal();
  });
}

async function sendFiles(chatId, files) {
  const o = await sendDialog(files);
  if (!o) return false;
  const base = { chat_id: chatId, dest: cwd, extract: o.extract, subfolder: o.subfolder, password: o.password, compress: o.compress };
  if (o.multi) {
    // Volumes in name order so part1 / .001 goes first; 7z picks up the rest from the same folder.
    const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    await api("POST", "/jobs", { ...base, message_id: ordered[0].id, extra_ids: ordered.slice(1).map((f) => f.id) });
  } else {
    for (const f of files) {
      const rename = files.length === 1 && o.rename && o.rename !== f.name ? o.rename : null;
      await api("POST", "/jobs", { ...base, message_id: f.id, rename });
    }
  }
  toast(files.length === 1 || o.multi ? "Added to jobs." : `Added ${files.length} jobs.`);
  loadJobs();
  return true;
}

// ------------------------------------------------ drive

function renderCrumb() {
  if (isMs(cwd)) {
    const [drive, ...parts] = cwd.slice(3).split("/").filter((x, i) => i === 0 || x);
    const nodes = [el("button", { textContent: "Microsoft", onclick: () => guard(() => loadDrive("ms:")) })];
    if (drive) {
      nodes.push(el("span", { textContent: "›" }), el("button", { textContent: msLabel || "Library", onclick: () => guard(() => loadDrive(`ms:${drive}`)) }));
      parts.forEach((p, i) => {
        const target = `ms:${drive}/` + parts.slice(0, i + 1).join("/");
        nodes.push(el("span", { textContent: "›" }), el("button", { textContent: p, onclick: () => guard(() => loadDrive(target)) }));
      });
    }
    return $("crumb").replaceChildren(...nodes);
  }
  const parts = cwd ? cwd.split("/") : [];
  const nodes = [el("button", { textContent: "My Drive", onclick: () => guard(() => loadDrive("")) })];
  parts.forEach((p, i) => {
    const target = parts.slice(0, i + 1).join("/");
    nodes.push(el("span", { textContent: "›" }), el("button", { textContent: p, onclick: () => guard(() => loadDrive(target)) }));
  });
  $("crumb").replaceChildren(...nodes);
}

function parentOf(p) {
  if (!isMs(p)) return p.split("/").slice(0, -1).join("/");
  const segs = p.slice(3).split("/");
  return segs.length <= 1 ? "ms:" : "ms:" + segs.slice(0, -1).join("/");
}

function showProvider(ms) {
  $("provG").classList.toggle("on", !ms);
  $("provMs").classList.toggle("on", ms);
  $("cloudTitle").textContent = ms ? "OneDrive / SharePoint" : "Google Drive";
  // Tab names and the link destination follow whichever cloud is open.
  for (const n of document.querySelectorAll(".cloudName")) n.textContent = ms ? "OneDrive" : "Google Drive";
  const cur = document.querySelector('input[name="linkTo"]:checked');
  if (cur && cur.value !== "telegram") document.querySelector(`input[name="linkTo"][value="${ms ? "ms" : "g"}"]`).checked = true;
}

// ------------------------------------------------ microsoft account

async function msStatus() { return api("GET", "/ms/status"); }

// Remembered Microsoft sign-in state: skips a status round-trip on every tab click.
// The worker still answers 428 if the session is gone, which resets this and asks to sign in again.
let msConnected = false;
async function msRefreshBadge() {
  const s = await msStatus().catch(() => null);
  if (s) msConnected = Boolean(s.connected);
  const b = $("msAccount");
  b.classList.toggle("hidden", !(s && s.connected) || !isMs(cwd));
  if (s && s.connected) { b.textContent = "Sign out"; b.title = (s.user || "Microsoft") + " · Sign out"; }
  const a = $("accMs");
  a.classList.toggle("ok", Boolean(s && s.connected));
  a.textContent = s && s.connected ? "OneDrive" : "OneDrive · Sign in";
  a.title = s && s.connected ? "OneDrive / SharePoint connected — click to open" : "Sign in to OneDrive / SharePoint";
  return s;
}

async function msConnect() {
  if (msConnected) return true;
  await ls.configureMicrosoft?.().catch(() => null);
  let s = await msStatus();
  if (s.connected) { msConnected = true; return true; }
  const cfg = await ls.getConfig();
  if (ls.msBrowserLogin) {
    // Custom app only (needs http://localhost registered as a redirect URI). Sign in from this PC's own browser: Microsoft sees the user's own IP/device (no "United States" warning),
    // and personal Outlook accounts work. Falls back to the device code only if the browser sign-in fails.
    if ((await ls.msPush().catch(() => null))?.ok) { msConnected = true; return true; }
    toast("Finish signing in to Microsoft in your browser…");
    const r = await ls.msBrowserLogin().catch((e) => { toast(cleanError(e), true); return null; });
    if (r) {
      msConnected = true;
      toast(`Connected to Microsoft${r.user ? " as " + r.user : ""}.`);
      return true;
    }
    if (cfg.msMode === "custom" && cfg.msClientId) return false;
  }
  const r = await api("POST", "/ms/auth/start");
  $("msCode").textContent = r.user_code;
  $("msState").textContent = "Waiting for you to sign in…";
  $("msOpen").onclick = () => guard(() => ls.open(r.verification_uri));
  $("msCopy").onclick = () => { navigator.clipboard.writeText(r.user_code); toast("Code copied."); };
  const d = $("msDlg");
  d.showModal();
  await ls.open(r.verification_uri).catch((e) => toast(cleanError(e), true));
  const until = Date.now() + r.expires_in * 1000;
  while (d.open && Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, 3000));
    s = await msStatus().catch(() => s);
    if (s.connected) { msConnected = true; d.close(); toast(`Connected to Microsoft${s.user ? " as " + s.user : ""}.`); return true; }
    if (s.flow && s.flow.state === "error") { $("msState").textContent = "Sign-in failed: " + s.flow.error; return false; }
  }
  if (d.open) $("msState").textContent = "The code expired. Close and try again.";
  return false;
}

const driveCache = new Map(); // folder path -> last listing, shown instantly while a fresh one loads
let driveSeq = 0;              // only the newest request may draw the list (fast tab clicks)
const isMsAuthErr = (e) => /not connected|sign-in expired|sign in again/i.test(cleanError(e));

async function switchProvider(ms) {
  if (ms === isMs(cwd)) return;
  const prev = isMs(cwd);
  const target = ms ? lastIn.ms : lastIn.g;
  showProvider(ms); // tab lights up immediately
  if (ms && !(await msConnect())) { showProvider(prev); return; }
  const cached = driveCache.get(target || (ms ? "ms:" : ""));
  if (cached) renderDrive(cached);
  try {
    await loadDrive(target);
  } catch (e) {
    if (ms && isMsAuthErr(e)) {
      msConnected = false;
      if (await msConnect()) return loadDrive(target);
    }
    if (!cached) showProvider(prev);
    throw e;
  }
}

async function loadDrive(path = cwd) {
  const my = ++driveSeq;
  let res;
  try {
    res = await api("GET", `/drive/list?path=${encodeURIComponent(path)}`);
  } catch (e) {
    if (my !== driveSeq) return;
    if (isMs(path) && isMsAuthErr(e)) msConnected = false;
    if (!path || isMsAuthErr(e)) throw e;
    res = await api("GET", "/drive/list?path="); // remembered folder no longer exists
  }
  if (my !== driveSeq) return; // a newer click already took over
  driveCache.set(path || "", res);
  driveCache.set(res.path, res);
  renderDrive(res);
}

function renderDrive(res) {
  const samePlace = res.path === cwd;
  const keep = samePlace ? new Map(driveSel) : new Map();
  cwd = res.path;
  msLabel = res.label || "";
  const ms = isMs(cwd);
  lastIn[ms ? "ms" : "g"] = cwd;
  localStorage.setItem(ms ? "ls-last-ms" : "ls-last-g", cwd);
  showProvider(ms);
  msRefreshBadge();
  linkDriveNote();
  localStorage.setItem("ls-last-folder", cwd);
  renderCrumb();
  $("driveWarn").classList.toggle("hidden", res.mounted !== false);
  $("driveEmpty").classList.toggle("hidden", res.items.length > 0);
  driveSel.clear();
  driveItems = res.items.map((it) => ({ ...it, full: it.path || (cwd && cwd !== "ms:" ? `${cwd}/${it.name}` : it.name) }));
  $("driveList").replaceChildren(...driveItems.map((it) => {
    const full = it.full;
    const name = el("span", { className: "name", textContent: it.name, title: it.name });
    if (it.dir) name.onclick = () => guard(() => loadDrive(full));

    const ren = el("button", { className: "ghost small", textContent: "Rename" });
    ren.onclick = () => guard(async () => {
      const nn = await ask("New name:", it.name);
      if (nn && nn.trim() && nn !== it.name) {
        await api("POST", "/drive/rename", { path: full, new_name: nn.trim() });
        loadDrive();
      }
    });

    const del = el("button", { className: "ghost small danger", textContent: "Delete" });
    del.onclick = () => guard(async () => {
      // Typing the name back is deliberate friction; a misclick here can wipe a whole course folder.
      const typed = await ask(`Type "${it.name}" to delete it${it.dir ? " and everything inside" : ""}. It goes to the ${isMs(cwd) ? "recycle bin" : "Google Drive trash"}.`, "");
      if (typed === null) return;
      if (typed !== it.name) return toast("Name didn't match, nothing was deleted.", true);
      await api("POST", "/drive/delete", { path: full });
      toast(isMs(cwd) ? "Moved to the recycle bin." : "Moved to Google Drive trash.");
      loadDrive();
    });

    if (it.library) { ren.disabled = true; del.disabled = true; }
    const pick = el("input", { type: "checkbox", className: "pick", title: "Select to send or copy" });
    if (it.library) pick.disabled = true;
    const li = el("li", { className: it.dir ? "dir" : "kind-" + fileKind(it.name) },
      pick, icon(it.dir ? "folder" : fileIcon(it.name)), name,
      it.dir ? "" : kindBadge(it.name),
      el("span", { className: "meta", textContent: it.dir ? "folder" : fmtSize(it.size) }),
      el("span", { className: "actions" }, ren, del));
    if (keep.has(full)) { pick.checked = true; driveSel.set(full, it); li.classList.add("picked"); }
    pick.onchange = () => {
      pick.checked ? driveSel.set(full, it) : driveSel.delete(full);
      li.classList.toggle("picked", pick.checked);
      renderDriveSel();
    };
    return li;
  }));
  renderDriveSel();
  filterList("driveList", $("driveSearch").value);
  if (mode === "c2c" && (c2cPath === null || isMs(c2cPath) !== (c2cDst() === "ms"))) loadC2cDest().catch(() => {});
}

// ------------------------------------------------ direction mode + drive selection

let driveItems = [];
const driveSel = new Map(); // Drive path -> item
let mode = ["drive2tg", "link", "c2c"].includes(localStorage.getItem("ls-mode")) ? localStorage.getItem("ls-mode") : "tg2drive";

function renderDriveSel() {
  const on = mode === "drive2tg" && driveSel.size > 0;
  $("driveSelBar").classList.toggle("hidden", !["drive2tg", "c2c"].includes(mode) && driveSel.size === 0);
  $("driveSelSend").classList.toggle("hidden", mode !== "drive2tg");
  const files = [...driveSel.values()];
  const total = files.filter((f) => !f.dir).reduce((a, f) => a + (f.size || 0), 0);
  const dirs = files.filter((f) => f.dir).length;
  $("driveSelCount").textContent = driveSel.size
    ? `${driveSel.size} selected · ${fmtSize(total)}${dirs ? ` + ${dirs} folder${dirs > 1 ? "s" : ""}` : ""}`
    : mode === "drive2tg" ? "Tick files or folders to send" : mode === "c2c" ? "Tick files or folders to copy" : "Tick files or folders";
  $("driveSelSend").disabled = !on;
  $("driveSelClear").disabled = !driveSel.size;
  $("driveSelDel").classList.toggle("hidden", !driveSel.size);
  $("driveSelDel").lastChild.textContent = driveSel.size ? ` Delete ${driveSel.size}` : " Delete";
  renderC2c();
}

// ------------------------------------------------ cloud -> cloud
// Left pane = source cloud (the normal Drive browser). Right pane = the other cloud, browsed independently.
var cloudLabel = (k) => (k === "ms" ? "OneDrive" : "Google Drive");
var c2cDst = () => (isMs(cwd) ? "g" : "ms");
var c2cPath = null, c2cLabel = "", c2cSeq = 0;
function c2cParent(p) {
  if (isMs(p)) { const r = p.slice(3); return r.includes("/") ? "ms:" + r.slice(0, r.lastIndexOf("/")) : "ms:"; }
  return p && p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
}
async function loadC2cDest(path) {
  if (mode !== "c2c") return;
  const dst = c2cDst();
  if (path === undefined) path = lastIn[dst];
  const my = ++c2cSeq;
  $("c2cTo").textContent = cloudLabel(dst);
  if (dst === "ms" && !msConnected) await msStatus().then((s) => { msConnected = Boolean(s && s.connected); }).catch(() => {});
  if (my !== c2cSeq) return;
  const needConnect = dst === "ms" && !msConnected;
  $("c2cConnectRow").classList.toggle("hidden", !needConnect);
  if (needConnect) { c2cPath = null; $("c2cList").replaceChildren(); $("c2cCrumb").replaceChildren(); $("c2cEmpty").classList.add("hidden"); return renderC2c(); }
  let res;
  try { res = await api("GET", `/drive/list?path=${encodeURIComponent(path)}`); }
  catch (e) { if (my !== c2cSeq) return; res = await api("GET", `/drive/list?path=${dst === "ms" ? "ms%3A" : ""}`); }
  if (my !== c2cSeq) return;
  c2cPath = res.path; c2cLabel = res.label || "";
  lastIn[dst] = c2cPath;
  localStorage.setItem(dst === "ms" ? "ls-last-ms" : "ls-last-g", c2cPath);
  const parts = [];
  if (isMs(c2cPath)) {
    const [drive, ...rest] = c2cPath.slice(3).split("/").filter((x, i) => i === 0 || x);
    parts.push(["Microsoft", "ms:"]);
    if (drive) { parts.push([c2cLabel || "Library", `ms:${drive}`]); rest.forEach((x, i) => parts.push([x, `ms:${drive}/` + rest.slice(0, i + 1).join("/")])); }
  } else {
    parts.push(["My Drive", ""]);
    const rest = c2cPath ? c2cPath.split("/") : [];
    rest.forEach((x, i) => parts.push([x, rest.slice(0, i + 1).join("/")]));
  }
  const nodes = [];
  parts.forEach(([t, target], i) => { if (i) nodes.push(el("span", { textContent: "›" })); nodes.push(el("button", { textContent: t, onclick: () => guard(() => loadC2cDest(target)) })); });
  $("c2cCrumb").replaceChildren(...nodes);
  const items = [...res.items].sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0));
  $("c2cEmpty").classList.toggle("hidden", items.length > 0);
  c2cSel.clear();
  $("c2cList").replaceChildren(...items.map((it) => {
    const full = it.path || (c2cPath && c2cPath !== "ms:" ? `${c2cPath}/${it.name}` : it.name);
    const name = el("span", { className: "name", textContent: it.name, title: it.name });
    const pick = el("input", { type: "checkbox", className: "pick", title: "Select" });
    const ren = el("button", { className: "ghost small", textContent: "Rename" });
    const del = el("button", { className: "ghost small danger", textContent: "Delete" });
    if (it.library) { pick.disabled = ren.disabled = del.disabled = true; }
    for (const b of [pick, ren, del]) b.addEventListener("click", (e) => e.stopPropagation());
    ren.onclick = () => guard(async () => {
      const nn = await ask("New name:", it.name);
      if (nn && nn.trim() && nn !== it.name) { await api("POST", "/drive/rename", { path: full, new_name: nn.trim() }); await loadC2cDest(c2cPath); }
    });
    del.onclick = () => guard(async () => {
      const typed = await ask(`Type "${it.name}" to delete it${it.dir ? " and everything inside" : ""}. It goes to the ${isMs(full) ? "recycle bin" : "Google Drive trash"}.`, "");
      if (typed === null) return;
      if (typed !== it.name) return toast("Name didn't match, nothing was deleted.", true);
      await api("POST", "/drive/delete", { path: full });
      toast(isMs(full) ? "Moved to the recycle bin." : "Moved to Google Drive trash.");
      await loadC2cDest(c2cPath);
    });
    const li = el("li", { className: it.dir ? "dir" : "kind-" + fileKind(it.name) },
      pick, icon(it.dir ? "folder" : fileIcon(it.name)), name, it.dir ? "" : kindBadge(it.name),
      el("span", { className: "meta", textContent: it.dir ? "folder" : fmtSize(it.size) }),
      el("span", { className: "actions" }, ren, del));
    pick.onchange = () => { pick.checked ? c2cSel.set(full, it) : c2cSel.delete(full); li.classList.toggle("picked", pick.checked); renderC2cSel(); };
    if (it.dir) li.onclick = () => guard(() => loadC2cDest(full));
    return li;
  }));
  renderC2cSel();
  renderC2c();
}
function renderC2c() {
  if (!$("c2cBody")) return;
  const dst = c2cDst();
  const ok = c2cPath !== null && c2cPath !== "ms:" && isMs(c2cPath) === (dst === "ms");
  const items = [...driveSel.values()];
  const total = items.filter((f) => !f.dir).reduce((a, f) => a + (f.size || 0), 0);
  $("c2cWhat").textContent = !ok ? (dst === "ms" ? "Open a OneDrive / SharePoint folder" : "Open a folder")
    : items.length ? `${items.length} item${items.length > 1 ? "s" : ""}${total ? " · " + fmtSize(total) : ""} → ${placeName(c2cPath, c2cLabel)}`
    : `Into ${placeName(c2cPath, c2cLabel)} · tick files on the left`;
  const btn = $("c2cStart");
  btn.disabled = !ok || !items.length;
  btn.lastChild.textContent = items.length ? ` Copy ${items.length}` : " Copy";
  if ($("c2cCompress")) renderC2cCompress();
  $("c2cUp").disabled = c2cPath === null || (isMs(c2cPath) ? c2cPath === "ms:" : !c2cPath);
}
var c2cSel = new Map(); // destination path -> item
function renderC2cSel() {
  const n = c2cSel.size;
  $("c2cSelCount").textContent = n ? `${n} selected in destination` : "Manage this folder";
  $("c2cSelClear").disabled = !n;
  $("c2cSelDel").classList.toggle("hidden", !n);
}
$("c2cSelAll").onclick = () => { for (const b of $("c2cList").querySelectorAll("input.pick:not(:disabled)")) if (!b.checked) { b.checked = true; b.onchange(); } };
$("c2cSelClear").onclick = () => { for (const b of $("c2cList").querySelectorAll("input.pick:checked")) { b.checked = false; b.onchange(); } };
$("c2cSelDel").onclick = () => guard(async () => {
  const items = [...c2cSel.entries()];
  if (!items.length) return;
  const bin = isMs(c2cPath) ? "recycle bin" : "Google Drive trash";
  const word = `delete ${items.length}`;
  const typed = await ask(`Type "${word}" to delete ${items.length} selected item${items.length > 1 ? "s" : ""} from the destination. They go to the ${bin}.`, "");
  if (typed === null) return;
  if (typed.trim().toLowerCase() !== word) return toast("Text didn't match, nothing was deleted.", true);
  let failed = 0;
  for (const [p] of items) { try { await api("POST", "/drive/delete", { path: p }); } catch { failed++; } }
  toast(failed ? `${items.length - failed} deleted, ${failed} failed.` : `Moved ${items.length} item${items.length > 1 ? "s" : ""} to the ${bin}.`, Boolean(failed));
  await loadC2cDest(c2cPath);
});
$("c2cMkdir").onclick = () => guard(async () => {
  if (c2cPath === null || c2cPath === "ms:") return toast("Open a destination folder first.", true);
  const n = await ask("New folder name:", "");
  if (!n || !n.trim()) return;
  await api("POST", "/drive/mkdir", { path: isMs(c2cPath) ? `${c2cPath}/${n.trim()}` : (c2cPath ? `${c2cPath}/${n.trim()}` : n.trim()) });
  await loadC2cDest(c2cPath);
});
var c2cSplitMb = Number(localStorage.getItem("ls-c2c-split") || 0);
$("c2cCompress").checked = localStorage.getItem("ls-c2c-compress") === "1";
function renderC2cCompress() {
  const on = $("c2cCompress").checked;
  $("c2cSplitRow").classList.toggle("hidden", !on);
  for (const b of $("c2cSplit").querySelectorAll(".seg-btn")) b.classList.toggle("on", Number(b.dataset.mb) === c2cSplitMb);
  const btn = $("c2cStart"), n = driveSel.size;
  if (n) btn.lastChild.textContent = on ? ` Compress & copy ${n}` : ` Copy ${n}`;
}
$("c2cCompress").onchange = () => { localStorage.setItem("ls-c2c-compress", $("c2cCompress").checked ? "1" : "0"); renderC2cCompress(); };
$("c2cSplit").onclick = (e) => {
  const b = e.target.closest(".seg-btn"); if (!b) return;
  c2cSplitMb = Number(b.dataset.mb); localStorage.setItem("ls-c2c-split", String(c2cSplitMb)); renderC2cCompress();
};
renderC2cCompress();
$("c2cUp").onclick = () => guard(() => loadC2cDest(c2cParent(c2cPath)));
$("c2cRefresh").onclick = () => guard(() => loadC2cDest(c2cPath ?? undefined));
$("c2cConnect").onclick = () => guard(async () => { if (await msConnect()) await loadC2cDest(); });
$("c2cSwap").onclick = () => guard(async () => { c2cPath = null; await switchProvider(!isMs(cwd)); await loadC2cDest(); });
$("c2cStart").onclick = () => guard(async () => {
  const items = [...driveSel.values()];
  if (!items.length) return toast("Tick files or folders first.", true);
  const dest = c2cPath;
  if (dest === null || dest === "ms:") return toast("Open a destination folder first.", true);
  const compress = $("c2cCompress").checked;
  const split_mb = compress ? c2cSplitMb : 0;
  if (compress && split_mb) {
    const total = items.filter((f) => !f.dir).reduce((x, f) => x + (f.size || 0), 0);
    if (total / (split_mb * 1024 * 1024) > 50) return toast("That would make more than 50 parts. Pick a bigger part size.", true);
  }
  for (const it of items) await api("POST", "/copies", { src: it.full, dest, compress, split_mb });
  toast(`Added ${items.length} copy job${items.length > 1 ? "s" : ""} → ${placeName(dest, c2cLabel)}`);
  loadDrive();
  loadJobs();
});

function setMode(m) {
  mode = m;
  localStorage.setItem("ls-mode", m);
  document.body.classList.toggle("d2t", m === "drive2tg");
  document.body.classList.toggle("c2c", m === "c2c");
  // Source pane always on the left: Drive first when sending Drive -> Telegram or cloud -> cloud.
  const ws = $("workspace"), tg = $("tgPane"), dr = $("drivePane"), sp0 = ws.querySelector('[data-split="0"]');
  const [first, second] = m === "drive2tg" || m === "c2c" ? [dr, tg] : [tg, dr];
  ws.insertBefore(first, ws.firstChild);
  ws.insertBefore(sp0, first.nextSibling);
  ws.insertBefore(second, sp0.nextSibling);
  for (const b of document.querySelectorAll("#modeBar .mode")) b.classList.toggle("on", b.dataset.mode === m);
  $("d2tInfo").classList.toggle("hidden", m !== "drive2tg");
  $("t2dBody").classList.toggle("hidden", m !== "tg2drive");
  $("linkBody").classList.toggle("hidden", m !== "link");
  $("c2cBody").classList.toggle("hidden", m !== "c2c");
  document.body.classList.toggle("link-tg", m === "link" && linkTo() === "telegram");
  $("driveHint").textContent = m === "drive2tg"
    ? "Tick files or folders, then press Send to Telegram."
    : m === "link" ? "Files from links go into the folder you're looking at."
    : m === "c2c" ? "Tick what to copy, then press Copy on the right."
    : "Files from Telegram go into the folder you're looking at.";
  linkDriveNote();
  renderDriveSel();
  if (m === "c2c") loadC2cDest().catch(() => {});
}

// ------------------------------------------------ drive -> telegram

// Searchable chat picker with suggestions; any @username or t.me link is accepted too.
function setupTargetCombo(targets, ids = ["tgTargetSearch", "tgTargetList", "tgTargetErr"]) {
  if (!Array.isArray(targets)) targets = [];
  const [input, list, err] = ids.map((i) => $(i));
  const icons = { saved: "⭐", user: "👤", group: "👥", channel: "📢" };
  const groups = [["saved", "Saved"], ["user", "People"], ["group", "Groups"], ["channel", "Channels"]];
  let chosen = targets.find((t) => t.id === "me") || null;
  let active = -1, rows = [];
  input.value = chosen ? `${icons.saved} ${chosen.title}` : "";
  err.classList.add("hidden");

  const render = () => {
    const q = input.value.replace(/^[⭐👤👥📢]\s*/u, "").trim().toLowerCase().replace(/^@/, "");
    const match = (t) => !q || t.title.toLowerCase().includes(q) || (t.username || "").toLowerCase().includes(q) || t.id === q;
    const items = [];
    const typed = input.value.trim();
    if (q && (/^@?\w{4,}$/.test(typed) || typed.includes("t.me/")) && !targets.some((t) => (t.username || "").toLowerCase() === q))
      items.push({ id: typed.startsWith("@") || typed.includes("t.me/") ? typed : "@" + typed, title: typed.includes("t.me/") ? typed : "@" + typed.replace(/^@/, ""), type: "manual" });
    for (const [type, label] of groups) {
      const g = targets.filter((t) => t.type === type && match(t)).slice(0, q ? 50 : 8);
      if (g.length) items.push({ header: label }, ...g);
    }
    rows = items.filter((i) => !i.header);
    active = rows.length ? 0 : -1;
    list.replaceChildren(...items.map((it) => {
      if (it.header) return el("li", { className: "group-h", textContent: it.header });
      const li = el("li", { role: "option" },
        el("span", { textContent: it.type === "manual" ? "➜" : icons[it.type] || "" }),
        el("span", { className: "name", textContent: it.type === "manual" ? `Send to ${it.title}` : it.title }),
        it.username ? el("span", { className: "sub", textContent: "@" + it.username }) : "");
      li.onmousedown = (e) => { e.preventDefault(); pick(it); };
      it._li = li;
      return li;
    }));
    if (!items.length) list.replaceChildren(el("li", { className: "group-h", textContent: "No match — type a full @username" }));
    highlight();
    list.classList.remove("hidden");
    place();
  };
  // Outside dialogs the list floats (fixed) so it never stretches the pane and adds a second scrollbar.
  const floating = !input.closest("dialog");
  const place = () => {
    if (!floating) return;
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 180 && above > below;
    const h = Math.max(120, Math.min(260, up ? above : below));
    Object.assign(list.style, { position: "fixed", left: r.left + "px", width: r.width + "px", right: "auto", maxHeight: h + "px",
      top: up ? "auto" : r.bottom + 4 + "px", bottom: up ? window.innerHeight - r.top + 4 + "px" : "auto" });
  };
  if (floating) {
    const reflow = () => { if (!list.classList.contains("hidden")) place(); };
    window.addEventListener("resize", reflow);
    document.addEventListener("scroll", (e) => { if (!list.contains(e.target)) reflow(); }, true);
  }
  const highlight = () => rows.forEach((r, i) => r._li.classList.toggle("active", i === active));
  const pick = (it) => {
    chosen = it; err.classList.add("hidden");
    input.value = it.type === "manual" ? it.title : `${icons[it.type] || ""} ${it.title}`;
    list.classList.add("hidden");
  };
  input.onfocus = () => { input.select(); render(); };
  input.oninput = () => { chosen = null; err.classList.add("hidden"); render(); };
  // Clicking or dragging the list's scrollbar must not steal focus from the box.
  list.onmousedown = (e) => e.preventDefault();
  input.onblur = () => setTimeout(() => { if (document.activeElement !== input) list.classList.add("hidden"); }, 150);
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (list.classList.contains("hidden")) render();
      if (rows.length) { active = (active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length; highlight(); rows[active]._li.scrollIntoView({ block: "nearest" }); }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!list.classList.contains("hidden") && rows[active]) pick(rows[active]);
    } else if (e.key === "Escape" && !list.classList.contains("hidden")) {
      e.preventDefault(); e.stopPropagation(); list.classList.add("hidden");
    }
  };
  return {
    value: () => {
      if (chosen) return chosen;
      const t = input.value.trim();
      return t ? { id: t, title: t } : null;
    },
    error: (m) => { err.textContent = "⚠ " + String(m).replace(/^.*?Error: /, ""); err.classList.remove("hidden"); },
  };
}

let tgTargets = null;
async function sendToTelegram(items) {
  if (!items.length) return;
  // Size check first: Telegram caps one file at 2 GB (4 GB with Premium).
  const checks = [];
  for (const it of items) checks.push({ it, check: await api("POST", "/drive/check-upload", { path: it.full }) });
  if (!tgTargets) tgTargets = await api("GET", "/telegram/targets");
  const combo = setupTargetCombo(tgTargets);
  $("tgCaption").value = "";
  const hasDir = checks.some((c) => c.check.is_dir);
  const total = checks.reduce((a, c) => a + c.check.size, 0);
  const { limit, premium } = checks[0].check;
  $("tgSendWhat").textContent = items.length === 1
    ? `"${items[0].name}"${hasDir ? ` — folder, ${checks[0].check.file_count} files` : ""} (${fmtSize(total)})`
    : `${items.length} items (${fmtSize(total)})`;
  const skipped = checks.reduce((a, c) => a + (c.check.skipped || 0), 0);
  if (skipped) $("tgSendWhat").textContent += ` — ${skipped} Google Docs/Sheets/Slides file(s) will be skipped (cloud-only; export them as PDF/Office first)`;
  $("tgFolderOpts").classList.toggle("hidden", !hasDir);
  document.querySelector('input[name="tgFolderMode"][value="archive"]').checked = true;
  const note = () => {
    const fm = document.querySelector('input[name="tgFolderMode"]:checked').value;
    const big = checks.some(({ check: c }) => (c.is_dir && fm === "batch" ? c.batch_needs_split : c.needs_split));
    $("tgSizeNote").textContent = big
      ? `⚠ Something is bigger than Telegram's ${fmtSize(limit)} limit for your account — you'll be asked before it's split.`
      : `Fits without splitting (your limit: ${fmtSize(limit)} per file${premium ? ", Premium" : ""}).`;
  };
  for (const r of document.querySelectorAll('input[name="tgFolderMode"]')) r.onchange = note;
  note();

  const d = $("tgSendDlg");
  const okBtn = d.querySelector('button[value="ok"]');
  let target = "", title = "";
  okBtn.onclick = async (ev) => {
    ev.preventDefault();
    const pick = combo.value();
    if (!pick) { combo.error("Choose a chat from the list or type a @username."); return; }
    okBtn.disabled = true;
    try {
      const r = await api("POST", "/telegram/check-target", { target: pick.id });
      target = pick.id; title = pick.title || r.title;
      d.close("ok");
    } catch (e) {
      combo.error(e.message || String(e));
    } finally { okBtn.disabled = false; }
  };
  const ok = await new Promise((resolve) => {
    d.onclose = () => resolve(d.returnValue === "ok");
    d.returnValue = "";
    d.showModal();
  });
  if (!ok) return false;
  const folderMode = document.querySelector('input[name="tgFolderMode"]:checked').value;
  const caption = $("tgCaption").value.trim();

  // Ask once for everything that needs splitting, with the approximate part counts.
  const oversized = checks.filter(({ check: c }) => (c.is_dir && folderMode === "batch" ? c.batch_needs_split : c.needs_split));
  let split = false;
  if (oversized.length) {
    const lines = oversized.map(({ it, check: c }) => c.is_dir && folderMode === "batch"
      ? `• ${it.name}/ — ${c.batch_oversized} file(s) inside are too big and will be split`
      : `• ${it.name} (${fmtSize(c.size)}) → about ${c.parts} parts`).join("\n");
    const yes = await ask(
      `Over Telegram's ${fmtSize(limit)} limit for your account:\n${lines}\n\n` +
      `Split them into parts (Part 1, Part 2 …, .7z.001, .002) and send them one after another? ` +
      `To rebuild later, put all parts in one folder and open part 1 with 7-Zip.`, null);
    if (yes === null) { toast("Nothing was sent."); return false; }
    split = true;
  }
  for (const { it, check: c } of checks) {
    const needs = c.is_dir && folderMode === "batch" ? c.batch_needs_split : c.needs_split;
    await api("POST", "/uploads", { path: it.full, target, split: split && needs, caption, target_title: title, mode: folderMode });
  }
  toast(items.length === 1 ? `Added: → ${title}` : `Added ${items.length} jobs → ${title}`);
  loadJobs();
  return true;
}

// Instant name filter on whatever list is showing.
function filterList(id, text) {
  const t = text.trim().toLowerCase();
  for (const li of $(id).children) {
    const n = li.querySelector(".name");
    li.classList.toggle("filtered-out", Boolean(t) && !(n && n.textContent.toLowerCase().includes(t)));
  }
}

// ------------------------------------------------ link -> drive / telegram

const PLATFORM_NAME = {
  sharepoint: "SharePoint / OneDrive", gdrive: "Google Drive", dropbox: "Dropbox",
  mediafire: "MediaFire", mega: "MEGA", youtube: "Video site", direct: "Direct link",
};
let linkChecked = null, linkCombo = null;

function linkDriveNote() {
  const n = $("linkDriveNote");
  if (n) n.textContent = `Saved into: ${placeName(cwd, msLabel)} (open another folder on the right to change it)`;
}

function linkTo() { return document.querySelector('input[name="linkTo"]:checked').value === "telegram" ? "telegram" : "drive"; }

async function checkLink() {
  const url = $("linkUrl").value.trim();
  if (!url) return;
  $("linkOpts").classList.add("hidden");
  $("linkInfo").classList.remove("hidden");
  $("linkInfo").textContent = "Checking the link…";
  try {
    const isTg = /(^|\/\/)(www\.)?t\.me\//i.test(url);
    $("linkToTgCard").classList.toggle("hidden", isTg);
    $("linkCompressRow").classList.toggle("hidden", isTg);
    if (isTg) {
      const f = await api("POST", "/telegram/resolve-link", { link: url });
      linkChecked = { url, telegram: f };
      $("linkInfo").textContent = `✈️ Telegram message · ${f.name} · ${fmtSize(f.size)}`;
      $("linkQualityRow").classList.add("hidden");
      $("linkBundleRow").classList.add("hidden");
      const d = document.querySelector(`input[name="linkTo"][value="${isMs(cwd) ? "ms" : "g"}"]`);
      if (!d.checked) { d.checked = true; d.onchange(); }
      $("linkOpts").classList.remove("hidden");
      linkDriveNote();
      return;
    }
    const r = await api("POST", "/links/inspect", { url });
    linkChecked = { url, ...r };
    const what = r.folder
      ? `📁 Whole folder "${r.title}"${r.count ? ` — ${r.count} files` : ""} · sub-folders kept`
      : r.playlist ? `Playlist "${r.title}" — ${r.count} videos` : (r.title || "File") + (r.size ? ` · ${fmtSize(r.size)}` : "");
    $("linkInfo").textContent = `${PLATFORM_NAME[r.platform] || r.platform} · ${what}`;
    $("linkQualityRow").classList.toggle("hidden", !r.quality);
    $("linkBundleRow").classList.toggle("hidden", !r.playlist);
    document.querySelector('input[name="linkBundle"][value="0"]').checked = true;
    $("linkOpts").classList.remove("hidden");
    linkDriveNote();
  } catch (e) {
    linkChecked = null;
    $("linkInfo").textContent = "⚠ " + String(e.message || e).replace(/^.*?Error: /, "");
  }
}

async function loadLinkTargets() {
  if (!tgTargets) tgTargets = await api("GET", "/telegram/targets");
  linkCombo = setupTargetCombo(tgTargets, ["linkTargetSearch", "linkTargetList", "linkTargetErr"]);
}

// Smart paste: pick up a copied link (https://… or t.me/…) without Ctrl+V.
const LINK_RE = /^(https?:\/\/|t\.me\/)\S+$/i;
let lastAutoPaste = "";
async function pasteLink(auto = false) {
  const text = ((await ls.readClipboard?.()) || "").trim();
  if (!LINK_RE.test(text)) { if (!auto) toast("No link found in your clipboard.", true); return; }
  if (auto && text === lastAutoPaste) return; // don't refill a link the user already cleared
  lastAutoPaste = text;
  $("linkUrl").value = /^t\.me\//i.test(text) ? "https://" + text : text;
  if (auto) toast("Link pasted from your clipboard");
  await checkLink();
}
$("linkPaste").onclick = () => guard(() => pasteLink(false));
$("linkCheck").onclick = () => guard(checkLink);
$("linkUrl").onkeydown = (e) => { if (e.key === "Enter") guard(checkLink); };
$("linkUrl").onpaste = () => setTimeout(() => guard(checkLink), 0);
for (const r of document.querySelectorAll('input[name="linkTo"]')) r.onchange = () => guard(async () => {
  const v = document.querySelector('input[name="linkTo"]:checked').value;
  const tg = v === "telegram";
  if (!tg && (v === "ms") !== isMs(cwd)) {
    await switchProvider(v === "ms");
    if ((v === "ms") !== isMs(cwd)) document.querySelector(`input[name="linkTo"][value="${isMs(cwd) ? "ms" : "g"}"]`).checked = true;
  }
  $("linkTargetRow").classList.toggle("hidden", !tg);
  $("linkDriveNote").classList.toggle("hidden", tg);
  document.body.classList.toggle("link-tg", tg);
  if (tg) await loadLinkTargets();
});
$("linkStart").onclick = () => guard(async () => {
  if (!linkChecked || linkChecked.url !== $("linkUrl").value.trim()) await checkLink();
  if (!linkChecked) return;
  if (linkChecked.telegram) {
    const f = linkChecked.telegram;
    if (await sendFiles(f.chat_id, [f])) {
      $("linkUrl").value = ""; linkChecked = null;
      $("linkOpts").classList.add("hidden"); $("linkInfo").classList.add("hidden");
    }
    return;
  }
  const to = linkTo();
  let pick = null;
  if (to === "telegram") {
    if (!linkCombo) await loadLinkTargets();
    pick = linkCombo.value();
    if (!pick) { linkCombo.error("Choose a chat from the list or type a @username."); return; }
    try { await api("POST", "/telegram/check-target", { target: pick.id }); }
    catch (e) { linkCombo.error(e.message || String(e)); return; }
  }
  const body = {
    url: linkChecked.url, to, dest: cwd, quality: $("linkQuality").value, compress: $("linkCompress").checked,
    bundle: !!linkChecked.playlist && document.querySelector('input[name="linkBundle"]:checked').value === "1",
    target: pick ? pick.id : "",
    target_title: pick ? pick.title || pick.id : "",
  };
  await api("POST", "/links", body);
  toast(!linkChecked.playlist ? "Added to jobs"
    : body.bundle ? `Playlist added — ${linkChecked.count} videos into one archive`
    : `Playlist added — ${linkChecked.count} videos, one at a time`);
  $("linkUrl").value = ""; linkChecked = null;
  $("linkOpts").classList.add("hidden"); $("linkInfo").classList.add("hidden");
  loadJobs();
});

// ------------------------------------------------ jobs

const STATE_LABEL = {
  queued: "Waiting in line",
  copying: "Copying between clouds",
  paused: "Paused",
  downloading: "Downloading from Telegram",
  extracting: "Extracting",
  uploading: "Moving into Google Drive",
  splitting: "Splitting into parts",
  zipping: "Zipping the folder",
  sending: "Sending to Telegram",
  preparing: "Reading the link",
  preparing: "Preparing files for compression",
  compressing: "Compressing (7-Zip)",
  "packing archive": "Packing playlist into one archive",
  "compressing video": "Compressing video",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};
const FINISHED = ["done", "failed", "cancelled"];

// ------------------------------------------------ preferences (saved on this PC)
const PREF_DEFAULTS = { "ls-sound": true, "ls-keep-awake": true, "ls-notify": true, "ls-tray-min": false, "ls-close-tray": true };
const pref = (k) => { const v = localStorage.getItem(k); return v === null ? PREF_DEFAULTS[k] : v !== "off"; };
const retries = () => { const v = Number(localStorage.getItem("ls-retries")); return localStorage.getItem("ls-retries") === null ? 3 : Math.max(0, Math.min(5, v || 0)); };
let retrySynced = false;
const syncRetries = () => api("POST", "/settings", { auto_retries: retries() }).catch(() => { retrySynced = false; });
const syncWindowPrefs = () => ls.setWindowPrefs?.({ trayMinimize: pref("ls-tray-min"), closeToTray: pref("ls-close-tray") });
syncWindowPrefs();

function chime() {
  if (localStorage.getItem("ls-sound") === "off") return;
  try {
    const ctx = new AudioContext();
    [660, 880].forEach((hz, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = hz;
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.55);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch { /* no audio device */ }
}

const getHistory = () => { try { return JSON.parse(localStorage.getItem("ls-history") || "[]"); } catch { return []; } };
function addHistory(j) {
  const h = getHistory();
  if (h.some((x) => x.id === j.id)) return;
  h.unshift({ id: j.id, name: j.rename || j.name || "file", size: j.size, dest: j.dest, at: Date.now(), duration: j.duration || 0 });
  localStorage.setItem("ls-history", JSON.stringify(h.slice(0, 300)));
}

function jobButton(label, iconName, cls, fn) {
  const b = el("button", { className: `ghost small ${cls}`, textContent: label });
  if (iconName) b.prepend(icon(iconName));
  b.onclick = () => guard(async () => { await fn(); loadJobs(); });
  return b;
}

let lastDoneCount = -1, lastDiskAt = 0;
async function loadJobs() {
  if (!retrySynced) { retrySynced = true; syncRetries(); }
  const jobs = await api("GET", "/jobs");
  const active = jobs.some((j) => !FINISHED.includes(j.state) && !j.paused);
  // Keep the computer awake only while something is still transferring.
  ls.setKeepAwake?.(pref("ls-keep-awake") && active);
  ls.setActive?.(active);
  // Storage meters: refresh every ~6s while transferring, and with fresh numbers the moment jobs finish.
  const doneNow = jobs.filter((j) => FINISHED.includes(j.state)).length;
  if (doneNow !== lastDoneCount || (active && Date.now() - lastDiskAt > 6000)) {
    const fresh = doneNow !== lastDoneCount;
    lastDoneCount = doneNow; lastDiskAt = Date.now();
    refreshStatus(fresh).catch(() => {});
  }
  $("jobsEmpty").classList.toggle("hidden", jobs.length > 0);
  const running = jobs.filter((j) => !FINISHED.includes(j.state)).length;
  $("jobsCount").textContent = running ? String(running) : "";
  $("jobsCount").classList.toggle("hidden", !running);
  $("clearJobs").disabled = !jobs.some((j) => FINISHED.includes(j.state));
  $("jobs").replaceChildren(...jobs.map((j) => {
    if (j.state === "done" && !seenDone.has(j.id)) {
      seenDone.add(j.id);
      addHistory(j);
      if (pref("ls-notify")) ls.notify("Lecture Sync", j.kind === "upload" || (j.kind === "link" && j.to === "telegram") ? `Sent → ${j.dest}` : `Finished → ${placeName(j.dest)}`);
      chime();
      if (j.kind !== "upload" && !(j.kind === "link" && j.to === "telegram") && j.dest === cwd) loadDrive();
      if (mode === "c2c" && c2cPath !== null && j.dest === c2cPath) loadC2cDest(c2cPath).catch(() => {});
    }
    const state = j.paused && !FINISHED.includes(j.state) ? "paused" : j.state;
    const fill = el("i");
    fill.style.width = `${Math.round(j.progress * 100)}%`;
    const pct = FINISHED.includes(state) || state === "queued" ? "" : ` · ${Math.round(j.progress * 100)}%`;
    const speed = /^(downloading|sending|uploading|copying)/.test(state) && j.speed ? ` · ${fmtSize(j.speed)}/s` : "";
    const eta = FINISHED.includes(state) || state === "paused" ? "" : jobEta(j, state);
    const label = (j.state === "failed" && j.error) || (/^retrying/.test(state) && j.error) || STATE_LABEL[state] ||
      state.replace(/^downloading (\d+\/\d+)/, "Downloading · item $1").replace(/^sending part/, "Sending to Telegram · part").replace(/^sending file/, "Sending to Telegram · file");
    const doneInfo = j.state === "done" && j.duration > 0 ? doneSummary(j) : "";
    const opts = [
      j.extra_ids && j.extra_ids.length ? `${j.extra_ids.length + 1} parts` : "",
      j.kind === "upload" && j.parts > 1 ? `${j.parts} parts` : "",
      j.extract === false ? "kept compressed" : "",
      j.has_password ? "password" : "",
      j.kind === "link" ? (PLATFORM_NAME[j.platform] || "link") : "",
      j.kind === "link" && j.platform === "youtube" ? (j.quality === "audio" ? "audio only" : j.quality + "p") : "",
      j.kind === "link" && j.compress ? "compressed" : "",
      j.kind === "link" && j.parts > 1 ? `${j.parts} videos` : "",
      j.state === "done" && j.error ? j.error : "",
    ].filter(Boolean).join(" · ");
    const title = (j.rename || j.name || "Preparing…") + (j.size ? ` · ${fmtSize(j.size)}` : "");

    const actions = [];
    if (!FINISHED.includes(j.state)) {
      if (j.paused) actions.push(jobButton("Resume", "play", "", () => api("POST", `/jobs/${j.id}/resume`)));
      else if (["queued", "downloading"].includes(j.state) || /^(waiting|downloading)/.test(j.state))
        actions.push(jobButton("Pause", "pause", "", () => api("POST", `/jobs/${j.id}/pause`)));
      actions.push(jobButton("Stop", "stop", "danger", async () => {
        if ((await ask("Stop this transfer? What was downloaded so far is deleted.", null)) === null) return;
        await api("POST", `/jobs/${j.id}/cancel`);
      }));
    } else if (j.state === "done" && j.kind !== "upload" && !(j.kind === "link" && j.to === "telegram") && j.dest !== undefined) {
      actions.push(jobButton("Open folder", "folder", "", async () => {
        if (mode === "c2c" && isMs(j.dest) === (c2cDst() === "ms")) return loadC2cDest(j.dest);
        if (mode === "c2c" && isMs(j.dest) === isMs(cwd)) return loadDrive(j.dest);
        if (mode === "drive2tg" || mode === "c2c") setMode("tg2drive");
        await loadDrive(j.dest);
      }));
    } else if (j.state !== "done") {
      actions.push(jobButton("Retry", "refresh", "", () => api("POST", `/jobs/${j.id}/retry`)));
    }

    return el("li", { className: `job ${state}` },
      el("div", { className: "job-top" },
        el("span", { className: "job-name", textContent: title, title }),
        el("span", { className: "meta", textContent: "#" + j.id })),
      el("div", { className: "job-state", textContent: (j.kind === "upload" ? "→ Telegram: " + j.dest : "→ /" + (j.dest || "My Drive")) + (opts ? ` · ${opts}` : "") }),
      el("div", { className: "job-state", textContent: label + doneInfo + (j.state === "failed" ? "" : pct + speed + eta) }),
      el("div", { className: "bar" }, fill),
      actions.length ? el("div", { className: "job-actions" }, ...actions) : "");
  }));
}

// Time left: from progress rate since this stage began (works for compressing too, where speed is 0).
const etaTrack = new Map();
const fmtEta = (s) => s < 60 ? `${Math.max(1, Math.round(s))}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
function jobEta(j, state) {
  const now = Date.now(), p = j.progress || 0;
  let t = etaTrack.get(j.id);
  if (!t || t.state !== state || p < t.p0) { t = { state, t0: now, p0: p }; etaTrack.set(j.id, t); }
  let secs = 0;
  if (j.speed && j.size && /^(downloading|sending|uploading|copying)/.test(state)) secs = j.size * (1 - p) / j.speed;
  else if (p > t.p0 && now - t.t0 > 3000) secs = (now - t.t0) / 1000 * (1 - p) / (p - t.p0);
  return secs > 0 && isFinite(secs) ? ` · ~${fmtEta(secs)} left` : "";
}

// "Finished in 2m 15s · avg 18.5 MB/s"
function fmtDuration(s) {
  if (!s || s <= 0) return "";
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
}
function doneSummary(j) {
  const avg = j.size && j.duration >= 1 ? ` · avg ${fmtSize(j.size / j.duration)}/s` : "";
  return ` in ${fmtDuration(j.duration)}${avg}`;
}

function renderHistory() {
  const h = getHistory();
  $("historyEmpty").classList.toggle("hidden", h.length > 0);
  $("historyList").replaceChildren(...h.map((x) => el("li", {},
    icon(fileIcon(x.name)),
    el("div", { className: "info" },
      el("span", { className: "name", textContent: x.name, title: x.name }),
      el("span", { className: "sub", textContent: `→ /${x.dest || "My Drive"} · ${new Date(x.at).toLocaleString()}` + (x.duration ? ` · took ${fmtDuration(x.duration)}` : "") })),
    el("span", { className: "meta", textContent: fmtSize(x.size) }))));
}

// ------------------------------------------------ buttons

$("getKeys").onclick = () => ls.open("https://my.telegram.org/apps");
async function openSettingsDialog(tab) {
  const c = await ls.getConfig();
  $("apiId").value = c.apiId || "";
  $("apiHash").value = "";
  $("msClientId").value = c.msClientId || "";
  $("msTenant").value = c.msTenant || "";
  setMsMode(c.msMode || "personal");
  for (const inp of document.querySelectorAll("#settings [data-pref]")) inp.checked = pref(inp.dataset.pref);
  $("retryCount").value = String(retries());
  showSettingsTab(tab);
  $("apiHash").placeholder = c.hasApiHash ? "saved - leave empty to keep it" : "32 characters";
  $("settings").showModal();
  if (tab === "account") $("apiId").focus();
}
$("openSettings").onclick = () => openSettingsDialog("transfers");
$("enterKeys").onclick = () => openSettingsDialog("account");
$("saveKeys").onclick = () => guard(async () => {
  const apiId = $("apiId").value.trim();
  const apiHash = $("apiHash").value.trim();
  const c = await ls.getConfig();
  if (!/^\d+$/.test(apiId)) return toast("API ID is a number, check it on my.telegram.org.", true);
  if (!apiHash && !c.hasApiHash) return toast("Enter your API Hash.", true);
  if (apiHash && !/^[0-9a-f]{32}$/i.test(apiHash)) return toast("API Hash should be 32 letters and numbers.", true);
  await ls.saveTelegram({ apiId, apiHash });
  $("settings").close();
  toast("Telegram keys saved.");
  boot();
});
function showSettingsTab(name) {
  for (const t of document.querySelectorAll("#settings .stab")) t.classList.toggle("on", t.dataset.tab === name);
  for (const p of document.querySelectorAll("#settings .spane")) p.classList.toggle("hidden", p.dataset.pane !== name);
}
for (const t of document.querySelectorAll("#settings .stab")) t.onclick = () => showSettingsTab(t.dataset.tab);
// Every switch saves itself the moment it changes.
for (const inp of document.querySelectorAll("#settings [data-pref]")) {
  inp.onchange = () => {
    const k = inp.dataset.pref;
    localStorage.setItem(k, inp.checked ? "on" : "off");
    if (k === "ls-sound" && inp.checked) chime();
    if (k === "ls-keep-awake") { if (!inp.checked) ls.setKeepAwake?.(false); else loadJobs().catch(() => {}); }
    if (k === "ls-tray-min" || k === "ls-close-tray") syncWindowPrefs();
  };
}
$("retryCount").onchange = (e) => {
  localStorage.setItem("ls-retries", e.target.value);
  syncRetries();
};
$("resetPrefs").onclick = () => {
  for (const k of [...Object.keys(PREF_DEFAULTS), "ls-retries"]) localStorage.removeItem(k);
  for (const inp of document.querySelectorAll("#settings [data-pref]")) inp.checked = pref(inp.dataset.pref);
  $("retryCount").value = String(retries());
  syncRetries(); syncWindowPrefs(); loadJobs().catch(() => {});
  toast("Settings back to defaults.");
};
$("openAbout").onclick = async () => {
  $("about").showModal();
};

// ------------------------------------------------ updates
let pendingUpdate = null;
async function runUpdateCheck(manual) {
  const r = await ls.checkUpdate().catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) { if (manual) toast("Couldn't check for updates: " + r.error, true); return; }
  if (!r.available) { if (manual) toast(`You're on the latest version (v${r.current}).`); return; }
  if (!manual && localStorage.getItem("ls-skip-version") === r.latest) return;
  pendingUpdate = r;
  $("updateVer").textContent = `v${r.current} → v${r.latest}`;
  $("updateNotes").textContent = r.notes || "Bug fixes and improvements.";
  if ($("about").open) $("about").close();
  if (!manual && !document.hasFocus()) ls.notify?.("LectureSync update available", `Version ${r.latest} is ready to download.`).catch(() => {});
  $("update").showModal();
}
$("checkUpdate").onclick = async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = "Checking…";
  await runUpdateCheck(true);
  b.disabled = false; b.textContent = "Check for updates";
};
$("updateGet").onclick = () => {
  if (pendingUpdate) ls.downloadUpdate(pendingUpdate.url);
  $("update").close();
  toast("Download started in your browser. Close LectureSync, then run the new file.");
};
$("updateSkip").onclick = () => {
  if (pendingUpdate) localStorage.setItem("ls-skip-version", pendingUpdate.latest);
  $("update").close();
};
// Check right after launch, retry once if offline, then every 6 hours while open.
setTimeout(async () => { const r = await ls.checkUpdate().catch(() => null); if (r && r.ok) runUpdateCheck(false); else setTimeout(() => runUpdateCheck(false), 60000); }, 1500);
setInterval(() => runUpdateCheck(false), 6 * 3600 * 1000);
$("startColab").onclick = () => guard(ls.startColab);
$("startColabExternal").onclick = () => guard(ls.startColabExternal);
$("copyAgainExt").onclick = () => { ls.copyCell(); toast("Copied."); };
$("toggleManual").onclick = (e) => {
  e.preventDefault();
  const box = $("manualBox");
  box.classList.toggle("hidden");
  if (!box.classList.contains("hidden")) $("manualUrl").focus();
};
$("manualConnect").onclick = () => guard(async () => {
  await ls.setUrl($("manualUrl").value.trim());
  boot();
});


// ------------------------------------------------ theme
const applyTheme = (t) => {
  document.documentElement.dataset.theme = t;
  Promise.resolve(ls.setTheme && ls.setTheme(t)).catch(() => {});
  { const b = $("toggleTheme"), dark = t === "light";
    b.innerHTML = svg(dark ? "moon" : "sun") + "<span>" + (dark ? "Dark" : "Light") + "</span>";
    b.title = dark ? "Switch to dark mode" : "Switch to light mode"; }
};
applyTheme(localStorage.getItem("ls-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
$("toggleTheme").onclick = () => {
  const t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem("ls-theme", t); applyTheme(t);
};

// ------------------------------------------------ telegram QR login
var qrTimer = null, qrRefresh = null, qrBusy = false;
function stopQr() { clearInterval(qrTimer); clearTimeout(qrRefresh); qrTimer = qrRefresh = null; }
async function startQr() {
  if (qrBusy) return;
  qrBusy = true;
  stopQr();
  $("qrState").textContent = "Preparing code…";
  $("qrImg").innerHTML = '<span class="qr-spin" aria-label="Loading"></span>';
  let r;
  try { r = await api("POST", "/telegram/qr/start"); }
  catch (e) { $("qrImg").innerHTML = '<span class="muted small">Couldn\'t load the code</span>'; $("qrState").textContent = ""; $("qrStart").textContent = "Try again"; throw e; }
  finally { qrBusy = false; }
  if (r.state === "done") return qrDone();
  $("qrImg").innerHTML = String(r.svg || "").replace(/^<\?xml[^>]*>\s*/, "");
  $("qrStart").textContent = "New code";
  $("qrState").textContent = "Waiting for you to scan…";
  // Telegram codes expire after ~30s; fetch a fresh one shortly before.
  const ms = Math.max(5000, r.expires * 1000 - Date.now() - 3000);
  qrRefresh = setTimeout(() => guard(startQr), ms);
  qrTimer = setInterval(async () => {
    const s = await api("GET", "/telegram/qr/status").catch(() => null);
    if (!s) return;
    if (s.state === "done") qrDone();
    else if (s.state === "password") {
      stopQr(); $("qrPwBox").classList.remove("hidden");
      $("qrState").textContent = "Scanned. Your account has a two-step password, type it below.";
    } else if (s.state === "expired") { guard(startQr);
    } else if (s.state === "error") { stopQr(); $("qrState").textContent = "Error: " + (s.error || "try again"); }
  }, 2000);
}
function qrDone() {
  stopQr();
  $("qrState").textContent = "Signed in.";
  toast("Signed in. You won't be asked again on this Drive.");
  boot();
}
$("qrStart").onclick = () => guard(startQr);
$("qrPwSend").onclick = () => guard(async () => {
  await api("POST", "/telegram/qr/password", { password: $("qrPw").value });
  qrDone();
});

$("sendCode").onclick = () => guard(async () => {
  await api("POST", "/telegram/send-code", { phone: $("phone").value.trim() });
  toast("Code sent. Check your Telegram app.");
});
$("signIn").onclick = () => guard(async () => {
  try {
    await api("POST", "/telegram/sign-in", {
      phone: $("phone").value.trim(), code: $("code").value.trim(), password: $("pw").value || null,
    });
  } catch (e) {
    if (/2fa/.test(cleanError(e))) return toast("Your account has a two-step password. Type it and press Sign in again.", true);
    throw e;
  }
  toast("Signed in. You won't be asked again on this Drive.");
  boot();
});

let tgQuery = "";
$("chat").onchange = () => guard(loadTgFiles);
let chatSearchTimer;
$("chatSearch").oninput = (e) => { clearTimeout(chatSearchTimer); chatSearchTimer = setTimeout(() => filterChats(e.target.value), 250); };
$("tgSearch").oninput = (e) => {
  filterList("tgFiles", e.target.value);
  // Cleared the box after a full-chat search: show the latest files again.
  if (!e.target.value && tgQuery) { tgQuery = ""; guard(loadTgFiles); }
};
$("tgSearch").onkeydown = (e) => {
  if (e.key === "Enter") { tgQuery = e.target.value; guard(loadTgFiles); }
};
for (const c of document.querySelectorAll("#kindFilter .chip")) {
  c.onclick = () => {
    kind = c.dataset.kind;
    for (const o of document.querySelectorAll("#kindFilter .chip")) o.classList.toggle("on", o === c);
    applyKind();
  };
}
for (const b of document.querySelectorAll("#modeBar .mode")) b.onclick = () => setMode(b.dataset.mode);
$("driveSelClear").onclick = () => guard(() => loadDrive());
$("driveSelAll").onclick = () => {
  for (const li of $("driveList").children) {
    const c = li.querySelector(".pick");
    if (c && !li.classList.contains("filtered-out") && !c.checked) { c.checked = true; c.onchange(); }
  }
};
$("driveSelDel").onclick = () => guard(async () => {
  const items = [...driveSel.values()].filter((it) => !it.library);
  if (!items.length) return;
  const bin = isMs(cwd) ? "recycle bin" : "Google Drive trash";
  const word = `delete ${items.length}`;
  const typed = await ask(`Type "${word}" to delete ${items.length} selected item${items.length > 1 ? "s" : ""}. They go to the ${bin}.`, "");
  if (typed === null) return;
  if (typed.trim().toLowerCase() !== word) return toast("Text didn't match, nothing was deleted.", true);
  let failed = 0;
  for (const it of items) { try { await api("POST", "/drive/delete", { path: it.full }); } catch { failed++; } }
  toast(failed ? `${items.length - failed} deleted, ${failed} failed.` : `Moved ${items.length} item${items.length > 1 ? "s" : ""} to the ${bin}.`, Boolean(failed));
  refreshStatus(true).catch(() => {});
  await loadDrive();
  if (mode === "c2c" && c2cPath !== null) loadC2cDest(c2cPath).catch(() => {});
});
$("driveSelSend").onclick = () => guard(async () => {
  if (await sendToTelegram([...driveSel.values()])) loadDrive();
});
setMode(mode);
// Select every file currently visible (respects the type filter and the search box).
$("tgSelAll").onclick = () => {
  const items = [...$("tgFiles").children];
  items.forEach((li, i) => {
    if (li.classList.contains("kind-out") || li.classList.contains("filtered-out")) return;
    const f = tgList[i];
    if (f) selected.set(f.id, f);
    const pick = li.querySelector(".pick");
    if (pick) pick.checked = true;
  });
  if (!selected.size) toast("No files to select here.", true);
  renderSel();
};
$("selClear").onclick = () => { selected.clear(); renderTgFiles($("chat").value); };
$("selSend").onclick = () => guard(async () => {
  if (await sendFiles(Number($("chat").value), [...selected.values()])) { selected.clear(); renderTgFiles($("chat").value); }
});
$("clearJobs").onclick = () => guard(async () => {
  const r = await api("DELETE", "/jobs");
  toast(r.cleared ? `Cleared ${r.cleared} finished job${r.cleared > 1 ? "s" : ""}.` : "Nothing to clear.");
  loadJobs();
});
$("openHistory").onclick = () => { renderHistory(); $("history").showModal(); };
$("historyClear").onclick = () => { localStorage.removeItem("ls-history"); renderHistory(); };
$("driveSearch").oninput = (e) => filterList("driveList", e.target.value);
$("refreshDrive").onclick = () => guard(() => loadDrive(cwd));
$("refreshTg").onclick = () => { tgTargets = null; guard(loadChats); };
$("up").onclick = () => guard(() => loadDrive(parentOf(cwd)));
$("mkdir").onclick = () => guard(async () => {
  if (cwd === "ms:") return toast("Open My OneDrive or a SharePoint library first.", true);
  const n = await ask("Folder name:", "");
  if (n && n.trim()) { await api("POST", "/drive/mkdir", { path: cwd ? `${cwd}/${n.trim()}` : n.trim() }); loadDrive(); }
});
$("accMs").onclick = () => guard(() => switchProvider(true));
(function initJobsToggle() {
  const apply = (min) => {
    document.body.classList.toggle("jobs-min", min);
    $("toggleJobs").textContent = min ? "Show" : "Hide";
    localStorage.setItem("ls-jobs-min", min ? "1" : "");
  };
  apply(localStorage.getItem("ls-jobs-min") === "1");
  $("toggleJobs").onclick = () => apply(!document.body.classList.contains("jobs-min"));
})();
$("provG").onclick = () => guard(() => switchProvider(false));
$("provMs").onclick = () => guard(() => switchProvider(true));
$("msAccount").onclick = () => guard(async () => {
  await api("POST", "/ms/logout");
  msConnected = false;
  for (const k of [...driveCache.keys()]) if (isMs(k)) driveCache.delete(k);
  await ls.msForget?.().catch(() => null);
  toast("Signed out of Microsoft.");
  await loadDrive(lastIn.g);
});
let msMode = "personal";
function setMsMode(m) {
  msMode = m === "custom" ? "custom" : "personal";
  for (const b of document.querySelectorAll("[data-msmode]")) {
    const on = b.dataset.msmode === msMode;
    b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on));
  }
  $("msCustomFields").classList.toggle("hidden", msMode !== "custom");
  $("msPersonalNote").classList.toggle("hidden", msMode === "custom");
}
for (const b of document.querySelectorAll("[data-msmode]")) b.onclick = () => setMsMode(b.dataset.msmode);
$("saveMs").onclick = () => guard(async () => {
  const custom = msMode === "custom";
  const id = $("msClientId").value.trim();
  const tenant = $("msTenant").value.trim().toLowerCase();
  if (custom && !id) return toast("Paste your custom app ID, or choose Personal.", true);
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) return toast("The app ID looks like 00000000-0000-0000-0000-000000000000.", true);
  if (tenant && !/^[a-z0-9.-]{1,100}$/.test(tenant)) return toast("The organization looks like university.edu.", true);
  if (id && !tenant) return toast("Add your organization domain (e.g. must.edu.eg) for a custom app ID.", true);
  await ls.saveMicrosoft(id, tenant, msMode);
  await api("POST", "/ms/logout").catch(() => null);
  msConnected = false;
  for (const k of [...driveCache.keys()]) if (isMs(k)) driveCache.delete(k);
  await ls.configureMicrosoft().catch((e) => toast(cleanError(e), true));
  toast(custom ? "University sign-in selected — sign in to OneDrive again." : "Personal sign-in selected (Outlook / Hotmail) — sign in to OneDrive again.");
});
// ------------------------------------------------ keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if ($("app").classList.contains("hidden") || document.querySelector("dialog[open]")) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  const searchBox = () => mode === "link" ? $("linkUrl") : mode === "drive2tg" ? $("driveSearch") : $("tgSearch");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); searchBox().focus(); searchBox().select(); }
  else if (e.key === "/" && !typing) { e.preventDefault(); searchBox().focus(); }
  else if (e.key === "Escape") {
    if (typing) { document.activeElement.blur(); return; }
    if (driveSel.size) $("driveSelClear").click();
    if (selected.size) $("selClear").click();
  }
});

// ------------------------------------------------ start

async function boot() {
  retrySynced = false;
  const cfg = await ls.getConfig();
  $("ver").textContent = "v" + cfg.version;
  $("aboutVer").textContent = "Version " + cfg.version;

  const h = cfg.url ? await refreshStatus() : null;
  if (h) {
    // The worker forgets keys on every new Colab run; hand them over again.
    ls.configureMicrosoft?.().then(() => ls.msPush?.()).catch(() => null);
    if (!h.telegram_ready) {
      const r = await ls.configureTelegram().catch((e) => { toast(cleanError(e), true); return null; });
      signedIn = Boolean(r && r.telegram);
      if (r) setStatus(signedIn ? "Connected" : "Connected · Telegram sign-in needed", signedIn ? "on" : "wait");
    }
  }
  await renderSetup();
  if (connected && signedIn) {
    guard(() => loadDrive(cwd));
    guard(loadJobs);
    guard(loadChats);
  }
}

$("disconnect").onclick = async () => {
  if (!confirm("Disconnect from this Colab session? Running transfers on Colab will keep going, but the app will go back to setup.")) return;
  await ls.disconnect();
  connected = false; signedIn = false; failStreak = 0;
  stopQr();
  setStatus("Not connected");
  $("disk").classList.add("hidden");
  $("accounts").classList.add("hidden");
  await renderSetup();
  toast("Disconnected. Start a new session whenever you're ready.");
};

setInterval(async () => {
  const was = connected && signedIn;
  await refreshStatus();
  if (was !== (connected && signedIn)) boot();
}, 15000);
setInterval(() => { if (connected && signedIn) loadJobs().catch(() => {}); }, 2000);
boot();
})();

// Browser sign-ins: Colab can't refresh the Microsoft token itself, so hand over a fresh one every 40 minutes.
setInterval(() => { ls.msPush?.().catch(() => null); }, 40 * 60 * 1000);

/*redesign-applied*/

// Cancel buttons are type="button" so Enter in a text field submits "Send" instead of cancelling.
for (const b of document.querySelectorAll("button[data-close]")) b.onclick = () => b.closest("dialog").close("cancel");
