// Jevlet: typed decision API. One Worker, static UI served from web/ via Workers Assets.

import csqa from "../adapters/csqa.json";
import policyCheck from "../adapters/policy_check.json";
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

  // Cache hits are free and call no provider, so they are served before the budget check.
  if (useCache) {
    const hit = await env.KV.get("cache:" + hash, "json");
    if (hit)
      return json({
        ...hit,
        task_id: body.task_id ?? null,
        diagnostics: { ...hit.diagnostics, cache_hit: true, cost_units: 0 },
      });
  }

  // Budget: reserve worst case (one call per vote) before any provider is called.
  const u = await env.DB.prepare("SELECT units FROM usage_daily WHERE key_id = ? AND day = ?")
    .bind(key.key_id, today())
    .first();
  const used = u?.units ?? 0;
  if (used + votes > key.daily_cap)
    return json(err("BUDGET_EXCEEDED", "", `daily cap ${key.daily_cap} units, used ${used}`), 429);

  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: votes }, (_, i) => runVote(env, adapter, body.state, hash, i))
  );
  const ok = results.filter((r) => r.ok);
  const attempts = results.reduce((a, r) => a + r.attempts, 0);
  const fallbacks = results.flatMap((r) => r.fallbacks);
  if (!ok.length) return json(err("PROVIDERS_EXHAUSTED", "", `all ${votes} votes failed`), 503);

  const cal = await env.KV.get("cal:" + adapter.id, "json");
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

  ctx.waitUntil(record(env, key, adapter, out, hash, labels));
  if (useCache) ctx.waitUntil(env.KV.put("cache:" + hash, JSON.stringify(out), { expirationTtl: 86400 }));
  return json(out);
}

async function record(env, key, adapter, out, hash, labels) {
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
    env.DB.prepare(
      `INSERT INTO usage_daily (key_id, day, units, calls) VALUES (?,?,?,1)
       ON CONFLICT(key_id, day) DO UPDATE SET units = units + excluded.units, calls = calls + 1`
    ).bind(key.key_id, today(), out.diagnostics.cost_units),
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
  const u = await env.DB.prepare("SELECT units, calls FROM usage_daily WHERE key_id = ? AND day = ?")
    .bind(key.key_id, today())
    .first();
  const calibration = {};
  for (const a of Object.values(ADAPTERS)) calibration[a.id] = (await env.KV.get("cal:" + a.id, "json")) ?? null;
  return json({
    day: today(),
    units_today: u?.units ?? 0,
    calls_today: u?.calls ?? 0,
    daily_cap: key.daily_cap,
    calibration,
  });
}

// ---------- POST /v1/calibrate  { adapter, labels: [{decision_id, truth}] } ----------
// Stores labels, then refits temperature and reports ECE over this key's labeled decisions.

async function handleCalibrate(req, env) {
  const key = await auth(req, env);
  if (!key) return json(err("UNAUTHORIZED", "authorization"), 401);
  const body = await req.json().catch(() => null);
  const adapter = ADAPTERS[body?.adapter];
  if (!adapter) return json(err("UNKNOWN_ADAPTER", "adapter"), 400);
  const labels = Array.isArray(body.labels) ? body.labels : [];
  if (labels.length > 1000) return json(err("INVALID_SCHEMA", "labels", "max 1000 per call"), 400);
  for (const [i, l] of labels.entries())
    if (!l || typeof l.decision_id !== "string" || l.truth == null)
      return json(err("INVALID_SCHEMA", `labels[${i}]`, "needs decision_id and truth"), 400);

  if (labels.length) {
    await env.DB.batch(
      labels.map((l) =>
        env.DB.prepare("INSERT INTO labels (decision_id, truth, ts) VALUES (?,?,?)").bind(
          l.decision_id,
          String(l.truth),
          Date.now()
        )
      )
    );
  }

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
  const existing = await env.KV.get("cal:" + adapter.id, "json");
  const cal = {
    tau: existing?.tau ?? adapter.tau,
    temperature: T,
    n,
    ece: eceCal,
    fitted_at: new Date().toISOString(),
  };
  await env.KV.put("cal:" + adapter.id, JSON.stringify(cal));
  return json({ adapter: adapter.id, ...cal, ece_raw: eceRaw, calibrated: n >= CAL_MIN_N });
}

// ---------- entry ----------

async function route(req, env, ctx, url) {
  const { pathname: p } = url;
  const m = req.method;
  if (p === "/v1/decide" && m === "POST") return handleDecide(req, env, ctx);
  if (p === "/v1/adapters" && m === "GET") return handleAdapters(req, env);
  if (p === "/v1/usage" && m === "GET") return handleUsage(req, env);
  if (p === "/v1/calibrate" && m === "POST") return handleCalibrate(req, env);
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
