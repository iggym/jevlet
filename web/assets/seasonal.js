// Seasonal adornments + "Seasonal Tools & Multi-App Showcase". Plain ES module, no deps.
// Season is picked from the visitor's date (Northern Hemisphere months); ?season=<name> previews one.
// Card content describes only real Jevlet features (checked by test/seasonal.test.mjs).

export const SEASONS = ["autumn", "winter", "spring", "summer"];
export const MAX_PARTICLES = { desktop: 14, mobile: 7 };

export function pickSeason(date = new Date(), override = null) {
  if (override && SEASONS.includes(override)) return override;
  const m = date.getMonth(); // 0 = Jan
  if (m >= 8 && m <= 10) return "autumn"; // Sep–Nov
  if (m === 11 || m <= 1) return "winter"; // Dec–Feb
  if (m <= 4) return "spring"; // Mar–May
  return "summer"; // Jun–Aug
}

export const HERO = {
  autumn: {
    base: "/assets/img/hero-autumn",
    alt: "Forest path under golden autumn beech trees in soft morning light",
    credit: { by: "Dietmar Rabich", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", page: "https://commons.wikimedia.org/wiki/File:D%C3%BClmen,_B%C3%B6rnste,_Waldweg_--_2015_--_4649.jpg" },
  },
  winter: {
    base: "/assets/img/hero-winter",
    alt: "Frost-covered trees beside a white field on a cold winter morning",
    credit: { by: "Dietmar Rabich", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", page: "https://commons.wikimedia.org/wiki/File:D%C3%BClmen,_Kirchspiel,_Dernekamp,_B%C3%A4ume_--_2021_--_9397.jpg" },
  },
  spring: null, // simple gradient fallback, no photo
  summer: null,
};

export const CATEGORIES = [
  { id: "all", label: "All Apps" },
  { id: "seasonal", label: "Seasonal Specials" },
  { id: "productivity", label: "Productivity" },
  { id: "utilities", label: "Utilities" },
];

// Real Jevlet tools only. `tab` = UI tab to open, `topic` = help modal (assets/help.js).
export const CARDS = [
  { id: "csqa", example: "decide-csqa", cat: "productivity", icon: "choice", title: "Multiple choice · csqa", tag: "Adapter · choice", tab: "decide", adapter: "csqa", topic: "adapters",
    desc: "Pick the single most sensible answer from your own list of 2–10 options. Returns the label with a probability for every option, or an explicit abstain." },
  { id: "policy_check", example: "decide-policy", cat: "productivity", icon: "scale", title: "Policy check", tag: "Adapter · boolean", tab: "decide", adapter: "policy_check", topic: "adapters",
    desc: "Does a case comply with a policy? A true/false decision judged only from the text you provide, with its confidence." },
  { id: "batch", example: "batch", cat: "productivity", icon: "layers", title: "Batch runner", tag: "In this app", tab: "batch", topic: "batch",
    desc: "Paste one JSON request per line, run them 4 at a time, and export every row to CSV." },
  { id: "calibrate", example: "calibrate", cat: "productivity", icon: "target", title: "Calibrate", tag: "In this app", tab: "calibrate", topic: "calibration",
    desc: "Label past decisions with the truth. After 200 labels for an adapter, your key gets a fitted temperature, with ECE shown before and after." },
  { id: "usage", example: "usage", cat: "utilities", icon: "gauge", title: "Usage dashboard", tag: "In this app", tab: "usage", topic: "usage",
    desc: "Units and requests used today against your daily cap, plus calibration status per adapter." },
  { id: "plans", example: "checkout", cat: "utilities", icon: "card", title: "Plans & billing", tag: "In this app", tab: "plans", topic: "plans",
    desc: "Free $0 · 100 units/day, Pro $19/mo · 5,000/day, Team $99/mo · 50,000/day. Upgrade through Stripe Checkout." },
  { id: "quickstart", example: "adapters", cat: "utilities", icon: "code", title: "API quickstart", tag: "Docs", topic: "quickstart",
    desc: "Copy-paste curl examples for decide, adapters, usage, calibrate, and checkout, using this site's base URL." },
  { id: "eval", cat: "utilities", icon: "chart", title: "Eval runner", tag: "CLI · npm run eval", topic: "eval",
    desc: "Scores a JSONL set against a deployed instance: accuracy on kept decisions, abstention rate, units per decision, p50/p95 latency." },
  { id: "mkkey", example: "keys-create", cat: "utilities", icon: "key", title: "Key minting", tag: "CLI · tools/mkkey.mjs", topic: "keys",
    desc: "Mints a jvl_ API key with a daily cap and tier. The token prints once; only its SHA-256 hash is stored." },
];

const ICONS = {
  choice: '<path d="M4 6h10M4 12h10M4 18h10"/><path d="m17 11 2 2 3-4"/>',
  scale: '<path d="M12 3v18M5 21h14M6 7h12"/><path d="m6 7-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="m12 16 4-5"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h4"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 6l-2 12"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
};

// Custom seasonal icons (inline SVG, currentColor-friendly).
const SEASON_ICONS = {
  pinecone: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4v6" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M24 10c-9 0-14 9-14 17 0 9 6 17 14 17s14-8 14-17c0-8-5-17-14-17z" fill="var(--s-cinnamon)"/><path d="M14 22c4 2 16 2 20 0M12 30c5 3 19 3 24 0M15 38c4 2 14 2 18 0M24 10v34M18 13l6 9 6-9" stroke="rgba(0,0,0,.28)" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  pumpkin: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 12c0-4 2-7 6-8" stroke="var(--s-forest)" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="15" cy="28" rx="10" ry="13" fill="var(--s-terracotta)"/><ellipse cx="33" cy="28" rx="10" ry="13" fill="var(--s-terracotta)"/><ellipse cx="24" cy="28" rx="9" ry="14" fill="#de6b48"/><path d="M24 15v26" stroke="rgba(0,0,0,.18)" stroke-width="2"/></svg>',
  snowflake: '<svg viewBox="0 0 48 48" aria-hidden="true"><g stroke="var(--s-azure)" stroke-width="3" stroke-linecap="round" fill="none"><path d="M24 4v40M6.7 14l34.6 20M6.7 34l34.6-20"/><path d="m18 8 6 6 6-6M18 40l6-6 6 6M6 21l8-1-3-7M42 27l-8 1 3 7M6 27l8 1-3 7M42 21l-8-1 3-7"/></g></svg>',
  wheat: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 44V10" stroke="var(--s-cinnamon)" stroke-width="2.5" stroke-linecap="round"/><g fill="var(--s-gold)"><ellipse cx="24" cy="8" rx="3" ry="5"/><ellipse cx="19" cy="16" rx="3" ry="5" transform="rotate(-30 19 16)"/><ellipse cx="29" cy="16" rx="3" ry="5" transform="rotate(30 29 16)"/><ellipse cx="19" cy="25" rx="3" ry="5" transform="rotate(-30 19 25)"/><ellipse cx="29" cy="25" rx="3" ry="5" transform="rotate(30 29 25)"/><ellipse cx="19" cy="34" rx="3" ry="5" transform="rotate(-30 19 34)"/><ellipse cx="29" cy="34" rx="3" ry="5" transform="rotate(30 29 34)"/></g></svg>',
  leaf: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M40 6C22 6 8 14 8 30c0 5 2 9 4 12 2-10 10-18 20-22-9 6-14 13-16 23 18 2 28-12 24-37z" fill="var(--s-gold)"/></svg>',
  sun: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="9" fill="var(--s-sun)"/><g stroke="var(--s-sun)" stroke-width="3" stroke-linecap="round"><path d="M24 4v6M24 38v6M4 24h6M38 24h6M10 10l4 4M34 34l4 4M10 38l4-4M34 14l4-4"/></g></svg>',
  sprout: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 44V22" stroke="var(--s-forest)" stroke-width="3" stroke-linecap="round"/><path d="M24 24c0-9-7-14-16-14 0 9 7 14 16 14zM24 20c0-8 6-13 15-13 0 8-6 13-15 13z" fill="var(--s-sage)"/></svg>',
};
export const SEASON_SET = {
  autumn: { label: "Autumn", icons: ["leaf", "pumpkin", "pinecone", "wheat"], particles: "leaves", tagline: "Harvest-season edition" },
  winter: { label: "Winter", icons: ["snowflake", "pinecone", "snowflake"], particles: "snow", tagline: "Frosty-morning edition" },
  spring: { label: "Spring", icons: ["sprout", "leaf"], particles: null, tagline: "Spring edition" },
  summer: { label: "Summer", icons: ["sun", "wheat"], particles: null, tagline: "Summer edition" },
};

if (typeof document !== "undefined") init();

function init() {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mqReduce = matchMedia("(prefers-reduced-motion: reduce)");
  const params = new URLSearchParams(location.search);
  const season = pickSeason(new Date(), params.get("season"));
  const set = SEASON_SET[season];
  document.documentElement.dataset.season = season;

  // ---------- hero ----------
  const hero = document.createElement("header");
  hero.className = "s-hero";
  const h = HERO[season];
  hero.innerHTML = `
    ${h ? `<img class="s-hero-img" alt="${esc(h.alt)}" width="1600" height="640" decoding="async" fetchpriority="high"
           srcset="${h.base}-800.webp 800w, ${h.base}-1600.webp 1600w" sizes="100vw" src="${h.base}-800.webp">` : ""}
    <div class="s-hero-glass">
      <span class="s-badge">${esc(set.label)} · ${esc(set.tagline)}</span>
      <p class="s-hero-title">Typed decisions, in season.</p>
      <p class="s-hero-sub">Structured input in; a typed choice or true/false out, with a calibrated probability or an explicit abstain.</p>
      <div class="s-hero-icons">${set.icons.map((n) => `<span class="s-icon" title="${esc(n)}">${SEASON_ICONS[n]}</span>`).join("")}</div>
      <div class="s-hero-cta">
        <a class="s-chip s-chip-key" href="#get-key">Get a free API key</a>
        <a class="s-chip" href="#showcase">Browse tools</a>
        <button type="button" class="s-chip" data-help="decision">How it works</button>
        <button type="button" class="s-chip s-fx" aria-pressed="true">Seasonal effects: on</button>
      </div>
    </div>
    ${h ? `<p class="s-credit">Photo: <a href="${h.credit.page}" target="_blank" rel="noopener">${esc(h.credit.by)}</a>, <a href="${h.credit.licenseUrl}" target="_blank" rel="noopener">${esc(h.credit.license)}</a>, via Wikimedia Commons</p>` : ""}`;
  document.body.prepend(hero);

  // ---------- showcase ----------
  const sec = document.createElement("section");
  sec.className = "s-showcase";
  sec.id = "showcase";
  sec.setAttribute("aria-labelledby", "s-showcase-title");
  sec.innerHTML = `
    <div class="s-showcase-head">
      <h2 id="s-showcase-title"><span class="s-icon s-icon-sm">${SEASON_ICONS[set.icons[0]]}</span> Seasonal Tools &amp; Multi-App Showcase</h2>
      <p class="muted">Every tool that ships with Jevlet: the adapters, the tabs in this app, and the command-line helpers.</p>
    </div>
    <div class="s-pills" role="group" aria-label="Filter tools">
      ${CATEGORIES.map((c, i) => `<button type="button" class="s-pill" data-cat="${c.id}" aria-pressed="${i === 0}">${esc(c.label)} <span class="s-count">${c.id === "all" ? CARDS.length : CARDS.filter((x) => x.cat === c.id).length}</span></button>`).join("")}
    </div>
    <p class="s-live" aria-live="polite"></p>
    <div class="s-grid" tabindex="0" role="list" aria-label="Jevlet tools (scroll horizontally on small screens)">
      ${CARDS.map((c) => `
        <article class="s-card" role="listitem" data-cat="${c.cat}" aria-labelledby="sc-${c.id}">
          <div class="s-thumb"><img src="/assets/img/apps/${c.id}.webp" alt="Screenshot: ${esc(c.title)}" width="480" height="300" loading="lazy" decoding="async"></div>
          <div class="s-card-body">
            <div class="s-card-top"><span class="s-ficon" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[c.icon]}</svg></span><span class="s-tag">${esc(c.tag)}</span></div>
            <h3 id="sc-${c.id}">${esc(c.title)}</h3>
            <p>${esc(c.desc)}</p>
            <div class="s-card-actions">
              <button type="button" class="s-act" data-help="${c.topic}" aria-label="Learn more about ${esc(c.title)}">Learn more</button>
              ${c.example ? `<button type="button" class="s-act" data-example="${c.example}" aria-label="Worked example for ${esc(c.title)}">Example</button>` : ""}
              ${c.tab ? `<button type="button" class="s-act s-act-go" data-open-tab="${c.tab}" ${c.adapter ? `data-adapter="${c.adapter}"` : ""} aria-label="Open ${esc(c.title)}">Open</button>` : ""}
            </div>
          </div>
        </article>`).join("")}
      <div class="s-empty" hidden>
        <span class="s-icon">${SEASON_ICONS[set.icons[0]]}</span>
        <h3>No seasonal specials right now</h3>
        <p>Every Jevlet tool works year-round, so there's nothing seasonal-only to show. Try <button type="button" class="s-linkbtn" data-cat-jump="all">All Apps</button>.</p>
      </div>
    </div>`;
  const main = $("main");
  main.after(sec);

  // Filtering with animated exit/enter
  const cards = [...sec.querySelectorAll(".s-card")];
  const empty = $(".s-empty", sec);
  const live = $(".s-live", sec);
  let filterTimer = null;
  function applyFilter(cat) {
    sec.querySelectorAll(".s-pill").forEach((p) => p.setAttribute("aria-pressed", String(p.dataset.cat === cat)));
    const show = (c) => cat === "all" || c.dataset.cat === cat;
    const n = cards.filter(show).length;
    clearTimeout(filterTimer);
    const finish = () => {
      cards.forEach((c) => { c.hidden = !show(c); });
      empty.hidden = n > 0;
      requestAnimationFrame(() => cards.forEach((c) => { if (show(c)) c.classList.remove("s-out"); }));
    };
    if (mqReduce.matches) { cards.forEach((c) => c.classList.toggle("s-out", false)); finish(); }
    else { cards.forEach((c) => { if (!show(c)) c.classList.add("s-out"); }); filterTimer = setTimeout(finish, 200); }
    live.textContent = n ? `Showing ${n} tool${n === 1 ? "" : "s"}` : "No tools in this category";
    $(".s-grid", sec).scrollLeft = 0;
  }
  sec.addEventListener("click", (e) => {
    const p = e.target.closest(".s-pill");
    if (p) applyFilter(p.dataset.cat);
    const j = e.target.closest("[data-cat-jump]");
    if (j) applyFilter(j.dataset.catJump);
    const o = e.target.closest("[data-open-tab]");
    if (o) {
      const tab = document.querySelector(`nav button[data-tab="${o.dataset.openTab}"]`);
      if (tab) tab.click();
      if (o.dataset.adapter) {
        const sel = $("#d-adapter");
        if (sel && [...sel.options].some((x) => x.value === o.dataset.adapter)) { sel.value = o.dataset.adapter; sel.dispatchEvent(new Event("change")); }
      }
      main.scrollIntoView({ behavior: mqReduce.matches ? "auto" : "smooth", block: "start" });
      (tab || main).focus({ preventScroll: true });
    }
  });

  // ---------- particles (leaves / snow) + frost overlay ----------
  if (season === "winter") {
    const frost = document.createElement("div");
    frost.className = "s-frost";
    frost.setAttribute("aria-hidden", "true");
    document.body.appendChild(frost);
  }
  const FX_KEY = "jevlet_fx";
  const fxBtn = $(".s-fx", hero);
  let fxOn = (() => { try { return localStorage.getItem(FX_KEY) !== "off"; } catch { return true; } })();
  let engine = null;
  const syncFx = () => {
    const can = !!set.particles && !mqReduce.matches;
    fxBtn.hidden = !set.particles;
    fxBtn.disabled = mqReduce.matches;
    fxBtn.setAttribute("aria-pressed", String(fxOn && can));
    fxBtn.textContent = mqReduce.matches ? "Seasonal effects: off (reduced motion)" : `Seasonal effects: ${fxOn ? "on" : "off"}`;
    if (fxOn && can) { if (!engine) engine = startParticles(set.particles); }
    else if (engine) { engine.stop(); engine = null; }
  };
  fxBtn.addEventListener("click", () => { fxOn = !fxOn; try { localStorage.setItem(FX_KEY, fxOn ? "on" : "off"); } catch {} syncFx(); });
  mqReduce.addEventListener?.("change", syncFx);
  syncFx();

  function startParticles(kind) {
    const cv = document.createElement("canvas");
    cv.className = "s-particles";
    cv.setAttribute("aria-hidden", "true");
    document.body.appendChild(cv);
    const ctx = cv.getContext("2d");
    const mobile = matchMedia("(max-width: 640px)").matches;
    const N = mobile ? MAX_PARTICLES.mobile : MAX_PARTICLES.desktop;
    const COLORS = kind === "leaves" ? ["#e0a526", "#d9822b", "#c8553d", "#b5651d", "#f2c14e"] : ["#ffffff", "#dff0ff", "#bfe0fb"];
    const leaf = new Path2D("M0 -10 C6 -8 9 -2 7 4 C5 9 1 11 0 12 C-1 11 -5 9 -7 4 C-9 -2 -6 -8 0 -10 Z M0 -10 L0 14");
    let W = 0, H = 0, dpr = 1, raf = 0, last = 0;
    const resize = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      W = innerWidth; H = innerHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const spawn = (p = {}, top = false) => Object.assign(p, {
      x: Math.random() * W, y: top ? -20 - Math.random() * 60 : Math.random() * H,
      s: kind === "leaves" ? 0.7 + Math.random() * 0.7 : 1.5 + Math.random() * 2.5,
      vy: kind === "leaves" ? 22 + Math.random() * 28 : 18 + Math.random() * 22,
      amp: 12 + Math.random() * 26, f: 0.4 + Math.random() * 0.7, ph: Math.random() * 6.28,
      r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 1.6,
      c: COLORS[(Math.random() * COLORS.length) | 0], a: kind === "leaves" ? 0.55 + Math.random() * 0.3 : 0.5 + Math.random() * 0.4,
    });
    const ps = Array.from({ length: N }, () => spawn());
    const frame = (t) => {
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      ctx.clearRect(0, 0, W, H);
      for (const p of ps) {
        p.y += p.vy * dt; p.ph += p.f * dt; p.r += p.vr * dt;
        const x = p.x + Math.sin(p.ph) * p.amp;
        if (p.y > H + 24) spawn(p, true);
        ctx.globalAlpha = p.a;
        ctx.fillStyle = p.c;
        if (kind === "leaves") {
          ctx.save(); ctx.translate(x, p.y); ctx.rotate(p.r); ctx.scale(p.s, p.s);
          ctx.fill(leaf); ctx.strokeStyle = "rgba(90,40,10,.35)"; ctx.lineWidth = 0.8; ctx.stroke(leaf);
          ctx.restore();
        } else {
          ctx.beginPath(); ctx.arc(x, p.y, p.s, 0, 6.283); ctx.fill(); ctx.strokeStyle = "rgba(47,127,193,.45)"; ctx.lineWidth = 0.8; ctx.stroke();
        }
      }
      raf = requestAnimationFrame(frame);
    };
    const play = () => { if (!raf && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } };
    const pause = () => { cancelAnimationFrame(raf); raf = 0; };
    const onVis = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", onVis);
    addEventListener("resize", resize);
    play();
    return { stop() { pause(); document.removeEventListener("visibilitychange", onVis); removeEventListener("resize", resize); cv.remove(); }, get running() { return !!raf; } };
  }

  window.jevletSeason = { season, get particlesRunning() { return !!engine?.running; }, filter: applyFilter };
}
