import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../worker/worker.js";
import * as S from "../worker/store.js";
import { FakeD1, FakeKV, makeCtx } from "./helpers/fakes.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const STATE = { question: "Where do people keep books?", choices: ["lab", "bookshelf", "server"] };

let env, realFetch;

// Stub Gemini: always votes for the option whose label is "bookshelf".
beforeEach(() => {
  env = { KV: new FakeKV(), DB: new FakeD1(), GEMINI_API_KEY: "test", ASSETS: { fetch: () => new Response("ui") } };
  realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = body.contents[0].parts[0].text;
    const m = user.match(/(\d+)\. bookshelf/);
    const text = JSON.stringify({ choice: Number(m[1]) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function addKey(token, rec) {
  await env.KV.put("key:" + sha(token), JSON.stringify({ tier: "free", ...rec }));
  return sha(token);
}

async function call(token, path, method = "GET", body) {
  const ctx = makeCtx();
  const res = await worker.fetch(
    new Request("https://x" + path, {
      method,
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx
  );
  await ctx.flush();
  return { status: res.status, body: await res.json() };
}

const decideBody = (extra = {}) => ({ adapter: "csqa", state: STATE, options: { votes: 3, ...extra } });

// ---------- (a) calibration scope ----------

test("calibration: calKey is per adapter and per key", () => {
  assert.equal(S.calKey("csqa", "abc"), "cal:csqa:abc");
  assert.notEqual(S.calKey("csqa", "a"), S.calKey("csqa", "b"));
});

test("calibration: another key's fit is never applied; own fit is", async () => {
  const a = await addKey("tok_a", { daily_cap: 100 });
  await addKey("tok_b", { daily_cap: 100 });
  // Key A has a mature fit; a legacy global entry also exists and must be ignored.
  await env.KV.put(S.calKey("csqa", a), JSON.stringify({ tau: 0.3, temperature: 3, n: 500 }));
  await env.KV.put("cal:csqa", JSON.stringify({ tau: 0.3, temperature: 3, n: 500 }));

  const ra = await call("tok_a", "/v1/decide", "POST", decideBody({ cache: false }));
  const rb = await call("tok_b", "/v1/decide", "POST", decideBody({ cache: false }));
  assert.equal(ra.status, 200);
  assert.equal(ra.body.diagnostics.calibrated, true);
  assert.equal(ra.body.diagnostics.temperature, 3);
  assert.equal(rb.status, 200);
  assert.equal(rb.body.diagnostics.calibrated, false);
  assert.equal(rb.body.diagnostics.temperature, null);
  assert.equal(rb.body.diagnostics.tau, 0.6); // adapter default, not A's tau
});

test("calibration: cache entries are not shared across different calibrations", async () => {
  const a = await addKey("tok_a", { daily_cap: 100 });
  await addKey("tok_b", { daily_cap: 100 });
  await env.KV.put(S.calKey("csqa", a), JSON.stringify({ tau: 0.3, temperature: 3, n: 500 }));
  const ra = await call("tok_a", "/v1/decide", "POST", decideBody());
  const rb = await call("tok_b", "/v1/decide", "POST", decideBody());
  assert.equal(ra.body.diagnostics.cache_hit, false);
  assert.equal(rb.body.diagnostics.cache_hit, false, "B must not get A's calibrated cached answer");
  assert.equal(rb.body.diagnostics.calibrated, false);
  const rb2 = await call("tok_b", "/v1/decide", "POST", decideBody());
  assert.equal(rb2.body.diagnostics.cache_hit, true);
});

test("calibration: /v1/calibrate writes only the caller's entry", async () => {
  const a = await addKey("tok_a", { daily_cap: 100 });
  const b = await addKey("tok_b", { daily_cap: 100 });
  const d = await call("tok_a", "/v1/decide", "POST", decideBody({ cache: false }));
  const c = await call("tok_a", "/v1/calibrate", "POST", {
    adapter: "csqa",
    labels: [{ decision_id: d.body.decision_id, truth: "bookshelf" }],
  });
  assert.equal(c.status, 200);
  assert.ok(await env.KV.get(S.calKey("csqa", a), "json"));
  assert.equal(await env.KV.get(S.calKey("csqa", b), "json"), null);
  assert.equal(await env.KV.get("cal:csqa", "json"), null);
});

// ---------- (b) atomic budget ----------

test("budget: reserve never exceeds the cap under concurrent reservations", async () => {
  const db = new FakeD1();
  const rs = await Promise.all(Array.from({ length: 20 }, () => S.reserve(db, "k", "2026-10-11", 3, 10)));
  assert.equal(rs.filter((r) => r.ok).length, 3); // 3 * 3 = 9 <= 10; a 4th would be 12
  const row = await db.prepare("SELECT units FROM usage_daily WHERE key_id='k'").first();
  assert.equal(row.units, 9);
  assert.equal(rs.find((r) => !r.ok).used, 9);
});

test("budget: concurrent /v1/decide calls cannot overspend daily_cap", async () => {
  await addKey("tok", { daily_cap: 10 });
  const rs = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      call("tok", "/v1/decide", "POST", { adapter: "csqa", task_id: String(i), state: STATE, options: { votes: 3, cache: false } })
    )
  );
  assert.equal(rs.filter((r) => r.status === 200).length, 3);
  assert.equal(rs.filter((r) => r.status === 429).length, 5);
  const u = await call("tok", "/v1/usage");
  assert.ok(u.body.units_today <= 10);
  assert.equal(u.body.units_today, 9);
  assert.equal(u.body.calls_today, 3);
});

test("budget: reservation is settled to actual cost and refunded when providers fail", async () => {
  await addKey("tok", { daily_cap: 100 });
  globalThis.fetch = async () => new Response("down", { status: 500 });
  const r = await call("tok", "/v1/decide", "POST", decideBody({ cache: false }));
  assert.equal(r.status, 503);
  const u = await call("tok", "/v1/usage");
  assert.equal(u.body.units_today, 0);
  assert.equal(u.body.calls_today, 0);
});

// ---------- (c) /v1/calibrate limits ----------

test("calibrate: normalizeLabels dedupes (last wins) and enforces limits", () => {
  const n = S.normalizeLabels([
    { decision_id: "d1", truth: "a" },
    { decision_id: "d2", truth: "b" },
    { decision_id: "d1", truth: "c" },
  ]);
  assert.deepEqual(n.labels, [
    { decision_id: "d2", truth: "b" },
    { decision_id: "d1", truth: "c" },
  ]);
  const big = Array.from({ length: S.MAX_LABELS_PER_CALL + 1 }, (_, i) => ({ decision_id: "d" + i, truth: "x" }));
  assert.equal(S.normalizeLabels(big).ok, false);
  assert.equal(S.normalizeLabels([{ decision_id: "d" }]).path, "labels[0]");
  assert.equal(S.normalizeLabels("nope").ok, false);
  assert.deepEqual(S.normalizeLabels(undefined), { ok: true, labels: [] });
});

test("calibrate: re-labelling replaces, and other keys' decisions are skipped", async () => {
  await addKey("tok_a", { daily_cap: 100 });
  await addKey("tok_b", { daily_cap: 100 });
  const d = await call("tok_a", "/v1/decide", "POST", decideBody({ cache: false }));
  const id = d.body.decision_id;
  await call("tok_a", "/v1/calibrate", "POST", { adapter: "csqa", labels: [{ decision_id: id, truth: "lab" }] });
  const c2 = await call("tok_a", "/v1/calibrate", "POST", { adapter: "csqa", labels: [{ decision_id: id, truth: "bookshelf" }] });
  const rows = await env.DB.prepare("SELECT truth FROM labels WHERE decision_id = ?").bind(id).all();
  assert.deepEqual(rows.results.map((r) => r.truth), ["bookshelf"]);
  assert.equal(c2.body.n, 1);
  const cb = await call("tok_b", "/v1/calibrate", "POST", { adapter: "csqa", labels: [{ decision_id: id, truth: "lab" }] });
  assert.equal(cb.body.labels_stored, 0);
  assert.equal(cb.body.labels_skipped, 1);
  const again = await env.DB.prepare("SELECT truth FROM labels WHERE decision_id = ?").bind(id).first();
  assert.equal(again.truth, "bookshelf");
});

test("calibrate: per-key daily label cap (refit-only calls count as 1)", async () => {
  await addKey("tok", { daily_cap: 100, daily_label_cap: 3 });
  const labels = [1, 2].map((i) => ({ decision_id: "x" + i, truth: "a" }));
  assert.equal((await call("tok", "/v1/calibrate", "POST", { adapter: "csqa", labels })).status, 200);
  assert.equal((await call("tok", "/v1/calibrate", "POST", { adapter: "csqa" })).status, 200);
  const over = await call("tok", "/v1/calibrate", "POST", { adapter: "csqa" });
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, "BUDGET_EXCEEDED");
  const u = await call("tok", "/v1/usage");
  assert.equal(u.body.labels_today, 3);
  assert.equal(u.body.daily_label_cap, 3);
});

test("calibrate: rejects more than MAX_LABELS_PER_CALL", async () => {
  await addKey("tok", { daily_cap: 100 });
  const labels = Array.from({ length: S.MAX_LABELS_PER_CALL + 1 }, (_, i) => ({ decision_id: "d" + i, truth: "a" }));
  const r = await call("tok", "/v1/calibrate", "POST", { adapter: "csqa", labels });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "INVALID_SCHEMA");
});
