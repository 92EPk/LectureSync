// LectureSync download site — theme and live GitHub Release data (no per-version edits needed).
(() => {
  const REPO = "92EPK/LectureSync";
  const root = document.documentElement;
  const $ = (s) => document.querySelector(s);

  const T = {
    en: { dl: "Download for", latest: "Latest", free: "free & open source", none: "No release published yet — the first build is coming soon.", soon: "Available with the first release", notin: "Not included in this release", sums: "Checksums will appear here once a release is published." },
  };

  // Store English originals once, then swap.
  const nodes = [...document.querySelectorAll("[data-i18n],[data-i18n-html]")];
  nodes.forEach((n) => (n._en = n.innerHTML));
  const lang = "en";
  let release = null;

  const applyLang = () => {
    root.lang = "en"; root.dir = "ltr";
    renderRelease();
  };
  $("#themeBtn").onclick = () => {
    const t = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = t; localStorage.setItem("ls-theme", t);
  };

  // OS detection
  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua) ? "windows" : /Mac/i.test(ua) ? "mac" : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? "linux" : null;
  if (os) document.querySelector(`.card[data-os="${os}"]`)?.classList.add("mine");
  const osName = { windows: "Windows", mac: "macOS", linux: "Linux" };

  const size = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : Math.round(b / 1e6) + " MB");
  const label = (n) =>
    /Portable/i.test(n) ? "Portable · .exe" : /Setup/i.test(n) ? "Installer · .exe" :
    /arm64.*\.dmg$/i.test(n) ? "Apple Silicon · .dmg" : /\.dmg$/i.test(n) ? "Intel · .dmg" :
    /arm64.*\.zip$/i.test(n) ? "Apple Silicon · .zip" : /\.zip$/i.test(n) ? "Intel · .zip" :
    /AppImage$/i.test(n) ? "AppImage" : /\.deb$/i.test(n) ? "Debian / Ubuntu · .deb" : n;

  function renderRelease() {
    const t = T[lang];
    if (!release) {
      $("#releaseMeta").textContent = release === false ? t.none : "…";
      if (release === false) {
        document.querySelectorAll(".files").forEach((ul) => (ul.innerHTML = `<li class="muted">${t.soon}</li>`));
        $("#sums").textContent = t.sums;
      }
      if (os) $("#primaryLabel").textContent = `${t.dl} ${osName[os]}`;
      return;
    }
    const rel = release;
    const assets = rel.assets.filter((a) => !/blockmap|\.yml$/i.test(a.name));
    const date = new Date(rel.published_at).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
    $("#releaseMeta").textContent = `${t.latest}: ${rel.tag_name} · ${date} · ${t.free}`;
    document.querySelectorAll(".files").forEach((ul) => {
      const re = new RegExp(ul.dataset.match, "i");
      const list = assets.filter((a) => re.test(a.name));
      ul.innerHTML = list.length
        ? list.map((a) => `<li><a href="${a.browser_download_url}"><span>${label(a.name)}</span><small>${size(a.size)}</small></a></li>`).join("")
        : `<li class="muted">${t.notin}</li>`;
    });
    const pick = {
      windows: assets.find((a) => /Setup.*\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name)),
      mac: assets.find((a) => /arm64.*\.dmg$/i.test(a.name)) || assets.find((a) => /\.dmg$/i.test(a.name)),
      linux: assets.find((a) => /\.AppImage$/i.test(a.name)),
    }[os];
    if (pick) {
      $("#primaryBtn").href = pick.browser_download_url;
      $("#primaryLabel").textContent = `${t.dl} ${osName[os]} · ${rel.tag_name}`;
    }
    const sums = assets.find((a) => /SHA256SUMS/i.test(a.name));
    $("#sums").innerHTML = sums
      ? `<a href="${sums.browser_download_url}">${sums.name}</a>\n\n# macOS / Linux\nshasum -a 256 -c ${sums.name} --ignore-missing\n\n# Windows (PowerShell)\nGet-FileHash .\\LectureSync*.exe -Algorithm SHA256`
      : t.sums;
  }

  applyLang();
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => { release = j; renderRelease(); })
    .catch(() => { release = false; renderRelease(); });
})();
