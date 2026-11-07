// Lecture Sync UI - Ahmed Omran <B9x@outlook.com>
// Wrapped in a function so local names never collide with the `ls` global the preload exposes.
(() => {
const $ = (id) => document.getElementById(id);
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
let connected = false;
let signedIn = false;
const seenDone = new Set();

// ------------------------------------------------ small helpers

const ICONS = {
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
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
const fileIcon = (name) => { const k = fileKind(name); return ["doc", "audio", "image"].includes(k) ? "file" : k; };
// "Lec 1.part2.rar" -> "lec 1": used to spot volumes of one split archive.
const archiveBase = (n) => n.replace(/\.(part\d+\.rar|\d{3}|z\d{2}|r\d{2})$/i, "").replace(/\.(zip|rar|7z)$/i, "").toLowerCase();
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; } };

let toastTimer;
function toast(text, isError = false) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4500);
}

function ask(text, value = "") {
  return new Promise((resolve) => {
    const d = $("prompt");
    $("promptText").textContent = text;
    $("promptInput").value = value ?? "";
    $("promptInput").classList.toggle("hidden", value === null);
    d.onclose = () => resolve(d.returnValue === "ok" ? $("promptInput").value : null);
    d.returnValue = "";
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
  $("workspace").classList.toggle("hidden", !ready);
  $("modeBar").classList.toggle("hidden", !ready);
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
async function refreshStatus() {
  try {
    const h = await api("GET", "/health");
    const d = await api("GET", "/disk");
    failStreak = 0;
    connected = true;
    signedIn = Boolean(h.telegram);
    setStatus(signedIn ? "Connected" : "Connected · Telegram sign-in needed", signedIn ? "on" : "wait");
    $("disk").classList.remove("hidden");
    $("diskText").textContent = `Colab disk · ${fmtSize(d.free)} free of ${fmtSize(d.total)}` +
      (d.drive ? ` · Drive · ${fmtSize(d.drive.free)} free` : "");
    $("diskFill").style.width = `${Math.round((d.used / d.total) * 100)}%`;
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

async function loadChats() {
  const chats = await api("GET", "/telegram/chats");
  const prev = $("chat").value;
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
    const send = el("button", { className: "primary small", textContent: "Send", title: "Send to Google Drive" });
    send.onclick = () => guard(() => sendFiles(Number(chatId), [f]));
    const sub = [fmtDate(f.date), f.caption].filter(Boolean).join(" · ");
    const li = el("li", { className: "kind-" + fileKind(f.name) },
      pick, icon(fileIcon(f.name)),
      el("div", { className: "info" },
        el("span", { className: "name", textContent: f.name, title: f.name }),
        sub ? el("span", { className: "sub", textContent: sub, title: f.caption || "" }) : ""),
      f.caption ? copyBtn(f.caption) : "",
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
  const b = el("button", { className: "ghost small copy-cap", textContent: "Copy caption", title: "Copy this file's description text (not the file itself)" });
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
  if (Array.isArray(saved) && saved.length === 3) apply(saved);
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
    const where = "/" + (cwd || "My Drive");
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
    d.onclose = () => resolve(d.returnValue === "ok" ? {
      rename: $("sendRename").value.trim(),
      extract: $("sendExtract").checked,
      multi: $("sendMulti").checked && archives.length > 1,
      subfolder: $("sendSub").checked,
      password: $("sendPw").value || null,
    } : null);
    d.returnValue = "";
    d.showModal();
  });
}

async function sendFiles(chatId, files) {
  const o = await sendDialog(files);
  if (!o) return false;
  const base = { chat_id: chatId, dest: cwd, extract: o.extract, subfolder: o.subfolder, password: o.password };
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
  const parts = cwd ? cwd.split("/") : [];
  const nodes = [el("button", { textContent: "My Drive", onclick: () => guard(() => loadDrive("")) })];
  parts.forEach((p, i) => {
    const target = parts.slice(0, i + 1).join("/");
    nodes.push(el("span", { textContent: "›" }), el("button", { textContent: p, onclick: () => guard(() => loadDrive(target)) }));
  });
  $("crumb").replaceChildren(...nodes);
}

async function loadDrive(path = cwd) {
  let res;
  try {
    res = await api("GET", `/drive/list?path=${encodeURIComponent(path)}`);
  } catch (e) {
    if (!path) throw e;
    res = await api("GET", "/drive/list?path="); // remembered folder no longer exists
  }
  cwd = res.path;
  linkDriveNote();
  localStorage.setItem("ls-last-folder", cwd);
  renderCrumb();
  $("driveWarn").classList.toggle("hidden", res.mounted !== false);
  $("driveEmpty").classList.toggle("hidden", res.items.length > 0);
  driveSel.clear();
  driveItems = res.items.map((it) => ({ ...it, full: cwd ? `${cwd}/${it.name}` : it.name }));
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
      const typed = await ask(`Type "${it.name}" to delete it${it.dir ? " and everything inside" : ""}. It goes to Drive's trash.`, "");
      if (typed === null) return;
      if (typed !== it.name) return toast("Name didn't match, nothing was deleted.", true);
      await api("POST", "/drive/delete", { path: full });
      toast("Moved to Drive trash.");
      loadDrive();
    });

    const pick = el("input", { type: "checkbox", className: "pick", title: "Select to send to Telegram" });
    const li = el("li", { className: it.dir ? "dir" : "" },
      pick, icon(it.dir ? "folder" : fileIcon(it.name)), name,
      el("span", { className: "meta", textContent: it.dir ? "folder" : fmtSize(it.size) }),
      el("span", { className: "actions" }, ren, del));
    pick.onchange = () => {
      pick.checked ? driveSel.set(full, it) : driveSel.delete(full);
      li.classList.toggle("picked", pick.checked);
      renderDriveSel();
    };
    return li;
  }));
  renderDriveSel();
  filterList("driveList", $("driveSearch").value);
}

// ------------------------------------------------ direction mode + drive selection

let driveItems = [];
const driveSel = new Map(); // Drive path -> item
let mode = ["drive2tg", "link"].includes(localStorage.getItem("ls-mode")) ? localStorage.getItem("ls-mode") : "tg2drive";

function renderDriveSel() {
  const on = mode === "drive2tg" && driveSel.size > 0;
  $("driveSelBar").classList.toggle("hidden", mode !== "drive2tg");
  const files = [...driveSel.values()];
  const total = files.filter((f) => !f.dir).reduce((a, f) => a + (f.size || 0), 0);
  const dirs = files.filter((f) => f.dir).length;
  $("driveSelCount").textContent = driveSel.size
    ? `${driveSel.size} selected · ${fmtSize(total)}${dirs ? ` + ${dirs} folder${dirs > 1 ? "s" : ""}` : ""}`
    : "Tick files or folders to send";
  $("driveSelSend").disabled = !on;
  $("driveSelClear").disabled = !driveSel.size;
}

function setMode(m) {
  mode = m;
  localStorage.setItem("ls-mode", m);
  document.body.classList.toggle("d2t", m === "drive2tg");
  // Source pane always on the left: Drive first when sending Drive -> Telegram.
  const ws = $("workspace"), tg = $("tgPane"), dr = $("drivePane"), sp0 = ws.querySelector('[data-split="0"]');
  const [first, second] = m === "drive2tg" ? [dr, tg] : [tg, dr];
  ws.insertBefore(first, ws.firstChild);
  ws.insertBefore(sp0, first.nextSibling);
  ws.insertBefore(second, sp0.nextSibling);
  for (const b of document.querySelectorAll("#modeBar .mode")) b.classList.toggle("on", b.dataset.mode === m);
  $("d2tInfo").classList.toggle("hidden", m !== "drive2tg");
  $("t2dBody").classList.toggle("hidden", m !== "tg2drive");
  $("linkBody").classList.toggle("hidden", m !== "link");
  $("driveHint").textContent = m === "drive2tg"
    ? "Tick files or folders, then press Send to Telegram."
    : m === "link" ? "Files from links go into the folder you're looking at."
    : "Files from Telegram go into the folder you're looking at.";
  linkDriveNote();
  if (m !== "drive2tg") {
    driveSel.clear();
    for (const li of $("driveList").children) li.classList.remove("picked");
    for (const c of $("driveList").querySelectorAll(".pick")) c.checked = false;
  }
  renderDriveSel();
}

// ------------------------------------------------ drive -> telegram

// Searchable chat picker with suggestions; any @username or t.me link is accepted too.
function setupTargetCombo(targets, ids = ["tgTargetSearch", "tgTargetList", "tgTargetErr"]) {
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
  };
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
  sharepoint: "🟦 SharePoint / OneDrive", gdrive: "📁 Google Drive", dropbox: "🗃 Dropbox",
  mediafire: "🔥 MediaFire", youtube: "🔴 YouTube / video site", direct: "🔗 Direct link",
};
let linkChecked = null, linkCombo = null;

function linkDriveNote() {
  const n = $("linkDriveNote");
  if (n) n.textContent = `Saved into: /${cwd || "My Drive"} (open another folder on the right to change it)`;
}

function linkTo() { return document.querySelector('input[name="linkTo"]:checked').value; }

async function checkLink() {
  const url = $("linkUrl").value.trim();
  if (!url) return;
  $("linkOpts").classList.add("hidden");
  $("linkInfo").classList.remove("hidden");
  $("linkInfo").textContent = "Checking the link…";
  try {
    const r = await api("POST", "/links/inspect", { url });
    linkChecked = { url, ...r };
    const what = r.playlist ? `Playlist "${r.title}" — ${r.count} videos` : (r.title || "File") + (r.size ? ` · ${fmtSize(r.size)}` : "");
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

$("linkCheck").onclick = () => guard(checkLink);
$("linkUrl").onkeydown = (e) => { if (e.key === "Enter") guard(checkLink); };
$("linkUrl").onpaste = () => setTimeout(() => guard(checkLink), 0);
for (const r of document.querySelectorAll('input[name="linkTo"]')) r.onchange = () => guard(async () => {
  const tg = linkTo() === "telegram";
  $("linkTargetRow").classList.toggle("hidden", !tg);
  $("linkDriveNote").classList.toggle("hidden", tg);
  if (tg) await loadLinkTargets();
});
$("linkStart").onclick = () => guard(async () => {
  if (!linkChecked || linkChecked.url !== $("linkUrl").value.trim()) await checkLink();
  if (!linkChecked) return;
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
  paused: "Paused",
  downloading: "Downloading from Telegram",
  extracting: "Extracting",
  uploading: "Moving into Drive",
  splitting: "Splitting into parts",
  zipping: "Zipping the folder",
  sending: "Sending to Telegram",
  preparing: "Reading the link",
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
  h.unshift({ id: j.id, name: j.rename || j.name || "file", size: j.size, dest: j.dest, at: Date.now() });
  localStorage.setItem("ls-history", JSON.stringify(h.slice(0, 300)));
}

function jobButton(label, iconName, cls, fn) {
  const b = el("button", { className: `ghost small ${cls}`, textContent: label });
  if (iconName) b.prepend(icon(iconName));
  b.onclick = () => guard(async () => { await fn(); loadJobs(); });
  return b;
}

async function loadJobs() {
  if (!retrySynced) { retrySynced = true; syncRetries(); }
  const jobs = await api("GET", "/jobs");
  const active = jobs.some((j) => !FINISHED.includes(j.state) && !j.paused);
  // Keep the computer awake only while something is still transferring.
  ls.setKeepAwake?.(pref("ls-keep-awake") && active);
  ls.setActive?.(active);
  $("jobsEmpty").classList.toggle("hidden", jobs.length > 0);
  $("clearJobs").disabled = !jobs.some((j) => FINISHED.includes(j.state));
  $("jobs").replaceChildren(...jobs.map((j) => {
    if (j.state === "done" && !seenDone.has(j.id)) {
      seenDone.add(j.id);
      addHistory(j);
      if (pref("ls-notify")) ls.notify("Lecture Sync", j.kind === "upload" || (j.kind === "link" && j.to === "telegram") ? `Sent → ${j.dest}` : `Finished → /${j.dest || "My Drive"}`);
      chime();
      if (j.kind !== "upload" && !(j.kind === "link" && j.to === "telegram") && j.dest === cwd) loadDrive();
    }
    const state = j.paused && !FINISHED.includes(j.state) ? "paused" : j.state;
    const fill = el("i");
    fill.style.width = `${Math.round(j.progress * 100)}%`;
    const pct = FINISHED.includes(state) || state === "queued" ? "" : ` · ${Math.round(j.progress * 100)}%`;
    const speed = (/^downloading/.test(state) || /^sending/.test(state)) && j.speed ? ` · ${fmtSize(j.speed)}/s` : "";
    const label = (j.state === "failed" && j.error) || (/^retrying/.test(state) && j.error) || STATE_LABEL[state] ||
      state.replace(/^downloading (\d+\/\d+)/, "Downloading · item $1").replace(/^sending part/, "Sending to Telegram · part").replace(/^sending file/, "Sending to Telegram · file");
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
    } else if (j.state !== "done") {
      actions.push(jobButton("Retry", "refresh", "", () => api("POST", `/jobs/${j.id}/retry`)));
    }

    return el("li", { className: `job ${state}` },
      el("div", { className: "job-top" },
        el("span", { className: "job-name", textContent: title, title }),
        el("span", { className: "meta", textContent: "#" + j.id })),
      el("div", { className: "job-state", textContent: (j.kind === "upload" ? "→ Telegram: " + j.dest : "→ /" + (j.dest || "My Drive")) + (opts ? ` · ${opts}` : "") }),
      el("div", { className: "job-state", textContent: label + (j.state === "failed" ? "" : pct + speed) }),
      el("div", { className: "bar" }, fill),
      actions.length ? el("div", { className: "job-actions" }, ...actions) : "");
  }));
}

function renderHistory() {
  const h = getHistory();
  $("historyEmpty").classList.toggle("hidden", h.length > 0);
  $("historyList").replaceChildren(...h.map((x) => el("li", {},
    icon(fileIcon(x.name)),
    el("div", { className: "info" },
      el("span", { className: "name", textContent: x.name, title: x.name }),
      el("span", { className: "sub", textContent: `→ /${x.dest || "My Drive"} · ${new Date(x.at).toLocaleString()}` })),
    el("span", { className: "meta", textContent: fmtSize(x.size) }))));
}

// ------------------------------------------------ buttons

$("getKeys").onclick = () => ls.open("https://my.telegram.org/apps");
$("enterKeys").onclick = $("openSettings").onclick = async () => {
  const c = await ls.getConfig();
  $("apiId").value = c.apiId || "";
  $("apiHash").value = "";
  for (const inp of document.querySelectorAll("#settings [data-pref]")) inp.checked = pref(inp.dataset.pref);
  $("retryCount").value = String(retries());
  showSettingsTab("transfers");
  $("apiHash").placeholder = c.hasApiHash ? "saved - leave empty to keep it" : "32 characters";
  $("settings").showModal();
};
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
setTimeout(() => runUpdateCheck(false), 5000);
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
  $("toggleTheme").textContent = t === "light" ? "☾ Dark" : "☀ Light";
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
const fetchLink = () => guard(async () => {
  const link = $("tgLink").value.trim();
  if (!link) return toast("Paste a link to a Telegram message first.", true);
  const f = await api("POST", "/telegram/resolve-link", { link });
  if (await sendFiles(f.chat_id, [f])) $("tgLink").value = "";
});
$("tgLinkGo").onclick = fetchLink;
$("tgLink").onkeydown = (e) => { if (e.key === "Enter") fetchLink(); };
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
$("up").onclick = () => guard(() => loadDrive(cwd.split("/").slice(0, -1).join("/")));
$("mkdir").onclick = () => guard(async () => {
  const n = await ask("Folder name:", "");
  if (n && n.trim()) { await api("POST", "/drive/mkdir", { path: cwd ? `${cwd}/${n.trim()}` : n.trim() }); loadDrive(); }
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
