import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import worker from "../worker/worker.js";
import * as B from "../worker/billing.js";

class KV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
}

const SECRET = "whsec_test_123";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const sign = (body, t, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

let env, realFetch, stripeCalls;
beforeEach(() => {
  env = {
    KV: new KV(),
    STRIPE_SECRET_KEY: "sk_test_abc",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PRICE_PRO: "price_pro",
    STRIPE_PRICE_TEAM: "price_team",
  };
  stripeCalls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    stripeCalls.push({ url, init });
    return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = { waitUntil() {} };
async function req(path, { method = "POST", headers = {}, body } = {}) {
  const res = await worker.fetch(new Request("https://jevlet.example" + path, { method, headers, body }), env, ctx);
  return { status: res.status, body: await res.json() };
}
async function addKey(token, rec = { tier: "free", daily_cap: 100 }) {
  await env.KV.put("key:" + sha(token), JSON.stringify(rec));
  return sha(token);
}
function evt(id, type, object, created = now()) {
  return { id, type, created, data: { object } };
}
async function postEvent(e, t = now()) {
  const body = JSON.stringify(e);
  return req("/v1/billing/webhook", { headers: { "stripe-signature": sign(body, t) }, body });
}

// ---------- signature verification ----------

test("signature: valid, tampered, wrong secret, malformed, missing", async () => {
  const body = '{"id":"evt_1"}';
  const t = 1_700_000_000;
  assert.deepEqual(await B.verifyStripeSignature(body, sign(body, t), SECRET, t), { ok: true });
  assert.equal((await B.verifyStripeSignature(body + " ", sign(body, t), SECRET, t)).reason, "signature mismatch");
  assert.equal((await B.verifyStripeSignature(body, sign(body, t, "whsec_other"), SECRET, t)).ok, false);
  assert.equal((await B.verifyStripeSignature(body, "garbage", SECRET, t)).reason, "malformed header");
  assert.equal((await B.verifyStripeSignature(body, null, SECRET, t)).reason, "missing Stripe-Signature");
  assert.equal((await B.verifyStripeSignature(body, sign(body, t), "", t)).ok, false);
});

test("signature: timestamp tolerance (300s) both directions", async () => {
  const body = "{}";
  const t = 1_700_000_000;
  assert.equal((await B.verifyStripeSignature(body, sign(body, t), SECRET, t + 300)).ok, true);
  assert.equal((await B.verifyStripeSignature(body, sign(body, t), SECRET, t + 301)).reason, "timestamp outside tolerance");
  assert.equal((await B.verifyStripeSignature(body, sign(body, t), SECRET, t - 301)).ok, false);
});

test("signature: accepts when any of several v1 values matches (secret rotation)", async () => {
  const body = "{}";
  const t = 1_700_000_000;
  const good = sign(body, t).split(",")[1];
  assert.equal((await B.verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)},${good}`, SECRET, t)).ok, true);
});

test("signature: matches Stripe's documented scheme (HMAC-SHA256 of `${t}.${body}`)", async () => {
  assert.equal(await B.hmacHex("k", "1.x"), createHmac("sha256", "k").update("1.x").digest("hex"));
});

test("webhook endpoint rejects a bad signature with 400 and changes nothing", async () => {
  const id = await addKey("tok");
  const e = evt("evt_bad", "customer.subscription.deleted", { id: "sub_1", metadata: { key_id: id } });
  const r = await req("/v1/billing/webhook", { headers: { "stripe-signature": sign("{}", now()) }, body: JSON.stringify(e) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "INVALID_SIGNATURE");
});

// ---------- tier mapping ----------

test("tier mapping: prices, statuses, checkout metadata, deletions", () => {
  const sub = (status, price) => evt("e", "customer.subscription.updated", { status, items: { data: [{ price: { id: price } }] } });
  assert.equal(B.priceToPlan(env, "price_pro"), "pro");
  assert.equal(B.priceToPlan(env, "price_team"), "team");
  assert.equal(B.priceToPlan(env, "price_other"), null);
  assert.equal(B.tierForEvent(env, sub("active", "price_team")), "team");
  assert.equal(B.tierForEvent(env, sub("trialing", "price_pro")), "pro");
  assert.equal(B.tierForEvent(env, sub("past_due", "price_pro")), "pro");
  assert.equal(B.tierForEvent(env, sub("canceled", "price_pro")), "free");
  assert.equal(B.tierForEvent(env, sub("unpaid", "price_team")), "free");
  assert.equal(B.tierForEvent(env, sub("incomplete", "price_pro")), null);
  assert.equal(B.tierForEvent(env, sub("active", "price_unknown")), null);
  assert.equal(B.tierForEvent(env, evt("e", "customer.subscription.deleted", {})), "free");
  const cs = (o) => evt("e", "checkout.session.completed", { mode: "subscription", payment_status: "paid", ...o });
  assert.equal(B.tierForEvent(env, cs({ metadata: { plan: "team" } })), "team");
  assert.equal(B.tierForEvent(env, cs({ metadata: { plan: "enterprise" } })), null);
  assert.equal(B.tierForEvent(env, cs({ payment_status: "unpaid", metadata: { plan: "pro" } })), null);
  assert.equal(B.tierForEvent(env, evt("e", "invoice.paid", {})), null);
  assert.deepEqual(
    Object.fromEntries(Object.entries(B.TIERS).map(([k, v]) => [k, v.daily_cap])),
    { free: 100, pro: 5000, team: 50000 }
  );
});

test("key reference: only a sha256 key_id is accepted", () => {
  const id = sha("tok");
  assert.equal(B.keyIdForEvent(evt("e", "x", { client_reference_id: id })), id);
  assert.equal(B.keyIdForEvent(evt("e", "x", { metadata: { key_id: id } })), id);
  assert.equal(B.keyIdForEvent(evt("e", "x", { client_reference_id: "jvl_rawtoken" })), null);
});

test("webhook: checkout completes -> pro; plan change -> team; cancel -> free", async () => {
  const id = await addKey("tok", { tier: "free", daily_cap: 100, daily_label_cap: 7 });
  const t0 = now() - 100;
  let r = await postEvent(evt("evt_a", "checkout.session.completed", {
    mode: "subscription", payment_status: "paid", client_reference_id: id,
    customer: "cus_1", subscription: "sub_1", metadata: { key_id: id, plan: "pro" },
  }, t0));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "applied");
  let rec = await env.KV.get("key:" + id, "json");
  assert.equal(rec.tier, "pro");
  assert.equal(rec.daily_cap, 5000);
  assert.equal(rec.stripe_customer, "cus_1");
  assert.equal(rec.stripe_subscription, "sub_1");
  assert.equal(rec.daily_label_cap, 7, "other key fields are preserved");

  await postEvent(evt("evt_b", "customer.subscription.updated", {
    id: "sub_1", customer: "cus_1", status: "active", metadata: { key_id: id, plan: "pro" },
    items: { data: [{ price: { id: "price_team" } }] },
  }, t0 + 10));
  rec = await env.KV.get("key:" + id, "json");
  assert.equal(rec.tier, "team");
  assert.equal(rec.daily_cap, 50000);

  await postEvent(evt("evt_c", "customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { key_id: id } }, t0 + 20));
  rec = await env.KV.get("key:" + id, "json");
  assert.equal(rec.tier, "free");
  assert.equal(rec.daily_cap, 100);
});

test("webhook: unknown key or missing reference is acknowledged (200) and ignored", async () => {
  const r = await postEvent(evt("evt_x", "customer.subscription.deleted", { metadata: { key_id: sha("nobody") } }));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ignored");
});

// ---------- idempotency ----------

test("idempotency: a redelivered event is processed once", async () => {
  const id = await addKey("tok");
  const e = evt("evt_dup", "checkout.session.completed", {
    mode: "subscription", payment_status: "paid", client_reference_id: id, metadata: { plan: "pro" },
  });
  assert.equal((await postEvent(e)).body.status, "applied");
  // Simulate a manual change in between; the redelivery must not re-apply.
  await env.KV.put("key:" + id, JSON.stringify({ tier: "free", daily_cap: 100, billing_event_created: 0 }));
  const again = await postEvent(e);
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "duplicate");
  assert.equal((await env.KV.get("key:" + id, "json")).tier, "free");
});

test("idempotency: an out-of-order older event does not overwrite a newer one", async () => {
  const id = await addKey("tok");
  const t = now();
  await postEvent(evt("evt_new", "customer.subscription.deleted", { id: "sub_1", metadata: { key_id: id } }, t));
  const old = await postEvent(evt("evt_old", "customer.subscription.updated", {
    id: "sub_1", status: "active", metadata: { key_id: id }, items: { data: [{ price: { id: "price_pro" } }] },
  }, t - 60));
  assert.equal(old.body.status, "stale");
  assert.equal((await env.KV.get("key:" + id, "json")).tier, "free");
});

// ---------- checkout ----------

test("checkout: creates a subscription session linked by key_id, never the raw token", async () => {
  const id = await addKey("jvl_secret_token");
  const r = await req("/v1/billing/checkout", {
    headers: { authorization: "Bearer jvl_secret_token", "content-type": "application/json" },
    body: JSON.stringify({ plan: "team" }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(stripeCalls.length, 1);
  assert.equal(stripeCalls[0].url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(stripeCalls[0].init.headers.authorization, "Bearer sk_test_abc");
  const f = new URLSearchParams(stripeCalls[0].init.body);
  assert.equal(f.get("mode"), "subscription");
  assert.equal(f.get("line_items[0][price]"), "price_team");
  assert.equal(f.get("client_reference_id"), id);
  assert.equal(f.get("subscription_data[metadata][key_id]"), id);
  assert.equal(f.get("metadata[plan]"), "team");
  assert.match(f.get("success_url"), /^https:\/\/jevlet\.example\/\?billing=success/);
  assert.ok(!stripeCalls[0].init.body.includes("jvl_secret_token"));
});

test("checkout: auth, plan validation, config and test-mode guard", async () => {
  await addKey("tok");
  const h = { authorization: "Bearer tok", "content-type": "application/json" };
  assert.equal((await req("/v1/billing/checkout", { body: JSON.stringify({ plan: "pro" }) })).status, 401);
  assert.equal((await req("/v1/billing/checkout", { headers: h, body: JSON.stringify({ plan: "free" }) })).status, 400);
  env.STRIPE_SECRET_KEY = "sk_live_xyz";
  const live = await req("/v1/billing/checkout", { headers: h, body: JSON.stringify({ plan: "pro" }) });
  assert.equal(live.status, 503);
  assert.equal(stripeCalls.length, 0, "a live key must not reach Stripe without STRIPE_LIVE_MODE");
  env.STRIPE_LIVE_MODE = "true";
  assert.equal(B.stripeKeyAllowed(env), true);
  delete env.STRIPE_SECRET_KEY;
  assert.equal((await req("/v1/billing/checkout", { headers: h, body: JSON.stringify({ plan: "pro" }) })).status, 503);
});

// ---------- self-serve keys ----------

test("self-serve keys: off by default; when on, mints a free key and rate-limits per IP", async () => {
  assert.equal((await req("/v1/keys")).status, 404);
  env.SELF_SERVE_KEYS = "true";
  const h = { "cf-connecting-ip": "203.0.113.9" };
  const r = await req("/v1/keys", { headers: h });
  assert.equal(r.status, 201);
  assert.match(r.body.token, /^jvl_[A-Za-z0-9_-]{32}$/);
  const rec = await env.KV.get("key:" + sha(r.body.token), "json");
  assert.equal(rec.tier, "free");
  assert.equal(rec.daily_cap, 100);
  assert.ok(![...env.KV.m.values()].some((v) => v.includes(r.body.token)), "raw token is not stored");
  for (let i = 1; i < B.SELF_SERVE_PER_IP_PER_DAY; i++) assert.equal((await req("/v1/keys", { headers: h })).status, 201);
  assert.equal((await req("/v1/keys", { headers: h })).status, 429);
  assert.equal((await req("/v1/keys", { headers: { "cf-connecting-ip": "198.51.100.1" } })).status, 201);
});
