// LectureSync site — theme, OS detection, live GitHub release data, showcase tabs.
(() => {
  const REPO = "92EPK/LectureSync";
  const root = document.documentElement;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  $("#themeBtn").onclick = () => {
    const t = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = t; localStorage.setItem("ls-theme", t);
  };

  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua) ? "windows" : /Mac/i.test(ua) ? "mac" : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? "linux" : null;
  const osName = { windows: "Windows", mac: "macOS", linux: "Linux" };
  if (os) $(`.card[data-os="${os}"]`)?.classList.add("mine");

  $$("[data-os-link]").forEach((a) => {
    if (a.dataset.osLink === os) { const s = a.nextElementSibling; if (s?.tagName === "SPAN") s.remove(); else a.previousElementSibling?.tagName === "SPAN" && a.previousElementSibling.remove(); a.remove(); return; }
    a.onclick = (e) => {
      e.preventDefault();
      const card = $(`.card[data-os="${a.dataset.osLink}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      card?.classList.add("flash"); setTimeout(() => card?.classList.remove("flash"), 1400);
    };
  });

  // Showcase tabs
  const tabs = $$(".mtab"), panes = $$(".mpane"), caps = $$(".mcap");
  tabs.forEach((b) => (b.onclick = () => {
    const i = +b.dataset.m;
    [tabs, panes, caps].forEach((g) => g.forEach((x, j) => x.classList.toggle("on", j === i)));
  }));

  const size = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : Math.round(b / 1e6) + " MB");
  const label = (n) =>
    /Portable/i.test(n) ? "Portable · .exe" : /Setup/i.test(n) ? "Installer · .exe" :
    /arm64.*\.dmg$/i.test(n) ? "Apple Silicon · .dmg" : /\.dmg$/i.test(n) ? "Intel · .dmg" :
    /arm64.*\.zip$/i.test(n) ? "Apple Silicon · .zip" : /\.zip$/i.test(n) ? "Intel · .zip" :
    /AppImage$/i.test(n) ? "AppImage" : /\.deb$/i.test(n) ? "Debian / Ubuntu · .deb" : n;

  function render(rel) {
    if (os) $("#primaryLabel").textContent = `Download for ${osName[os]}`;
    if (!rel) {
      $("#releaseMeta").textContent = "Release info unavailable — see GitHub Releases.";
      $$(".files").forEach((ul) => (ul.innerHTML = `<li class="muted">See GitHub Releases</li>`));
      return;
    }
    const assets = rel.assets.filter((a) => !/blockmap|\.yml$/i.test(a.name));
    const date = new Date(rel.published_at).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
    $("#releaseMeta").textContent = `${rel.tag_name} · released ${date} · free & open source`;
    $("#relPill").textContent = `${rel.tag_name} is out`;
    $$(".files").forEach((ul) => {
      const re = new RegExp(ul.dataset.match, "i");
      const list = assets.filter((a) => re.test(a.name));
      ul.innerHTML = list.length
        ? list.map((a) => `<li><a href="${a.browser_download_url}"><span>${label(a.name)}</span><small>${size(a.size)}</small></a></li>`).join("")
        : `<li class="muted">Not included in this release</li>`;
    });
    const pick = {
      windows: assets.find((a) => /Setup.*\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name)),
      mac: assets.find((a) => /arm64.*\.dmg$/i.test(a.name)) || assets.find((a) => /\.dmg$/i.test(a.name)),
      linux: assets.find((a) => /\.AppImage$/i.test(a.name)) || assets.find((a) => /\.deb$/i.test(a.name)),
    }[os];
    if (pick) { $("#primaryBtn").href = pick.browser_download_url; $("#primaryLabel").textContent = `Download for ${osName[os]} · ${rel.tag_name}`; }
    const sums = assets.find((a) => /SHA256SUMS/i.test(a.name));
    if (sums) $("#sums").innerHTML = `<a href="${sums.browser_download_url}">${sums.name}</a>\n\n# macOS / Linux\nshasum -a 256 -c ${sums.name} --ignore-missing\n\n# Windows (PowerShell)\nGet-FileHash .\\LectureSync*.exe -Algorithm SHA256`;
  }

  render(null);
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`).then((r) => (r.ok ? r.json() : Promise.reject())).then(render).catch(() => render(null));
  fetch(`https://api.github.com/repos/${REPO}`).then((r) => (r.ok ? r.json() : Promise.reject())).then((j) => ($("#stars").textContent = j.stargazers_count)).catch(() => $("#stars").remove());
})();
