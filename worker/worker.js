// Jevlet: typed decision API. One Worker, static UI served from web/ via Workers Assets.

import csqa from "../adapters/csqa.json" with { type: "json" };
import policyCheck from "../adapters/policy_check.json" with { type: "json" };
import {
  CAL_MIN_N,
  err,
  validate,
  sha256Hex,
  stableStringify,
  permutation,
  buildPrompt,
  parseVote,
  decide,
  fitTemperature,
  applyTemperature,
  ece,
  truthIndex,
} from "./core.js";
import { judgeOnce } from "./providers.js";
import {
  getCalibration,
  putCalibration,
  reserve,
  settleUnitsStmt,
  normalizeLabels,
  storeLabels,
  DEFAULT_DAILY_LABEL_CAP,
} from "./store.js";
import {
  TIERS,
  PAID_PLANS,
  verifyStripeSignature,
  applyEvent,
  createCheckoutSession,
  stripeKeyAllowed,
  mintToken,
  SELF_SERVE_PER_IP_PER_DAY,
} from "./billing.js";

const ADAPTERS = Object.fromEntries([csqa, policyCheck].map((a) => [a.id, a]));
const MAX_VOTES = 9;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const today = () => new Date().toISOString().slice(0, 10);

// ---------- auth: KV key record "key:<sha256(token)>" -> { tier, daily_cap } ----------

async function auth(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  const id = await sha256Hex(h.slice(7).trim());
  const rec = await env.KV.get("key:" + id, "json");
  return rec ? { key_id: id, ...rec } : null;
}

// ---------- one vote: shuffle (choice), judge via chain, map back ----------

async function runVote(env, adapter, state, seed, i) {
  if (adapter.head === "choice") {
    const labels = state[adapter.labels_from];
    const perm = permutation(labels.length, `${seed}|${i}`);
    const shown = perm.map((j) => labels[j]);
    const r = await judgeOnce(env, buildPrompt(adapter, state, shown), (raw) =>
      parseVote(adapter, raw, labels.length)
    );
    if (!r.ok) return { ok: false, attempts: r.attempts, fallbacks: r.fallbacks };
    return { ok: true, value: perm[r.value], provider: r.provider, attempts: r.attempts, fallbacks: r.fallbacks };
  }
  const r = await judgeOnce(env, buildPrompt(adapter, state), (raw) => parseVote(adapter, raw));
  if (!r.ok) return { ok: false, attempts: r.attempts, fallbacks: r.fallbacks };
  return { ok: true, value: r.value, provider: r.provider, attempts: r.attempts, fallbacks: r.fallbacks };
}

// ---------- POST /v1/decide ----------

async function handleDecide(req, env, ctx) {
  const key = await auth(req, env);
  if (!key) return json(err("UNAUTHORIZED", "authorization", "missing or unknown key"), 401);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json(err("INVALID_SCHEMA", "$", "body must be a JSON object"), 400);

  const adapter = ADAPTERS[body.adapter];
  if (!adapter) return json(err("UNKNOWN_ADAPTER", "adapter", String(body.adapter)), 400);

  const bad = validate(body.state, adapter.input_schema, "state");
  if (bad) return json(err("INVALID_SCHEMA", bad.path, bad.detail), 400);

  const opts = body.options ?? {};
  if (opts.votes != null && !(Number.isInteger(opts.votes) && opts.votes >= 1 && opts.votes <= MAX_VOTES))
    return json(err("INVALID_SCHEMA", "options.votes", `integer 1..${MAX_VOTES}`), 400);
  if (opts.tau != null && !(typeof opts.tau === "number" && opts.tau > 0 && opts.tau < 1))
    return json(err("INVALID_SCHEMA", "options.tau", "number in (0,1)"), 400);

  const votes = opts.votes ?? adapter.votes;
  const hash = await sha256Hex(stableStringify([adapter.id, body.state, votes, opts.tau ?? null]));
  const useCache = opts.cache !== false;

  // Calibration belongs to the calling key only. No fit for this key -> uncalibrated.
  const cal = await getCalibration(env, adapter.id, key.key_id);
  const calT = cal && cal.n >= CAL_MIN_N && cal.temperature ? cal.temperature : null;
  // The cached response embeds the calibrated distribution, so the cache key includes the
  // calibration actually applied. Uncalibrated keys still share cache entries.
  const cacheKey = "cache:" + (await sha256Hex(stableStringify([hash, calT, cal?.tau ?? null])));

  // Cache hits are free and call no provider, so they are served before the budget check.
  if (useCache) {
    const hit = await env.KV.get(cacheKey, "json");
    if (hit)
      return json({
        ...hit,
        task_id: body.task_id ?? null,
        diagnostics: { ...hit.diagnostics, cache_hit: true, cost_units: 0 },
      });
  }

  // Budget: atomically reserve the worst case (one call per vote) before any provider is
  // called. The check and the increment are one D1 statement, so concurrent requests
  // cannot overspend the cap. The reservation is settled to actual cost afterwards.
  const day = today();
  const r = await reserve(env.DB, key.key_id, day, votes, key.daily_cap, "units");
  if (!r.ok) return json(err("BUDGET_EXCEEDED", "", `daily cap ${key.daily_cap} units, used ${r.used}`), 429);

  const t0 = Date.now();
  let results;
  try {
    results = await Promise.all(
      Array.from({ length: votes }, (_, i) => runVote(env, adapter, body.state, hash, i))
    );
  } catch (e) {
    await settleUnitsStmt(env.DB, key.key_id, day, -votes, false).run(); // release reservation
    throw e;
  }
  const ok = results.filter((r) => r.ok);
  const attempts = results.reduce((a, r) => a + r.attempts, 0);
  const fallbacks = results.flatMap((r) => r.fallbacks);
  if (!ok.length) {
    // Unchanged policy: an all-failed request is not billed. Release the reservation.
    await settleUnitsStmt(env.DB, key.key_id, day, -votes, false).run();
    return json(err("PROVIDERS_EXHAUSTED", "", `all ${votes} votes failed`), 503);
  }

  const labels = adapter.head === "choice" ? body.state[adapter.labels_from] : null;
  const d = decide(adapter, ok, cal, opts.tau ?? null, labels);
  const providers = [...new Set(ok.map((r) => r.provider))];

  const out = {
    decision_id: crypto.randomUUID(),
    task_id: body.task_id ?? null,
    adapter: adapter.id,
    decision: d.decision,
    diagnostics: {
      system: 1,
      abstained: d.decision.abstain,
      tau: d.tau,
      votes: ok.length,
      requested_votes: votes,
      provider: providers.length === 1 ? providers[0] : "mixed",
      providers,
      fallbacks_tried: fallbacks,
      calibrated: d.calibrated,
      temperature: d.temperature,
      cache_hit: false,
      cost_units: attempts,
      latency_ms: Date.now() - t0,
    },
  };

  ctx.waitUntil(record(env, key, adapter, out, hash, labels, day, votes));
  if (useCache) ctx.waitUntil(env.KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 86400 }));
  return json(out);
}

// Writes the decision and settles the unit reservation (reserved -> actual cost_units).
async function record(env, key, adapter, out, hash, labels, day, reserved) {
  const d = out.decision;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO decisions (id, ts, key_id, adapter, task_id, head, value, confidence, abstained,
         provider, votes, cost_units, latency_ms, input_hash, labels, distribution)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      out.decision_id,
      Date.now(),
      key.key_id,
      adapter.id,
      out.task_id,
      adapter.head,
      JSON.stringify(d.value ?? null),
      d.confidence ?? null,
      d.abstain ? 1 : 0,
      out.diagnostics.provider,
      out.diagnostics.votes,
      out.diagnostics.cost_units,
      out.diagnostics.latency_ms,
      hash,
      labels ? JSON.stringify(labels) : null,
      d.distribution ? JSON.stringify(d.distribution) : null
    ),
    settleUnitsStmt(env.DB, key.key_id, day, out.diagnostics.cost_units - reserved, true),
  ]);
}

// ---------- GET /v1/adapters ----------

async function handleAdapters(req, env) {
  if (!(await auth(req, env))) return json(err("UNAUTHORIZED", "authorization"), 401);
  return json({
    adapters: Object.values(ADAPTERS).map((a) => ({
      id: a.id,
      head: a.head,
      description: a.description,
      labels_from: a.labels_from ?? null,
      tau: a.tau,
      votes: a.votes,
      input_schema: a.input_schema,
    })),
  });
}

// ---------- GET /v1/usage ----------

async function handleUsage(req, env) {
  const key = await auth(req, env);
  if (!key) return json(err("UNAUTHORIZED", "authorization"), 401);
  const u = await env.DB.prepare("SELECT units, calls, labels FROM usage_daily WHERE key_id = ? AND day = ?")
    .bind(key.key_id, today())
    .first();
  const calibration = {};
  for (const a of Object.values(ADAPTERS)) calibration[a.id] = await getCalibration(env, a.id, key.key_id);
  return json({
    day: today(),
    units_today: u?.units ?? 0,
    calls_today: u?.calls ?? 0,
    daily_cap: key.daily_cap,
    labels_today: u?.labels ?? 0,
    daily_label_cap: key.daily_label_cap ?? DEFAULT_DAILY_LABEL_CAP,
    calibration,
  });
}

// ---------- POST /v1/calibrate  { adapter, labels: [{decision_id, truth}] } ----------
// Stores labels, then refits temperature and reports ECE over this key's labeled decisions.
// Limits: MAX_LABELS_PER_CALL per request, duplicates collapsed (last wins), labels only
// accepted for this key's own decisions, and a per-key daily label cap (each call counts
// at least 1, so refit-only calls are capped too).

async function handleCalibrate(req, env) {
  const key = await auth(req, env);
  if (!key) return json(err("UNAUTHORIZED", "authorization"), 401);
  const body = await req.json().catch(() => null);
  const adapter = ADAPTERS[body?.adapter];
  if (!adapter) return json(err("UNKNOWN_ADAPTER", "adapter"), 400);
  const norm = normalizeLabels(body.labels);
  if (!norm.ok) return json(err("INVALID_SCHEMA", norm.path, norm.detail), 400);
  const labels = norm.labels;

  const labelCap = key.daily_label_cap ?? DEFAULT_DAILY_LABEL_CAP;
  const r = await reserve(env.DB, key.key_id, today(), Math.max(1, labels.length), labelCap, "labels");
  if (!r.ok) return json(err("BUDGET_EXCEEDED", "labels", `daily label cap ${labelCap}, used ${r.used}`), 429);

  const stored = await storeLabels(env.DB, key.key_id, labels);

  const rows = await env.DB.prepare(
    `SELECT d.labels, d.distribution, l.truth
       FROM labels l JOIN decisions d ON d.id = l.decision_id
      WHERE d.adapter = ? AND d.key_id = ? AND d.distribution IS NOT NULL
      ORDER BY l.ts DESC LIMIT 5000`
  )
    .bind(adapter.id, key.key_id)
    .all();

  const samples = [];
  for (const r of rows.results ?? []) {
    const labs = r.labels ? JSON.parse(r.labels) : [];
    const p = JSON.parse(r.distribution);
    const t = truthIndex(adapter.head, labs, r.truth);
    if (t >= 0 && t < p.length) samples.push({ p, t });
  }

  const n = samples.length;
  const T = n >= 2 ? fitTemperature(samples) : 1;
  const eceRaw = ece(samples);
  const eceCal = ece(samples.map((s) => ({ p: applyTemperature(s.p, T), t: s.t })));
  const existing = await getCalibration(env, adapter.id, key.key_id);
  const cal = {
    tau: existing?.tau ?? adapter.tau,
    temperature: T,
    n,
    ece: eceCal,
    fitted_at: new Date().toISOString(),
  };
  await putCalibration(env, adapter.id, key.key_id, cal);
  return json({
    adapter: adapter.id,
    ...cal,
    ece_raw: eceRaw,
    calibrated: n >= CAL_MIN_N,
    labels_received: labels.length,
    labels_stored: stored,
    labels_skipped: labels.length - stored,
  });
}

// ---------- POST /v1/billing/checkout  { plan: "pro" | "team" } ----------
// Creates a Stripe Checkout Session (subscription) linked to the caller's key_id.

async function handleCheckout(req, env) {
  const key = await auth(req, env);
  if (!key) return json(err("UNAUTHORIZED", "authorization"), 401);
  if (!env.STRIPE_SECRET_KEY) return json(err("BILLING_NOT_CONFIGURED", "", "billing is not enabled"), 503);
  if (!stripeKeyAllowed(env))
    return json(err("BILLING_NOT_CONFIGURED", "", "live Stripe keys need STRIPE_LIVE_MODE=true"), 503);
  const body = await req.json().catch(() => null);
  const plan = body?.plan;
  if (!PAID_PLANS.includes(plan)) return json(err("INVALID_SCHEMA", "plan", `one of ${PAID_PLANS.join(", ")}`), 400);
  const r = await createCheckoutSession(env, { plan, keyId: key.key_id, origin: new URL(req.url).origin });
  if (!r.ok) return json(err(r.code, "", r.detail), r.code === "BILLING_NOT_CONFIGURED" ? 503 : 502);
  return json({ id: r.id, url: r.url });
}

// ---------- POST /v1/billing/webhook (Stripe -> us; signed, no bearer auth) ----------

async function handleWebhook(req, env) {
  const raw = await req.text();
  const v = await verifyStripeSignature(raw, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!v.ok) return json(err("INVALID_SIGNATURE", "stripe-signature", v.reason), 400);
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json(err("INVALID_SCHEMA", "$", "body is not JSON"), 400);
  }
  const r = await applyEvent(env, event);
  return json({ received: true, ...r });
}

// ---------- POST /v1/keys (opt-in self-serve free key) ----------
// Enabled only when SELF_SERVE_KEYS = "true". Best-effort limit per client IP per day.

async function handleSelfServeKey(req, env) {
  if (env.SELF_SERVE_KEYS !== "true") return json(err("NOT_FOUND", "/v1/keys"), 404);
  // Atomic per-IP daily limit (same conditional D1 UPDATE as the unit budget), so parallel
  // requests cannot mint more than SELF_SERVE_PER_IP_PER_DAY. Requests without an IP share one bucket.
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const r = await reserve(env.DB, "selfserve:" + (await sha256Hex(ip)), today(), 1, SELF_SERVE_PER_IP_PER_DAY, "units");
  if (!r.ok) return json(err("RATE_LIMITED", "", "too many keys today"), 429);
  const token = await mintToken();
  const rec = { tier: "free", daily_cap: TIERS.free.daily_cap, created: new Date().toISOString(), source: "self_serve" };
  await env.KV.put("key:" + (await sha256Hex(token)), JSON.stringify(rec));
  return json({ token, tier: rec.tier, daily_cap: rec.daily_cap, note: "Shown once. Only its hash is stored." }, 201);
}

// ---------- GET /v1/config (public, no secrets) ----------
// Lets the static UI know whether self-serve keys are on and where the Payment Links are.

function handleConfig(env) {
  return json({
    self_serve_keys: env.SELF_SERVE_KEYS === "true",
    payment_links: { pro: env.STRIPE_LINK_PRO || null, team: env.STRIPE_LINK_TEAM || null },
    tiers: Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, { daily_cap: v.daily_cap }])),
  });
}

// ---------- entry ----------

async function route(req, env, ctx, url) {
  const { pathname: p } = url;
  const m = req.method;
  if (p === "/v1/decide" && m === "POST") return handleDecide(req, env, ctx);
  if (p === "/v1/adapters" && m === "GET") return handleAdapters(req, env);
  if (p === "/v1/usage" && m === "GET") return handleUsage(req, env);
  if (p === "/v1/calibrate" && m === "POST") return handleCalibrate(req, env);
  if (p === "/v1/billing/checkout" && m === "POST") return handleCheckout(req, env);
  if (p === "/v1/billing/webhook" && m === "POST") return handleWebhook(req, env);
  if (p === "/v1/keys" && m === "POST") return handleSelfServeKey(req, env);
  if (p === "/v1/config" && m === "GET") return handleConfig(env);
  return json(err("NOT_FOUND", p), 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/v1/")) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, ctx, url);
    } catch (e) {
      console.error(e);
      return json(err("INTERNAL", "", "unexpected error"), 500);
    }
  },
};
