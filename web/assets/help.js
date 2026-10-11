// Jevlet guided help: info modals, first-visit tour, interactive explainers.
// Plain ES module, no dependencies. Every number below mirrors the Worker code
// (test/help.test.mjs checks FACTS against it so the docs cannot drift).

export const FACTS = {
  adapters: {
    csqa: { head: "choice", tau: 0.6, votes: 5, input: "question (1–1000 chars) and choices (2–10 options, each up to 300 chars)" },
    policy_check: { head: "boolean", tau: 0.7, votes: 5, input: "policy and case (each 1–4000 chars)" },
  },
  maxVotes: 9,
  calMinN: 200,
  cacheHours: 24,
  timeoutS: 4,
  maxLabelsPerCall: 500,
  dailyLabelCap: 2000,
  batchConcurrency: 4,
  tiers: {
    free: { name: "Free", price: 0, cap: 100 },
    pro: { name: "Pro", price: 19, cap: 5000 },
    team: { name: "Team", price: 99, cap: 50000 },
  },
  errors: [
    ["UNAUTHORIZED", 401, "Missing, malformed, or unknown API key (Authorization: Bearer jvl_…)."],
    ["INVALID_SCHEMA", 400, "The body, state, options, or labels failed validation. path says where, detail says why."],
    ["UNKNOWN_ADAPTER", 400, "The adapter id is not one of the installed adapters."],
    ["BUDGET_EXCEEDED", 429, "The key's daily unit cap (decide) or daily label cap (calibrate) would be exceeded."],
    ["PROVIDERS_EXHAUSTED", 503, "Every vote failed on every configured model provider. Not billed; retry later."],
    ["NOT_FOUND", 404, "Unknown /v1 route (also self-serve /v1/keys when the operator has not enabled it)."],
    ["RATE_LIMITED", 429, "Self-serve key minting is limited per client IP per day."],
    ["BILLING_NOT_CONFIGURED", 503, "Checkout is not set up on this instance (or no price for that plan)."],
    ["BILLING_ERROR", 502, "Stripe rejected the checkout request."],
    ["INVALID_SIGNATURE", 400, "Webhook only: the Stripe-Signature header did not verify."],
    ["INTERNAL", 500, "Unexpected server error."],
  ],
};

export const TOPIC_IDS = ["overview", "decision", "adapters", "calibration", "usage", "keys", "plans", "errors", "batch", "eval", "quickstart"];

// Same smoothing as worker/core.js (aggregateChoice / aggregateBoolean).
export function aggregateChoice(votes, K) {
  const c = new Array(K).fill(0);
  for (const v of votes) c[v]++;
  return c.map((x) => (x + 1 / K) / (votes.length + 1));
}
export function aggregateBoolean(values) {
  const pt = (values.filter(Boolean).length + 0.5) / (values.length + 1);
  return [1 - pt, pt];
}
// decide(): would the next request fit in today's budget? (worst case: one unit per vote)
export const fitsBudget = (used, votes, cap) => used + votes <= cap;

if (typeof document !== "undefined") init();

function init() {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const origin = location.origin;
  const T = FACTS.tiers;
  const pct = (x) => (x * 100).toFixed(1) + "%";
  const code = (txt, label) =>
    `<div class="code"><pre tabindex="0" aria-label="${esc(label || "Code example")}">${esc(txt)}</pre><button type="button" class="copy" aria-label="Copy ${esc(label || "code")}">Copy</button></div>`;
  const KEY = "$JEVLET_TOKEN";

  const TOPICS = {
    overview: {
      title: "What is Jevlet?",
      html: () => `
        <p>Jevlet is a <b>typed decision API</b>. You send a <i>state</i> (structured input) and pick an <i>adapter</i> (a declared question). It returns a <b>typed decision</b>: a choice from your options or a true/false value, plus a probability distribution. If it is not confident enough, it explicitly <b>abstains</b>. It never returns free text.</p>
        <p>Under the hood several model votes are collected and aggregated. The contract is the product: typed in, typed out, calibrated, abstaining, metered.</p>
        <h3>Explore</h3>
        <div class="hm-topics">${topicLinks(TOPIC_IDS.filter((t) => t !== "overview"))}</div>
        <p class="muted">New here? <button type="button" class="ghost" data-tour-start>Take the 1-minute tour</button></p>`,
    },
    decision: {
      title: "How a decision works",
      html: () => `
        <ol>
          <li><b>Validate.</b> Your <code>state</code> is checked against the adapter's schema. Errors come back typed (<code>INVALID_SCHEMA</code>) with a path.</li>
          <li><b>Vote.</b> Jevlet runs several independent votes in parallel (adapter default ${FACTS.adapters.csqa.votes}, you can ask for 1–${FACTS.maxVotes}). For choice questions the options are shuffled for each vote and mapped back, to cancel out position bias. Each vote must return strict JSON of the right type or it is discarded.</li>
          <li><b>Aggregate.</b> Votes become a smoothed probability distribution that always sums to 1 and never hits exactly 0 (add-1/K smoothing for choices).</li>
          <li><b>Calibrate (optional).</b> Once your key has ${FACTS.calMinN}+ labeled decisions for that adapter, a fitted temperature adjusts the distribution.</li>
          <li><b>Decide or abstain.</b> If the top probability is below <b>tau</b> (the adapter's threshold, or your <code>options.tau</code>), the answer is <code>abstain: true</code>, so you can route it to a human or a slower path.</li>
        </ol>
        <h3>Try it: votes → distribution → decision</h3>
        <p class="muted">An illustrative simulation of the aggregation math the Worker uses. No API call, no units used.</p>
        <div class="sim" id="sim">
          <div class="sim-row">
            <label>Votes <select id="sim-n" aria-label="Number of votes">${[1, 3, 5, 7, 9].map((n) => `<option ${n === 5 ? "selected" : ""}>${n}</option>`).join("")}</select></label>
            <label>Agreement <input id="sim-agree" type="range" min="0" max="100" value="70" aria-label="How often votes agree on the favourite option"></label>
            <label>tau <input id="sim-tau" type="range" min="5" max="95" value="60" aria-label="Abstain threshold tau"><output id="sim-tau-v">0.60</output></label>
            <button type="button" class="ghost" id="sim-run">Run votes</button>
          </div>
          <div class="sim-stage">1 · Votes</div>
          <div class="sim-votes" id="sim-votes" aria-live="polite"></div>
          <div class="sim-stage">2 · Distribution <span class="arrow" aria-hidden="true">→</span> 3 · Decision</div>
          <div id="sim-bars"></div>
          <div class="sim-out" id="sim-out" aria-live="polite"></div>
        </div>
        <h3>The response</h3>
        ${code(`{
  "decision_id": "…",
  "decision": { "type": "choice", "value": 2, "label": "laptop",
                "confidence": 0.8, "distribution": [0.05, 0.05, 0.8, 0.05, 0.05],
                "abstain": false },
  "diagnostics": { "tau": 0.6, "votes": 3, "provider": "gemini",
                   "calibrated": false, "cache_hit": false, "cost_units": 3, … }
}`, "Example decide response")}
        <p class="muted">Keep the <code>decision_id</code>: it is how you label the decision later for calibration.</p>`,
      after: setupSim,
    },
    adapters: {
      title: "Adapters",
      html: () => `
        <p>An adapter is a declared question with an input schema, an output type (its <i>head</i>), a default tau, and a default vote count. Adding one is a JSON file; the Worker does not change.</p>
        <table>
          <tr><th>Adapter</th><th>Head</th><th>Input</th><th>tau</th><th>Votes</th></tr>
          ${Object.entries(FACTS.adapters).map(([id, a]) => `<tr><td><code>${id}</code></td><td>${a.head}</td><td>${esc(a.input)}</td><td>${a.tau}</td><td>${a.votes}</td></tr>`).join("")}
        </table>
        <p><b>csqa</b> picks the single most sensible answer from your list (CommonsenseQA style). <b>policy_check</b> answers whether a case complies with a policy, judging only from the text provided.</p>
        <p class="muted"><code>GET /v1/adapters</code> lists the live adapters and their schemas. The Decide tab builds its form from that list.</p>`,
    },
    calibration: {
      title: "Calibration",
      html: () => `
        <p>Raw vote shares can be over- or under-confident. Calibration fixes that with <b>your own ground truth</b>.</p>
        <ol>
          <li>Run decisions and keep their <code>decision_id</code>.</li>
          <li>Later, send labels: <code>{"decision_id": "…", "truth": "laptop"}</code>. For choice adapters the truth is the option text (or its index). For booleans use <code>"true"</code> or <code>"false"</code>.</li>
          <li>Jevlet fits a temperature and reports ECE (expected calibration error) before and after.</li>
        </ol>
        <div class="callout">Calibration is <b>per API key</b>: only your labels shape your results, and nobody else's labels change yours. The temperature is applied only after <b>${FACTS.calMinN}</b> labeled decisions for that adapter. Until then responses say <code>calibrated: false</code>.</div>
        <h3>Limits</h3>
        <ul>
          <li>Up to ${FACTS.maxLabelsPerCall} labels per call. Duplicate <code>decision_id</code>s collapse (the last one wins), and re-labelling replaces the old label.</li>
          <li>Labels are accepted only for decisions made with your key; others are skipped (<code>labels_skipped</code>).</li>
          <li>Daily label cap per key (default ${FACTS.dailyLabelCap}). A refit-only call with no labels counts as 1.</li>
        </ul>`,
    },
    usage: {
      title: "Usage, units & daily caps",
      html: () => `
        <p>A <b>unit</b> is one model-provider call. A 5-vote decision normally costs 5 units. If a provider fails and the vote falls back to the next provider, that extra attempt is counted too.</p>
        <ul>
          <li><b>Cache hits are free.</b> Identical requests (same adapter, state, votes, tau, and calibration) within ${FACTS.cacheHours} hours return the cached answer with <code>cost_units: 0</code>. Send <code>"options": {"cache": false}</code> to force fresh votes.</li>
          <li><b>Budget check.</b> Before calling any model, Jevlet reserves the worst case (one unit per vote) against your daily cap, atomically, so parallel requests cannot overspend. The reservation is then settled to the actual cost.</li>
          <li><b>Failed requests are not billed.</b> If every vote fails (<code>PROVIDERS_EXHAUSTED</code>), the reservation is released.</li>
          <li>Days are UTC dates. <code>GET /v1/usage</code> (and the Usage tab) shows units and requests today, your cap, and your label usage.</li>
        </ul>
        <h3>Try it: the daily cap meter</h3>
        <div class="sim">
          <div class="sim-row">
            <label>Plan <select id="m-plan" aria-label="Plan">${Object.entries(T).map(([k, t]) => `<option value="${k}">${t.name} (${t.cap.toLocaleString()}/day)</option>`).join("")}</select></label>
            <label>Votes per request <input id="m-votes" type="range" min="1" max="${FACTS.maxVotes}" value="5" aria-label="Votes per request"><output id="m-votes-v">5</output></label>
          </div>
          <div class="sim-row"><label style="flex:1">Units used today <input id="m-used" type="range" min="0" max="100" value="60" style="width:100%" aria-label="Units used today"></label></div>
          <div class="meter" id="m-meter" role="img" aria-label="Usage meter"><i></i><b></b></div>
          <div class="muted" id="m-label"></div>
          <p class="meter-msg" id="m-msg" aria-live="polite"></p>
        </div>`,
      after: setupMeter,
    },
    keys: {
      title: "API keys & authentication",
      html: () => `
        <p>Every <code>/v1</code> call (except the Stripe webhook) needs <code>Authorization: Bearer jvl_…</code>.</p>
        <ul>
          <li>The token is shown <b>once</b> when it is minted. Jevlet stores only its SHA-256 hash, so a lost token cannot be recovered; get a new one instead.</li>
          <li>Each key carries its plan and daily cap. Usage, calibration, and billing are all tracked per key.</li>
          <li>In this UI the key is kept in your browser's local storage on this device only. Clear it from the field to forget it.</li>
          <li>The operator mints keys with <code>node tools/mkkey.mjs &lt;daily_cap&gt; [tier]</code>. A self-serve "Get a free key" button exists, but works only if the operator has enabled it.</li>
        </ul>`,
    },
    plans: {
      title: "Plans & billing",
      html: () => `
        <table>
          <tr><th>Plan</th><th>Price</th><th>Daily cap</th></tr>
          ${Object.values(T).map((t) => `<tr><td>${t.name}</td><td>${t.price ? "$" + t.price + " / month" : "$0"}</td><td>${t.cap.toLocaleString()} units</td></tr>`).join("")}
        </table>
        <ul>
          <li><b>Upgrade</b> from the Plans tab. It applies to the API key entered at the top, and you pay on Stripe Checkout (a monthly subscription). Your raw key is never sent to Stripe; only its hash links the payment to the key.</li>
          <li>After payment, the upgrade <b>takes effect within a minute</b>. Check the Usage tab for the new cap.</li>
          <li>Changing plan updates the cap. If the subscription is cancelled (or ends unpaid), the key drops back to <b>Free</b>.</li>
        </ul>`,
    },
    errors: {
      title: "Errors",
      html: () => `
        <p>Errors are typed, never prose. Every error has the same shape:</p>
        ${code(`{ "error": { "code": "INVALID_SCHEMA", "path": "state.choices", "detail": "minItems 2" } }`, "Error shape")}
        <table>
          <tr><th>Code</th><th>HTTP</th><th>Meaning</th></tr>
          ${FACTS.errors.map(([c, s, m]) => `<tr><td><code>${c}</code></td><td>${s}</td><td>${esc(m)}</td></tr>`).join("")}
        </table>
        <p class="muted">An abstention is <b>not</b> an error: it is a normal 200 response with <code>abstain: true</code>.</p>`,
    },
    batch: {
      title: "Batch",
      html: () => `
        <p>Paste one JSON request per line (each needs <code>adapter</code> and <code>state</code>; <code>task_id</code> and <code>options</code> are optional). The UI sends them to <code>/v1/decide</code>, ${FACTS.batchConcurrency} at a time, shows the first 50 rows, and lets you export every row as CSV.</p>
        ${code(`{"adapter":"csqa","task_id":"t1","state":{"question":"Where would you keep a book you plan to read later?","choices":["oven","bookshelf","refrigerator","sink"]}}`, "Batch line example")}
        <p class="muted">Each line is a normal decision: it uses units, respects your daily cap, and can be served from cache.</p>`,
    },
    eval: {
      title: "Eval runner (CLI)",
      html: () => `
        <p>The repo ships a small eval runner. It sends every line of a JSONL file to <code>/v1/decide</code> on a deployed instance (with <code>cache: false</code>) and prints a summary.</p>
        ${code(`JEVLET_URL=${origin} JEVLET_TOKEN=jvl_… npm run eval`, "Eval command")}
        <p>Each line is <code>{"adapter": "csqa", "state": {…}, "truth": "laptop"}</code> (for booleans, <code>"truth": true</code>). The sample set is <code>eval/sets/sample.jsonl</code>.</p>
        <p>Output fields: <code>items</code>, <code>errors</code>, <code>accuracy_on_kept</code>, <code>accuracy_overall_abstain_as_wrong</code>, <code>abstention_rate</code>, <code>cost_units_per_decision</code>, <code>latency_ms_p50</code>, <code>latency_ms_p95</code>.</p>
        <p class="muted">It makes real decisions, so it uses units from the key's daily cap.</p>`,
    },
    quickstart: {
      title: "API quickstart",
      html: () => `
        <p>Set your key once, then copy any example. Base URL: <code>${esc(origin)}</code></p>
        ${code(`export JEVLET_TOKEN=jvl_your_key_here`, "Set token")}
        <h3>Make a decision</h3>
        ${code(`curl -s ${origin}/v1/decide \\
  -H "authorization: Bearer ${KEY}" -H "content-type: application/json" \\
  -d '{"adapter":"csqa","task_id":"demo-1",
       "state":{"question":"A Google search can be conducted on what popular portable electronic device?",
                "choices":["lab","desktop computer","laptop","server","bookshelf"]},
       "options":{"votes":5}}'`, "Decide example")}
        <h3>Boolean policy check</h3>
        ${code(`curl -s ${origin}/v1/decide \\
  -H "authorization: Bearer ${KEY}" -H "content-type: application/json" \\
  -d '{"adapter":"policy_check",
       "state":{"policy":"Refunds are allowed within 30 days of purchase.",
                "case":"Customer bought the item 10 days ago and asks for a refund."}}'`, "Policy check example")}
        <h3>List adapters · check usage</h3>
        ${code(`curl -s ${origin}/v1/adapters -H "authorization: Bearer ${KEY}"
curl -s ${origin}/v1/usage    -H "authorization: Bearer ${KEY}"`, "Adapters and usage")}
        <h3>Label decisions (calibration)</h3>
        ${code(`curl -s ${origin}/v1/calibrate \\
  -H "authorization: Bearer ${KEY}" -H "content-type: application/json" \\
  -d '{"adapter":"csqa","labels":[{"decision_id":"<id from decide>","truth":"laptop"}]}'`, "Calibrate example")}
        <h3>Start an upgrade</h3>
        ${code(`curl -s ${origin}/v1/billing/checkout \\
  -H "authorization: Bearer ${KEY}" -H "content-type: application/json" \\
  -d '{"plan":"pro"}'    # returns {"url": "https://checkout.stripe.com/…"}`, "Checkout example")}
        <p class="muted">Options for decide: <code>votes</code> (1–${FACTS.maxVotes}), <code>tau</code> (0–1, exclusive), <code>cache</code> (default true).</p>`,
    },
  };

  function topicLinks(ids) {
    return ids.map((id) => `<button type="button" data-help="${id}">${esc(TOPICS[id].title)}</button>`).join("");
  }

  // ---------- modal (native <dialog> + explicit focus trap) ----------
  const dlg = document.createElement("dialog");
  dlg.className = "hm";
  dlg.setAttribute("aria-labelledby", "hm-title");
  dlg.innerHTML = `<div class="hm-head"><h2 id="hm-title"></h2><button type="button" class="hm-close" aria-label="Close help">×</button></div><div class="hm-body" id="hm-body"></div>`;
  document.body.appendChild(dlg);
  let opener = null;
  let cleanup = null;

  function openHelp(id, from) {
    const t = TOPICS[id] || TOPICS.overview;
    if (cleanup) { cleanup(); cleanup = null; }
    $("#hm-title", dlg).textContent = t.title;
    $("#hm-body", dlg).innerHTML = t.html();
    $("#hm-body", dlg).scrollTop = 0;
    if (!dlg.open) { opener = from || document.activeElement; dlg.showModal(); }
    cleanup = t.after ? t.after(dlg) : null;
    $(".hm-close", dlg).focus();
  }
  function closeHelp() { if (dlg.open) dlg.close(); }
  dlg.addEventListener("close", () => {
    if (cleanup) { cleanup(); cleanup = null; }
    if (opener && opener.focus) opener.focus();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeHelp(); // backdrop click
    if (e.target.closest(".hm-close")) closeHelp();
    const c = e.target.closest(".copy");
    if (c) copyFrom(c);
    const h = e.target.closest("[data-help]");
    if (h) openHelp(h.dataset.help);
    if (e.target.closest("[data-tour-start]")) { closeHelp(); startTour(); }
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const f = [...dlg.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  async function copyFrom(btn) {
    const txt = btn.previousElementSibling.textContent;
    try { await navigator.clipboard.writeText(txt); }
    catch {
      const ta = Object.assign(document.createElement("textarea"), { value: txt });
      ta.style.position = "fixed"; ta.style.opacity = "0";
      dlg.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1400);
  }

  // ---------- votes -> distribution -> decision simulation ----------
  function setupSim(root) {
    const labels = ["lab", "desktop computer", "laptop", "server", "bookshelf"];
    const fav = 2;
    const timers = [];
    const tauEl = $("#sim-tau", root), tauV = $("#sim-tau-v", root);
    let votes = [];
    const clear = () => { while (timers.length) clearTimeout(timers.pop()); };
    const renderBars = (p, tau) => {
      $("#sim-bars", root).innerHTML = labels.map((l, i) => `<div class="row"><span>${esc(l)}</span><div class="bar"><i style="width:${(p[i] * 100).toFixed(2)}%"></i><b class="tau" style="left:${tau * 100}%"></b></div><span>${pct(p[i])}</span></div>`).join("");
    };
    const decide = () => {
      const tau = tauEl.value / 100;
      tauV.textContent = tau.toFixed(2);
      if (!votes.length) { renderBars(new Array(labels.length).fill(1 / labels.length), tau); $("#sim-out", root).textContent = ""; return; }
      const p = aggregateChoice(votes, labels.length);
      let best = 0; p.forEach((x, i) => { if (x > p[best]) best = i; });
      renderBars(p, tau);
      const out = $("#sim-out", root);
      const abstain = p[best] < tau;
      out.className = "sim-out" + (abstain ? " abstain" : "");
      out.textContent = abstain
        ? `Abstain: top ${pct(p[best])} is below tau ${tau.toFixed(2)}`
        : `Decision: "${labels[best]}" with ${pct(p[best])} confidence`;
    };
    const run = () => {
      clear();
      const n = Number($("#sim-n", root).value);
      const agree = $("#sim-agree", root).value / 100;
      votes = Array.from({ length: n }, () => (Math.random() < agree ? fav : Math.floor(Math.random() * labels.length)));
      const box = $("#sim-votes", root);
      box.innerHTML = votes.map((v) => `<span class="chip" title="${esc(labels[v])}">${esc(labels[v].split(" ")[0])}</span>`).join("");
      const chips = [...box.children];
      const shown = votes.slice();
      votes = [];
      decide();
      if (reduced()) { chips.forEach((c) => c.classList.add("in")); votes = shown; decide(); return; }
      chips.forEach((c, i) => timers.push(setTimeout(() => { c.classList.add("in"); votes = shown.slice(0, i + 1); decide(); }, 220 * (i + 1))));
    };
    $("#sim-run", root).addEventListener("click", run);
    tauEl.addEventListener("input", decide);
    run();
    return clear;
  }

  // ---------- usage-cap meter ----------
  function setupMeter(root) {
    const plan = $("#m-plan", root), used = $("#m-used", root), vEl = $("#m-votes", root);
    const update = () => {
      const cap = T[plan.value].cap;
      used.max = cap;
      if (Number(used.value) > cap) used.value = cap;
      const u = Number(used.value), v = Number(vEl.value);
      $("#m-votes-v", root).textContent = v;
      const ok = fitsBudget(u, v, cap);
      const m = $("#m-meter", root);
      m.classList.toggle("over", !ok);
      m.querySelector("i").style.width = Math.min(100, (u / cap) * 100) + "%";
      const b = m.querySelector("b");
      b.style.left = Math.min(100, (u / cap) * 100) + "%";
      b.style.width = Math.max(0, Math.min(100 - (u / cap) * 100, (v / cap) * 100)) + "%";
      m.setAttribute("aria-label", `${u} of ${cap} units used`);
      $("#m-label", root).textContent = `${u.toLocaleString()} / ${cap.toLocaleString()} units used · next request reserves ${v}`;
      const msg = $("#m-msg", root);
      msg.className = "meter-msg " + (ok ? "ok" : "bad");
      msg.textContent = ok
        ? `✓ Allowed: ${u} + ${v} ≤ ${cap}`
        : `✕ 429 BUDGET_EXCEEDED: ${u} + ${v} > ${cap}. Cache hits still work; the cap resets at the next UTC day.`;
    };
    plan.addEventListener("change", () => { used.value = Math.round(T[plan.value].cap * 0.6); update(); });
    used.addEventListener("input", update);
    vEl.addEventListener("input", update);
    update();
    return null;
  }

  // ---------- '?' buttons next to features ----------
  const addBtn = (target, topic, label, where = "append") => {
    if (!target) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "help-btn";
    b.dataset.help = topic;
    b.setAttribute("aria-label", `Help: ${label}`);
    b.title = `Help: ${label}`;
    b.textContent = "?";
    target[where](b);
  };
  addBtn($('label[for="token"]'), "keys", "API keys");
  addBtn($('section[data-tab="decide"] h2'), "decision", "How a decision works");
  addBtn($('label[for="d-adapter"]'), "adapters", "Adapters");
  addBtn($('label[for="d-tau"]'), "decision", "tau and abstain");
  addBtn($('section[data-tab="batch"] h2'), "batch", "Batch");
  addBtn($('section[data-tab="calibrate"] h2'), "calibration", "Calibration");
  addBtn($('section[data-tab="usage"] h2'), "usage", "Usage and daily caps");
  addBtn($('section[data-tab="plans"] h2'), "plans", "Plans and billing");

  // Header actions
  const h1 = $("main > h1");
  if (h1) {
    const bar = document.createElement("div");
    bar.className = "topbar";
    h1.replaceWith(bar);
    bar.appendChild(h1);
    const acts = document.createElement("div");
    acts.className = "actions";
    acts.innerHTML = `<button type="button" class="ghost" data-help="overview">Guide</button><button type="button" class="ghost" data-help="quickstart">API</button><button type="button" class="ghost" data-help="errors">Errors</button><button type="button" class="ghost" data-tour-start>Tour</button>`;
    bar.appendChild(acts);
  }

  document.addEventListener("click", (e) => {
    if (dlg.contains(e.target)) return;
    const h = e.target.closest("[data-help]");
    if (h) { e.preventDefault(); openHelp(h.dataset.help, h); }
    if (e.target.closest("[data-tour-start]")) startTour();
  });

  // Public hook (used by other UI sections to open a topic)
  window.jevletHelp = { open: openHelp, tour: () => startTour() };

  // ---------- first-visit guided tour ----------
  const TOUR_KEY = "jevlet_tour_v1";
  const STEPS = [
    { sel: "main > .topbar", title: "Welcome to Jevlet", text: "A typed decision API: structured input in, a typed choice or true/false out, with a probability distribution or an explicit abstain. This tour takes a minute; the Guide button reopens everything." },
    { sel: "#token", title: "Your API key", text: "Paste your jvl_… key here. It stays in this browser only. Every request is metered against this key's daily cap." },
    { sel: "nav[role=tablist]", title: "Five tools", text: "Decide runs one decision, Batch runs many, Calibrate teaches Jevlet your ground truth, Usage shows today's units, and Plans handles upgrades." },
    { sel: 'section[data-tab="decide"] h2 .help-btn', title: "Help is one click away", text: "Look for the ? buttons. They open short explainers, including an interactive vote → distribution → decision demo." },
    { sel: 'label[for="d-tau"]', title: "tau = when to abstain", text: "If the top probability is below tau, Jevlet abstains instead of guessing. Leave it blank to use the adapter's default." },
    { sel: ".topbar .actions", title: "Guide, API, Errors", text: "Copyable curl examples, every error code, and the full guide live here. You can replay this tour at any time." },
  ];
  let tourEls = null, step = 0, tourOpener = null;

  function startTour() {
    if (tourEls) return;
    tourOpener = document.activeElement;
    // Make sure the Decide tab is visible so targets exist.
    const decideTab = $('nav button[data-tab="decide"]');
    if (decideTab && decideTab.getAttribute("aria-selected") !== "true") decideTab.click();
    const spot = document.createElement("div");
    spot.className = "tour-spot";
    spot.setAttribute("aria-hidden", "true");
    const pop = document.createElement("div");
    pop.className = "tour-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-modal", "true");
    pop.setAttribute("aria-labelledby", "tour-title");
    pop.setAttribute("aria-describedby", "tour-text");
    document.body.append(spot, pop);
    tourEls = { spot, pop };
    pop.addEventListener("keydown", tourKeys);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    step = 0;
    renderStep();
  }
  function endTour() {
    if (!tourEls) return;
    tourEls.spot.remove(); tourEls.pop.remove(); tourEls = null;
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place);
    try { localStorage.setItem(TOUR_KEY, "done"); } catch {}
    if (tourOpener && tourOpener.focus && tourOpener !== document.body) tourOpener.focus();
  }
  function renderStep() {
    const s = STEPS[step];
    const { pop } = tourEls;
    pop.innerHTML = `<h3 id="tour-title">${esc(s.title)}</h3><p id="tour-text">${esc(s.text)}</p>
      <div class="tour-nav"><button type="button" data-t="skip">Skip tour</button><span>${step + 1} / ${STEPS.length}</span>
      <span>${step ? '<button type="button" data-t="back">Back</button> ' : ""}<button type="button" class="go" data-t="next">${step === STEPS.length - 1 ? "Done" : "Next"}</button></span></div>`;
    pop.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => {
      const t = b.dataset.t;
      if (t === "skip") return endTour();
      if (t === "back") step = Math.max(0, step - 1);
      if (t === "next") { if (step === STEPS.length - 1) return endTour(); step++; }
      renderStep();
    }));
    const el = $(s.sel);
    if (el) el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
    place();
    setTimeout(place, reduced() ? 0 : 350);
    pop.querySelector(".go").focus();
  }
  function place() {
    if (!tourEls) return;
    const { spot, pop } = tourEls;
    const el = $(STEPS[step].sel);
    const r = el ? el.getBoundingClientRect() : { top: innerHeight / 2, left: innerWidth / 2, width: 0, height: 0, bottom: innerHeight / 2 };
    const pad = 6;
    Object.assign(spot.style, { top: r.top - pad + "px", left: r.left - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
    const ph = pop.offsetHeight, pw = pop.offsetWidth;
    let top = r.bottom + 12;
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 12);
    const left = Math.min(Math.max(8, r.left), innerWidth - pw - 8);
    Object.assign(pop.style, { top: top + "px", left: left + "px" });
  }
  function tourKeys(e) {
    if (e.key === "Escape") { e.preventDefault(); endTour(); return; }
    if (e.key === "ArrowRight") tourEls.pop.querySelector(".go").click();
    if (e.key === "ArrowLeft") tourEls.pop.querySelector('[data-t="back"]')?.click();
    if (e.key === "Tab") {
      const f = [...tourEls.pop.querySelectorAll("button")];
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  let seen = null;
  try { seen = localStorage.getItem(TOUR_KEY); } catch {}
  const returning = !!window.jevletBillingReturn || new URLSearchParams(location.search).has("billing");
  if (!seen && !returning) setTimeout(startTour, 600);
}
