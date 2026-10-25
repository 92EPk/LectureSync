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

let cwd = "";
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

function fileIcon(name) {
  if (/\.(mp4|mkv|mov|avi|webm)$/i.test(name)) return "video";
  if (/\.(zip|rar|7z|tar|gz)(\.\d+)?$/i.test(name) || /\.part\d+\.rar$/i.test(name)) return "archive";
  return "file";
}

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
}

async function renderSetup() {
  const cfg = await ls.getConfig();
  const hasKeys = Boolean(cfg.apiId && cfg.hasApiHash);
  $("step1Done").classList.toggle("hidden", !hasKeys);

  setStep(1, hasKeys ? "complete" : "active");
  setStep(2, !hasKeys ? "locked" : connected ? "complete" : "active");
  setStep(3, !connected ? "locked" : signedIn ? "complete" : "active");
  $("startColab").disabled = !hasKeys;
  $("tgLogin").classList.toggle("hidden", !(connected && !signedIn));

  const ready = connected && signedIn;
  $("onboarding").classList.toggle("hidden", ready);
  $("workspace").classList.toggle("hidden", !ready);
  return hasKeys;
}

const STAGES = {
  opening: "Colab is opening. Sign in to Google if it asks.",
  running: "Code pasted and running. When Google asks, allow Drive access. This takes about a minute…",
  manual: "",
  external: "",
};
ls.onStage((stage) => {
  setStatus("Starting Colab…", "wait");
  $("showColab").classList.remove("hidden");
  $("stageText").textContent = STAGES[stage] || "";
  $("manualHelp").classList.toggle("hidden", stage !== "manual");
  $("externalHelp").classList.toggle("hidden", stage !== "external");
  if (stage === "external") $("showColab").classList.add("hidden");
});
ls.onConnected(() => {
  toast("Connected to Colab.");
  boot();
});
ls.onColabClosed(() => {
  $("showColab").classList.add("hidden");
  connected = false;
  boot();
});

// ------------------------------------------------ status

async function refreshStatus() {
  try {
    const h = await api("GET", "/health");
    const d = await api("GET", "/disk");
    connected = true;
    signedIn = Boolean(h.telegram);
    setStatus(signedIn ? "Connected" : "Connected · Telegram sign-in needed", signedIn ? "on" : "wait");
    $("disk").classList.remove("hidden");
    $("diskText").textContent = `Colab disk · ${fmtSize(d.free)} free of ${fmtSize(d.total)}`;
    $("diskFill").style.width = `${Math.round((d.used / d.total) * 100)}%`;
    return h;
  } catch {
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
  if (prev && chats.some((c) => String(c.id) === prev)) $("chat").value = prev;
  if (chats.length) await loadTgFiles();
}

async function loadTgFiles() {
  const chatId = $("chat").value;
  if (!chatId) return;
  const q = tgQuery.trim();
  const files = await api("GET", `/telegram/files?chat_id=${chatId}${q ? `&q=${encodeURIComponent(q)}&limit=200` : ""}`);
  $("tgEmpty").classList.toggle("hidden", files.length > 0);
  $("tgFiles").replaceChildren(...files.map((f) => {
    const send = el("button", { className: "primary small", textContent: "Send to Drive" });
    send.onclick = () => guard(async () => {
      const where = "/" + (cwd || "My Drive");
      if ((await ask(`Extract "${f.name}" into ${where}?`, null)) === null) return;
      await api("POST", "/jobs", { chat_id: Number(chatId), message_id: f.id, dest: cwd });
      toast("Added to jobs.");
      loadJobs();
    });
    return el("li", {},
      icon(fileIcon(f.name)),
      el("span", { className: "name", textContent: f.name, title: f.name }),
      el("span", { className: "meta", textContent: fmtSize(f.size) }),
      send);
  }));
  if (!tgQuery) filterList("tgFiles", $("tgSearch").value);
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
  const res = await api("GET", `/drive/list?path=${encodeURIComponent(path)}`);
  cwd = res.path;
  renderCrumb();
  $("driveWarn").classList.toggle("hidden", res.mounted !== false);
  $("driveEmpty").classList.toggle("hidden", res.items.length > 0);
  $("driveList").replaceChildren(...res.items.map((it) => {
    const full = cwd ? `${cwd}/${it.name}` : it.name;
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

    return el("li", { className: it.dir ? "dir" : "" },
      icon(it.dir ? "folder" : fileIcon(it.name)), name,
      el("span", { className: "meta", textContent: fmtSize(it.size) }),
      el("span", { className: "actions" }, ren, del));
  }));
  filterList("driveList", $("driveSearch").value);
}

// Instant name filter on whatever list is showing.
function filterList(id, text) {
  const t = text.trim().toLowerCase();
  for (const li of $(id).children) {
    const n = li.querySelector(".name");
    li.classList.toggle("filtered-out", Boolean(t) && !(n && n.textContent.toLowerCase().includes(t)));
  }
}

// ------------------------------------------------ jobs

const STATE_LABEL = {
  queued: "Waiting in line",
  downloading: "Downloading from Telegram",
  extracting: "Extracting",
  uploading: "Moving into Drive",
  done: "Done",
  failed: "Failed",
};

async function loadJobs() {
  const jobs = await api("GET", "/jobs");
  $("jobsEmpty").classList.toggle("hidden", jobs.length > 0);
  $("jobs").replaceChildren(...jobs.map((j) => {
    if (j.state === "done" && !seenDone.has(j.id)) {
      seenDone.add(j.id);
      ls.notify("Lecture Sync", `Finished → /${j.dest || "My Drive"}`);
      if (j.dest === cwd) loadDrive();
    }
    const fill = el("i");
    fill.style.width = `${Math.round(j.progress * 100)}%`;
    const pct = j.state === "done" ? "" : ` · ${Math.round(j.progress * 100)}%`;
    const speed = j.state === "downloading" && j.speed ? ` · ${fmtSize(j.speed)}/s` : "";
    const label = j.error || STATE_LABEL[j.state] || j.state;
    return el("li", { className: `job ${j.state}` },
      el("div", { className: "job-top" },
        el("span", { className: "job-name", textContent: "→ /" + (j.dest || "My Drive") }),
        el("span", { className: "meta", textContent: "#" + j.id })),
      el("div", { className: "job-state", textContent: label + (j.error ? "" : pct + speed) }),
      el("div", { className: "bar" }, fill));
  }));
}

// ------------------------------------------------ buttons

$("getKeys").onclick = () => ls.open("https://my.telegram.org/apps");
$("enterKeys").onclick = $("openSettings").onclick = async () => {
  const c = await ls.getConfig();
  $("apiId").value = c.apiId || "";
  $("apiHash").value = "";
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
$("openAbout").onclick = async () => {
  $("about").showModal();
};
$("startColab").onclick = () => guard(ls.startColab);
$("startColabExternal").onclick = () => guard(ls.startColabExternal);
$("copyAgainExt").onclick = () => { ls.copyCell(); toast("Copied."); };
$("showColab").onclick = () => ls.showColab();
$("copyAgain").onclick = () => { ls.copyCell(); toast("Copied."); };
function showNotebook(nb) {
  $("notebookUrl").value = nb || "";
  $("notebookText").textContent = nb
    ? "Opens your saved notebook, no new files are created."
    : "First run creates one notebook; it is reused after that.";
}
ls.getNotebook().then(showNotebook);
ls.onNotebook(({ notebook }) => { showNotebook(notebook); toast("Notebook saved, it will be reused."); });
$("saveNotebook").onclick = () => guard(async () => {
  await ls.setNotebook($("notebookUrl").value);
  showNotebook($("notebookUrl").value.trim());
  toast("Saved.");
});
$("resetNotebook").onclick = () => guard(async () => {
  await ls.setNotebook("");
  showNotebook("");
  toast("Next start opens a new notebook.");
});
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
let qrTimer = null, qrRefresh = null;
const stopQr = () => { clearInterval(qrTimer); clearTimeout(qrRefresh); qrTimer = qrRefresh = null; };
async function startQr() {
  stopQr();
  $("qrState").textContent = "Preparing code…";
  const r = await api("POST", "/telegram/qr/start");
  if (r.state === "done") return qrDone();
  $("qrImg").innerHTML = r.svg;
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
$("driveSearch").oninput = (e) => filterList("driveList", e.target.value);
$("refreshDrive").onclick = () => guard(() => loadDrive(cwd));
$("refreshTg").onclick = () => guard(loadChats);
$("up").onclick = () => guard(() => loadDrive(cwd.split("/").slice(0, -1).join("/")));
$("mkdir").onclick = () => guard(async () => {
  const n = await ask("Folder name:", "");
  if (n && n.trim()) { await api("POST", "/drive/mkdir", { path: cwd ? `${cwd}/${n.trim()}` : n.trim() }); loadDrive(); }
});

// ------------------------------------------------ start

async function boot() {
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
    $("showColab").classList.remove("hidden");
  }
  await renderSetup();
  if (connected && signedIn) {
    guard(() => loadDrive(cwd));
    guard(loadJobs);
    guard(loadChats);
  }
}

setInterval(async () => {
  const was = connected && signedIn;
  await refreshStatus();
  if (was !== (connected && signedIn)) boot();
}, 15000);
setInterval(() => { if (connected && signedIn) loadJobs().catch(() => {}); }, 2000);
boot();
})();
