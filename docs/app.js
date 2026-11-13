// LectureSync site — language (EN/AR), theme, screenshots, OS detection, live GitHub release data.
(() => {
  const REPO = "92EPK/LectureSync";
  const root = document.documentElement;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const AR = {
    nav1: "المسارات", nav2: "آلية العمل", nav3: "المزايا", nav4: "التحميل", nav5: "أسئلة شائعة",
    h1: "محاضراتك تنتقل.<br /><em>وباقتك كما هي.</em>",
    lead: "ينقل LectureSync ملفات بأحجام الجيجابايت بين <b>تليجرام</b> و<b>Google Drive</b> و<b>OneDrive / SharePoint</b> و<b>الروابط</b> — داخل حساب Google Colab الخاص بك. لا يمر عبر اتصالك سوى أوامر بحجم بضعة كيلوبايتات.",
    dl: "حمّل مجانًا", see: "تعرّف على آلية العمل",
    t1: "تليجرام ← السحابة", t2: "السحابة ← تليجرام", t3: "الروابط", t4: "سحابة ⇄ سحابة",
    s1: "من باقتك لكل محاضرة", s2: "اتصالات متوازية بتليجرام", s3: "فك تشفير مُسرَّع بلغة C", s4: "خدمتا تخزين، وفي كل الاتجاهات",
    e1: "01 — المسارات", h2a: "أربعة مسارات. سحابتان. كل الاتجاهات.",
    p1t: "تليجرام ← Drive / OneDrive", p1d: "اختر الملفات من أي محادثة أو الصق رابط t.me. تُفك الملفات المضغوطة (zip وrar و7z والأجزاء المقسمة) تلقائيًا عند وصولها.",
    p2t: "Drive / OneDrive ← تليجرام", p2d: "أرسل ملفات أو مجلدات كاملة إلى أي محادثة أو قناة. ما يتجاوز حد تليجرام يُقسَّم — بعد موافقتك فقط.",
    p3t: "من رابط إلى أي وجهة", p3d: "يوتيوب (والقوائم كاملة) وSharePoint وOneDrive وDrive وDropbox وMediaFire أو أي رابط مباشر — إلى أي من السحابتين أو تليجرام.",
    p4t: "Drive ⇄ OneDrive", p4d: "انسخ بين خدمتي Google وMicrosoft مباشرةً من مركز بيانات إلى آخر، في الاتجاهين.",
    e2: "02 — آلية العمل", h2b: "جهازك يُصدر الأوامر، وشبكة Google تتولى النقل.",
    f1s: "جهازك", f1: "تطبيق LectureSync", f1d: "أوامر فقط", f2s: "جهاز Colab الخاص بك", gb: "جيجابايتات",
    c0a: "الطريقة اليدوية", c1: "البيانات المارة عبر اتصالك", c1a: "حجم الملف مرتين", c2: "المساحة المطلوبة على جهازك", c2a: "الملف المضغوط ونسخته المفكوكة",
    none: "لا شيء", c3: "فك الضغط", c3a: "يدويًا", auto: "تلقائي", c4: "خدمات التخزين", c4a: "واحدة في كل مرة", c4b: "Drive وOneDrive، في الاتجاهين",
    e3: "03 — المزايا", h2c: "مصمَّم لمحتوى المقررات الحقيقي.",
    b1t: "OneDrive وSharePoint بشكل متكامل", b1d: "حسابات شخصية وجامعية عبر تسجيل الدخول من المتصفح أو برمز الجهاز، دون الحاجة لموافقة مسؤول. مكتبات SharePoint الخاصة بمقرراتك، ومدير ملفات، ومتابعة المساحة المتاحة.",
    b2t: "اتصالات MTProto متوازية", b2d: "حتى 8 اتصالات مستقلة بمركز البيانات الذي يحتوي الملف، مع انتظار تلقائي عند تقييد الطلبات.",
    b3t: "تشفير tgcrypto", b3d: "تشفير بلغة C يرفع السرعة من 0.4 إلى أكثر من 130 ميجابايت/ث، مع بديل آمن إن تعذّر تثبيته.",
    b4t: "ضغط ذكي", b4d: "إعادة ترميز بـ FFmpeg مضبوطة للمحاضرات تحافظ على وضوح الشرائح بحجم أصغر كثيرًا.",
    b5t: "قوائم التشغيل كما تريد", b5d: "فيديوهات منفصلة، أو أرشيف 7-Zip واحد مقسَّم بأجزاء تناسب تليجرام.",
    b6t: "الخصوصية أساس التصميم", b6d: "ربط آمن بنقرة واحدة من Colab، ومفاتيحك محفوظة في خزنة نظام التشغيل، وجلساتك في Drive الخاص بك. لا يمر شيء عبرنا.",
    e4: "04 — التحميل", h2d: "مجاني لكل طالب.",
    unsigned: "الإصدارات غير موقَّعة رقميًا بعد، لذا قد يظهر تحذير من Windows أو macOS عند أول تشغيل. تحقق من الملف عبر بصمات SHA-256 المنشورة مع كل إصدار.",
    q1: "أضف مفاتيح Telegram API من my.telegram.org.", q2: "اضغط «تشغيل محرك Colab» ثم Run في Colab.", q3: "اضغط «Connect to LectureSync» — دون نسخ أو منافذ.", q4: "امسح رمز QR مرة واحدة، اختر المسار، وأرسل.",
    e5: "05 — أسئلة شائعة", h2e: "إجابات لأسئلتك.",
    fa1: "هل حقًا لا يستهلك من باقتي؟", fb1: "تنتقل بيانات الملفات فقط بين تليجرام وGoogle وMicrosoft وجهاز Colab الخاص بك. جهازك يرسل أوامر صغيرة ويستقبل نسبة التقدم.",
    fa2: "ما سرعة التحميل من تليجرام؟", fb2: "يحدّ تليجرام سرعة الحسابات المجانية عند 5–6 ميجابايت/ث تقريبًا — نحو 3 دقائق لكل جيجابايت. أما حسابات Premium فتصل إلى 30–50 ميجابايت/ث أو أكثر بنفس التطبيق.",
    fa3: "هل يمكنني استخدام حساب Microsoft الجامعي؟", fb3: "نعم. سجّل الدخول برمز الجهاز إن كان المتصفح مقيدًا، ولا تحتاج لموافقة قسم تقنية المعلومات.",
    fa4: "لماذا يقول Colab إن الملف «not authored by Google»؟", fb4: "تعرض Google هذه الرسالة لأي ملف يُفتح من GitHub. اختر «Run anyway» — الكود كاملًا ظاهر أمامك.",
    foot: 'صمّمه وطوّره <a class="author" href="https://github.com/92EPK" target="_blank" rel="noopener">أحمد عمران</a> — مبادرة طلابية مجانية لدارسي دبلومة علوم الحاسب، كلية الدراسات العليا للبحوث الإحصائية (FGSSR).',
    fc1: "المنتج", fc2: "المشروع", fc3: "الإصدارات", fc4: "الإبلاغ عن مشكلة", fc5: "العودة للأعلى ↑",
  };
  const EN = {};
  $$("[data-k]").forEach((el) => (EN[el.dataset.k] = el.innerHTML));
  const applyLang = (l) => {
    root.lang = l; root.dir = l === "ar" ? "rtl" : "ltr"; localStorage.setItem("ls-lang", l);
    $$("[data-k]").forEach((el) => { const v = (l === "ar" ? AR : EN)[el.dataset.k]; if (v) el.innerHTML = v; });
    $("#langBtn").textContent = l === "ar" ? "English" : "عربي";
    render(lastRel);
  };
  $("#langBtn").onclick = () => applyLang(root.lang === "ar" ? "en" : "ar");

  const setShots = () => $$(".shot-frame img").forEach((i) => (i.src = i.dataset[root.dataset.theme]));
  $("#themeBtn").onclick = () => { const t = root.dataset.theme === "dark" ? "light" : "dark"; root.dataset.theme = t; localStorage.setItem("ls-theme", t); setShots(); };
  setShots();
  const tabs = $$(".shot-tabs button"), imgs = $$(".shot-frame img");
  let cur = 0, timer;
  const show = (i) => { cur = i; tabs.forEach((b, j) => b.classList.toggle("on", j === i)); imgs.forEach((m, j) => m.classList.toggle("on", j === i)); };
  tabs.forEach((b) => (b.onclick = () => { clearInterval(timer); show(+b.dataset.i); }));
  timer = setInterval(() => show((cur + 1) % 3), 4500);

  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua) ? "windows" : /Mac/i.test(ua) ? "mac" : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? "linux" : null;
  const osName = { windows: "Windows", mac: "macOS", linux: "Linux" };
  if (os) $(`.card[data-os="${os}"]`)?.classList.add("mine");

  const size = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : Math.round(b / 1e6) + " MB");
  const label = (n) =>
    /Portable/i.test(n) ? "Portable · .exe" : /Setup/i.test(n) ? "Installer · .exe" :
    /arm64.*\.dmg$/i.test(n) ? "Apple Silicon · .dmg" : /\.dmg$/i.test(n) ? "Intel · .dmg" :
    /arm64.*\.zip$/i.test(n) ? "Apple Silicon · .zip" : /\.zip$/i.test(n) ? "Intel · .zip" :
    /AppImage$/i.test(n) ? "AppImage" : /\.deb$/i.test(n) ? "Debian / Ubuntu · .deb" : n;

  let lastRel = null;
  function render(rel) {
    lastRel = rel;
    const ar = root.lang === "ar";
    const forOs = os ? (ar ? `حمّل لنظام ${osName[os]}` : `Download for ${osName[os]}`) : null;
    if (forOs) $("#primaryLabel").textContent = forOs;
    if (!rel) {
      $$(".files").forEach((ul) => (ul.innerHTML = `<li class="muted"><a href="https://github.com/${REPO}/releases/latest">${ar ? "صفحة الإصدارات على GitHub" : "GitHub Releases"} →</a></li>`));
      return;
    }
    const assets = rel.assets.filter((a) => !/blockmap|\.yml$/i.test(a.name));
    const date = new Date(rel.published_at).toLocaleDateString(ar ? "ar-EG" : "en-GB", { year: "numeric", month: "short", day: "numeric" });
    $("#relPill").textContent = ar ? `الإصدار ${rel.tag_name} متاح الآن` : `${rel.tag_name} is out — see what’s new`;
    $("#releaseMeta").textContent = `${rel.tag_name} · ${date} · Windows · macOS · Linux`;
    $$(".files").forEach((ul) => {
      const list = assets.filter((a) => new RegExp(ul.dataset.match, "i").test(a.name));
      ul.innerHTML = list.length
        ? list.map((a) => `<li><a href="${a.browser_download_url}"><span>${label(a.name)}</span><small>${size(a.size)}</small></a></li>`).join("")
        : `<li class="muted">${ar ? "غير متاح في هذا الإصدار" : "Not in this release"}</li>`;
    });
    const pick = {
      windows: assets.find((a) => /Setup.*\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name)),
      mac: assets.find((a) => /arm64.*\.dmg$/i.test(a.name)) || assets.find((a) => /\.dmg$/i.test(a.name)),
      linux: assets.find((a) => /\.AppImage$/i.test(a.name)) || assets.find((a) => /\.deb$/i.test(a.name)),
    }[os];
    if (pick) { $("#primaryBtn").href = pick.browser_download_url; $("#primaryLabel").textContent = `${forOs} · ${rel.tag_name}`; }
  }

  $("#yr").textContent = new Date().getFullYear();
  if (root.lang === "ar") applyLang("ar"); else render(null);
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`).then((r) => (r.ok ? r.json() : Promise.reject())).then(render).catch(() => {});
  fetch(`https://api.github.com/repos/${REPO}`).then((r) => (r.ok ? r.json() : Promise.reject())).then((j) => ($("#stars").textContent = j.stargazers_count)).catch(() => {});
})();
