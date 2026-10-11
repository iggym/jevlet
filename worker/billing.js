// Stripe billing: Checkout (subscription mode), signed webhooks, tier -> daily cap,
// and opt-in self-serve free keys. Uses Stripe's REST API via fetch (no SDK) and
// WebCrypto, so it runs unchanged on Workers and in Node tests.
//
// Keys are only ever referenced by key_id = sha256(token), the same id KV already uses
// ("key:<key_id>"). The raw token never goes to Stripe.

// Confirmed by Iggy 2026-10-11: Free $0 / 100 per day, Pro $19/mo / 5,000, Team $99/mo / 50,000.
// Prices live in Stripe (STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM); keep these caps and web/index.html in sync.
export const TIERS = {
  free: { daily_cap: 100 },
  pro: { daily_cap: 5000 },
  team: { daily_cap: 50000 },
};
export const PAID_PLANS = ["pro", "team"];

export const SIG_TOLERANCE_S = 300;
const EVENT_TTL_S = 60 * 60 * 24 * 30; // keep processed event ids 30 days (Stripe retries for 3)
const STRIPE_API = "https://api.stripe.com/v1";

// ---------- tier mapping ----------

export function priceToPlan(env, priceId) {
  if (priceId && priceId === env.STRIPE_PRICE_PRO) return "pro";
  if (priceId && priceId === env.STRIPE_PRICE_TEAM) return "team";
  return null;
}

// Subscription statuses that keep the paid tier. past_due keeps it while Stripe retries
// the payment; canceled / unpaid / incomplete_expired drop to free; incomplete waits.
const KEEP = new Set(["active", "trialing", "past_due"]);
const DROP = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);

// Returns the tier a Stripe event implies, or null if the event should not change it.
export function tierForEvent(env, event) {
  const o = event?.data?.object ?? {};
  switch (event?.type) {
    case "checkout.session.completed": {
      if (o.mode !== "subscription") return null;
      if (o.payment_status && o.payment_status !== "paid" && o.payment_status !== "no_payment_required") return null;
      const plan = o.metadata?.plan;
      return PAID_PLANS.includes(plan) ? plan : null;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      if (DROP.has(o.status)) return "free";
      if (!KEEP.has(o.status)) return null;
      const plan = priceToPlan(env, o.items?.data?.[0]?.price?.id) ?? o.metadata?.plan;
      return PAID_PLANS.includes(plan) ? plan : null;
    }
    case "customer.subscription.deleted":
      return "free";
    default:
      return null;
  }
}

export function keyIdForEvent(event) {
  const o = event?.data?.object ?? {};
  const id = o.client_reference_id || o.metadata?.key_id || null;
  return typeof id === "string" && /^[0-9a-f]{64}$/.test(id) ? id : null;
}

// ---------- webhook signature (Stripe-Signature: t=...,v1=...[,v1=...]) ----------

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Returns { ok: true } or { ok: false, reason }.
export async function verifyStripeSignature(rawBody, header, secret, nowS = Math.floor(Date.now() / 1000), tolerance = SIG_TOLERANCE_S) {
  if (!secret) return { ok: false, reason: "no secret configured" };
  if (!header) return { ok: false, reason: "missing Stripe-Signature" };
  let t = null;
  const v1 = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!t || !/^\d+$/.test(t) || !v1.length) return { ok: false, reason: "malformed header" };
  if (Math.abs(nowS - Number(t)) > tolerance) return { ok: false, reason: "timestamp outside tolerance" };
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return v1.some((s) => safeEqual(s, expected)) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

// ---------- applying an event ----------

// Idempotent and order-safe: an event id is processed at most once, and an event older
// than the last one applied to the key (Stripe `created`) does not overwrite it.
export async function applyEvent(env, event) {
  if (!event?.id) return { status: "ignored", reason: "no id" };
  const seenKey = "stripe_evt:" + event.id;
  if (await env.KV.get(seenKey)) return { status: "duplicate" };

  const tier = tierForEvent(env, event);
  const keyId = keyIdForEvent(event);
  let result;
  if (!tier) result = { status: "ignored", reason: "no tier change" };
  else if (!keyId) result = { status: "ignored", reason: "no key reference" };
  else {
    const rec = await env.KV.get("key:" + keyId, "json");
    if (!rec) result = { status: "ignored", reason: "unknown key" };
    else if ((rec.billing_event_created ?? 0) > (event.created ?? 0)) result = { status: "stale" };
    else {
      const o = event.data.object;
      const next = {
        ...rec,
        tier,
        daily_cap: TIERS[tier].daily_cap,
        billing_event_created: event.created ?? 0,
        stripe_customer: o.customer ?? rec.stripe_customer ?? null,
        stripe_subscription:
          (event.type.startsWith("customer.subscription.") ? o.id : o.subscription) ?? rec.stripe_subscription ?? null,
      };
      await env.KV.put("key:" + keyId, JSON.stringify(next));
      result = { status: "applied", tier, key_id: keyId };
    }
  }
  await env.KV.put(seenKey, "1", { expirationTtl: EVENT_TTL_S });
  return result;
}

// ---------- Checkout ----------

export function checkoutForm({ priceId, keyId, plan, successUrl, cancelUrl }) {
  const f = new URLSearchParams();
  f.set("mode", "subscription");
  f.set("line_items[0][price]", priceId);
  f.set("line_items[0][quantity]", "1");
  f.set("client_reference_id", keyId);
  f.set("metadata[key_id]", keyId);
  f.set("metadata[plan]", plan);
  f.set("subscription_data[metadata][key_id]", keyId);
  f.set("subscription_data[metadata][plan]", plan);
  f.set("success_url", successUrl);
  f.set("cancel_url", cancelUrl);
  return f;
}

// Test mode only unless explicitly enabled: refuses live keys without STRIPE_LIVE_MODE="true".
export function stripeKeyAllowed(env) {
  const k = env.STRIPE_SECRET_KEY || "";
  if (k.startsWith("sk_test_") || k.startsWith("rk_test_")) return true;
  return env.STRIPE_LIVE_MODE === "true" && (k.startsWith("sk_live_") || k.startsWith("rk_live_"));
}

export async function createCheckoutSession(env, { plan, keyId, origin }) {
  const priceId = plan === "pro" ? env.STRIPE_PRICE_PRO : plan === "team" ? env.STRIPE_PRICE_TEAM : null;
  if (!priceId) return { ok: false, code: "BILLING_NOT_CONFIGURED", detail: `no price configured for ${plan}` };
  const base = (env.APP_URL || origin).replace(/\/$/, "");
  const r = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: checkoutForm({
      priceId,
      keyId,
      plan,
      successUrl: `${base}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/?billing=cancel`,
    }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) return { ok: false, code: "BILLING_ERROR", detail: j.error?.message ?? `stripe ${r.status}` };
  return { ok: true, id: j.id, url: j.url };
}

// ---------- self-serve free keys ----------

export const SELF_SERVE_PER_IP_PER_DAY = 3;

export async function mintToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "jvl_" + b64;
}
