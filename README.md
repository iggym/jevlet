# Jevlet

A typed decision API. You send state plus a declared question; it returns a typed decision with a calibrated distribution, or an explicit `abstain`. It never returns free text.

The model behind it is swappable. The contract (typed in, typed out, calibrated, abstaining, metered) is the product. It runs as one Cloudflare Worker plus one static HTML file, on free-tier providers.

## What is built

- `POST /v1/decide`: choice and boolean heads (score head supported in the core logic, no adapter yet).
- Parallel votes with per-vote option shuffling and exact mapping back to original labels.
- Provider chain: Jev (optional) → Gemini → Groq → Workers AI. Per-call 4s timeout; falls through on error, timeout, or off-schema output.
- Strict server-side validation of every vote. Typed errors: `INVALID_SCHEMA`, `UNKNOWN_ADAPTER`, `BUDGET_EXCEEDED`, `PROVIDERS_EXHAUSTED`, `UNAUTHORIZED`.
- Add-1/K smoothed aggregation, so probabilities always sum to 1 and never hit exactly 0.
- Abstention when top probability falls below tau.
- Temperature calibration, applied only after 200 labeled decisions for that adapter. Below that, `calibrated: false`.
- KV response cache (24h). Cache hits report `cost_units: 0`.
- Per-key daily unit caps, recorded in D1.
- `GET /v1/adapters`, `GET /v1/usage`, `POST /v1/calibrate` (labels, refit, ECE).
- Single-file UI (`web/index.html`): Decide, Batch (CSV export), Calibrate, Usage.
- Adapters are JSON files in `adapters/`. Adding one does not touch the Worker.

## What is not built yet (from the spec)

- The `probability` head, and a `score` adapter.
- Real Jev API integration. `callJev` is a generic JSON-over-HTTP stub; check TypeSafe's current docs before enabling.
- Tau selection on a dev set (target accuracy 90%). Tau is currently set per adapter.
- Runaway guard (5x trailing-average throttle). Not implemented.
- GitHub Actions CI gate, position-bias test, and trap set. The eval runner exists; the CI workflow does not.
- Raw payload audit to R2.

## Setup

Requires Node.js 22 or newer (Wrangler 4 refuses to run on older versions; see `.nvmrc`).

```bash
npm install
npx wrangler kv namespace create KV          # paste the id into wrangler.toml
npx wrangler d1 create jevlet                # paste the id into wrangler.toml
npm run migrate                              # applies all migrations, including 0002
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GROQ_API_KEY
# optional: JEV_API_KEY and JEV_URL
npm run deploy
```

Create a key (the token prints once; KV stores only its hash):

```bash
node tools/mkkey.mjs 100      # 100 units per day (Free); e.g. `node tools/mkkey.mjs 5000 pro`
# run the printed `wrangler kv key put` command
```

Test the pure logic (no network, no Cloudflare):

```bash
npm test
```

Bundle the Worker and check bindings without deploying (also run in CI):

```bash
npm run check
```

Run the eval sample against a deployed instance:

```bash
JEVLET_URL=https://<your-worker>.workers.dev JEVLET_TOKEN=jvl_... npm run eval
```

## Example

```bash
curl -s https://<host>/v1/decide -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" -d '{
    "adapter":"csqa","task_id":"csqa_val_0012",
    "state":{"question":"A Google search can be conducted on what popular portable electronic device?",
             "choices":["lab","desktop computer","laptop","server","bookshelf"]},
    "options":{"votes":5}}'
```

## Billing (Stripe)

Tiers (placeholders to confirm before launch; defined in `worker/billing.js` `TIERS`):

| Tier | Price | Daily cap |
|------|-------|-----------|
| Free | $0 | 100 units |
| Pro | $19 / month | 5,000 units |
| Team | $99 / month | 50,000 units |

Endpoints:

- `POST /v1/billing/checkout` `{"plan":"pro"|"team"}` with the caller's Bearer key. Returns a Stripe Checkout `url` (subscription mode). The session carries `client_reference_id` and `metadata.key_id` = the key's SHA-256 id, never the raw token.
- `POST /v1/billing/webhook`, called by Stripe. Verifies `Stripe-Signature` (HMAC-SHA256, 300 s tolerance), then writes `{tier, daily_cap}` to `key:<key_id>` on `checkout.session.completed` and `customer.subscription.created/updated`, and drops to Free on `customer.subscription.deleted` (or status `canceled`/`unpaid`/`incomplete_expired`/`paused`). Each event id is processed once (KV `stripe_evt:<id>`, 30-day TTL), and older events never overwrite newer ones.
- `POST /v1/keys`: self-serve Free key, **off unless `SELF_SERVE_KEYS = "true"`**. Limited to 3 per client IP per day (best effort).

Setup (Stripe **test mode**):

1. Dashboard → Product catalog: create product "Jevlet Pro" with a recurring monthly price of $19, and "Jevlet Team" at $99. Copy both `price_...` ids.
2. Developers → Webhooks → Add endpoint: `https://<your-worker-host>/v1/billing/webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the signing secret (`whsec_...`).
3. Configure the Worker:

```bash
npx wrangler secret put STRIPE_SECRET_KEY        # sk_test_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_...
# in wrangler.toml [vars]: STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM, optional APP_URL (checkout return URL base), SELF_SERVE_KEYS
```

Live keys (`sk_live_...`) are refused unless `STRIPE_LIVE_MODE = "true"`. Local testing: `stripe listen --forward-to localhost:8787/v1/billing/webhook` and `stripe trigger checkout.session.completed` (the trigger fixture has no `key_id`, so it is acknowledged and ignored; a real Checkout from the Plans tab exercises the full path).

## Design decisions to know about

- **Budget vs. cache order.** Cache hits are served before the budget check, since they call no provider. The budget check reserves the worst case (one unit per vote) before any provider call. `cost_units` reports actual calls made.
- **Calibration is per calling key.** `/v1/calibrate` fits temperature only on the labels that key submitted and stores it under `cal:<adapter>:<key_id>`. `/v1/decide` reads only the caller's entry; a key with no fit of its own is served uncalibrated (adapter tau, no temperature), never another key's fit. Cache entries are keyed on the calibration applied.
- **Atomic budget.** `/v1/decide` reserves `votes` units with one conditional D1 `UPDATE ... WHERE units + ? <= cap RETURNING`, so concurrent requests cannot overspend. The reservation is settled to actual `cost_units` after the call and released if every provider fails.
- **`/v1/calibrate` limits.** At most 500 labels per call; duplicate `decision_id`s collapse (last wins, and re-labelling replaces the stored label); labels are accepted only for the caller's own decisions; and each key has a daily label cap (`daily_label_cap` on the key record, default 2000; a call with no labels counts as 1).
- **`decisions.distribution` and `decisions.labels` are extra columns** beyond the spec's data model. Calibration needs the full distribution, not just the top confidence, and the truth string needs the label order to map to an index.
- **Model names change.** `GEMINI_MODEL` is set to `gemini-3.5-flash-lite` in `wrangler.toml` `[vars]` (also the code default); `gemini-2.0-flash` and `gemini-2.5-flash(-lite)` now return 404. `GROQ_MODEL` and `WORKERS_AI_MODEL` default to names current when this was written. Verify them, and the free-tier limits, before launch. KV write limits are usually the first wall.

## Limitations (from the spec, unchanged)

- Vote-share confidence is only as good as the calibration set.
- Type-safe output can still be wrong. Abstention and human review are the safety net.
- Five votes across five providers can burn a free-tier daily quota quickly.
