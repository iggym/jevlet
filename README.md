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

## Get your API key

1. **Create a key.** On the site, use **Create free key** in the "Get your API key" section (or `curl -s -X POST https://jevlet.iggy-mw.workers.dev/v1/keys`). Free keys get 100 units/day, and each network (client IP) can create 3 keys per day, enforced atomically in D1. The operator can also mint keys with `node tools/mkkey.mjs <daily_cap> [tier]`.
2. **Save it immediately.** The `jvl_…` token is shown once; only its SHA-256 hash is stored. Keep it in a password manager or a secret env var (`export JEVLET_TOKEN=jvl_…`). Never commit it or ship it in public client code. The web UI stores it in localStorage only if you tick "Remember in this browser".
3. **Send it on every request** as `Authorization: Bearer $JEVLET_TOKEN`. Every `/v1` endpoint needs it except `POST /v1/keys`, `GET /v1/config`, and the Stripe webhook.
4. **Check usage** with `GET /v1/usage` (or the Usage tab): units used today (UTC) against your daily cap.
5. **Upgrade** in the Plans tab: **Pay with Stripe** (Payment Link) or **Upgrade** (Checkout). Pro is $19/mo for 5,000 units/day; Team is $99/mo for 50,000. The payment is linked to the key's hash and takes effect within a minute.
6. **Lost it?** It can't be recovered or re-shown. Create a new key. A paid plan stays on the old key, and there's no self-serve transfer, so contact the operator to move it.

## Worked examples

Real requests and responses captured from the live API (keys redacted; trimmed values are marked). The same examples appear in the app's help modals and showcase cards.

<!-- examples:start (generated by tools/readme-examples.mjs; do not edit by hand) -->
### Decide: multiple choice (csqa)

`POST /v1/decide` → HTTP 200

```bash
curl -s -X POST https://jevlet.iggy-mw.workers.dev/v1/decide \
  -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" \
  -d '{"adapter":"csqa","task_id":"demo-1","state":{"question":"A Google search can be conducted on what popular portable electronic device?","choices":["lab","desktop computer","laptop","server","bookshelf"]},"options":{"votes":3}}'
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/decide", {
  method: "POST",
  headers: { authorization: "Bearer " + JEVLET_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({
    "adapter": "csqa",
    "task_id": "demo-1",
    "state": {
      "question": "A Google search can be conducted on what popular portable electronic device?",
      "choices": [
        "lab",
        "desktop computer",
        "laptop",
        "server",
        "bookshelf"
      ]
    },
    "options": {
      "votes": 3
    }
  })
});
const data = await res.json(); // HTTP 200
```

</details>

Response (live, unedited):

```json
{
  "decision_id": "7281e4bd-1eb3-4eb7-a633-95183ce772be",
  "task_id": "demo-1",
  "adapter": "csqa",
  "decision": {
    "type": "choice",
    "value": 2,
    "label": "laptop",
    "confidence": 0.8,
    "distribution": [
      0.05,
      0.05,
      0.8,
      0.05,
      0.05
    ],
    "abstain": false
  },
  "diagnostics": {
    "system": 1,
    "abstained": false,
    "tau": 0.6,
    "votes": 3,
    "requested_votes": 3,
    "provider": "gemini",
    "providers": [
      "gemini"
    ],
    "fallbacks_tried": [],
    "calibrated": false,
    "temperature": null,
    "cache_hit": false,
    "cost_units": 3,
    "latency_ms": 720
  }
}
```

**How to read it:** decision.label is the answer; confidence (0.8) is its probability and is above tau (0.6), so abstain is false. distribution lines up with your choices in order, and cost_units is the number of model calls made.

### Decide: policy check (boolean)

`POST /v1/decide` → HTTP 200

```bash
curl -s -X POST https://jevlet.iggy-mw.workers.dev/v1/decide \
  -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" \
  -d '{"adapter":"policy_check","task_id":"demo-2","state":{"policy":"Refunds are allowed within 30 days of purchase.","case":"Customer bought the item 10 days ago and asks for a refund."},"options":{"votes":3}}'
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/decide", {
  method: "POST",
  headers: { authorization: "Bearer " + JEVLET_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({
    "adapter": "policy_check",
    "task_id": "demo-2",
    "state": {
      "policy": "Refunds are allowed within 30 days of purchase.",
      "case": "Customer bought the item 10 days ago and asks for a refund."
    },
    "options": {
      "votes": 3
    }
  })
});
const data = await res.json(); // HTTP 200
```

</details>

Response (live, unedited):

```json
{
  "decision_id": "50911b45-80ff-44c7-ba7a-b6b68707bcc3",
  "task_id": "demo-2",
  "adapter": "policy_check",
  "decision": {
    "type": "boolean",
    "value": true,
    "confidence": 0.875,
    "distribution": [
      0.125,
      0.875
    ],
    "abstain": false
  },
  "diagnostics": {
    "system": 1,
    "abstained": false,
    "tau": 0.7,
    "votes": 3,
    "requested_votes": 3,
    "provider": "gemini",
    "providers": [
      "gemini"
    ],
    "fallbacks_tried": [],
    "calibrated": false,
    "temperature": null,
    "cache_hit": false,
    "cost_units": 3,
    "latency_ms": 687
  }
}
```

**How to read it:** For booleans, distribution is [P(false), P(true)]. value true means the case complies; confidence 0.875 is above tau 0.7, so Jevlet did not abstain.

### List adapters

`GET /v1/adapters` → HTTP 200

```bash
curl -s https://jevlet.iggy-mw.workers.dev/v1/adapters \
  -H "authorization: Bearer $JEVLET_TOKEN"
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/adapters", {
  method: "GET",
  headers: { authorization: "Bearer " + JEVLET_TOKEN }
});
const data = await res.json(); // HTTP 200
```

</details>

Response (live, policy_check's input_schema is shortened):

```json
{
  "adapters": [
    {
      "id": "csqa",
      "head": "choice",
      "description": "Multiple choice (CommonsenseQA style): pick the single best option from the given list.",
      "labels_from": "choices",
      "tau": 0.6,
      "votes": 5,
      "input_schema": {
        "type": "object",
        "required": [
          "question",
          "choices"
        ],
        "properties": {
          "question": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000
          },
          "choices": {
            "type": "array",
            "minItems": 2,
            "maxItems": 10,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 300
            }
          }
        }
      }
    },
    {
      "id": "policy_check",
      "head": "boolean",
      "description": "Boolean: does the case comply with the policy? Judges only from the text provided.",
      "labels_from": null,
      "tau": 0.7,
      "votes": 5,
      "input_schema": "…same shape as above (policy, case: strings 1–4000 chars)…"
    }
  ]
}
```

**How to read it:** Each adapter has a head (choice or boolean), its default tau and votes, and the input_schema your state must match. labels_from names the field that holds the options.

### Batch: several decisions at once

`POST /v1/decide` → HTTP 200

```bash
# one request per line; the Batch tab runs them 4 at a time
curl -s https://jevlet.iggy-mw.workers.dev/v1/decide \
  -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" \
  -d '{"adapter":"csqa","task_id":"demo-1","state":{"question":"A Google search can be conducted on what popular portable electronic device?","choices":["lab","desktop computer","laptop","server","bookshelf"]},"options":{"votes":3}}'

curl -s https://jevlet.iggy-mw.workers.dev/v1/decide \
  -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" \
  -d '{"adapter":"policy_check","task_id":"demo-2","state":{"policy":"Refunds are allowed within 30 days of purchase.","case":"Customer bought the item 10 days ago and asks for a refund."},"options":{"votes":3}}'
```

<details><summary>JavaScript fetch</summary>

```js
const lines = [
  {
    "adapter": "csqa",
    "task_id": "demo-1",
    "state": {
      "question": "A Google search can be conducted on what popular portable electronic device?",
      "choices": [
        "lab",
        "desktop computer",
        "laptop",
        "server",
        "bookshelf"
      ]
    },
    "options": {
      "votes": 3
    }
  },
  {
    "adapter": "policy_check",
    "task_id": "demo-2",
    "state": {
      "policy": "Refunds are allowed within 30 days of purchase.",
      "case": "Customer bought the item 10 days ago and asks for a refund."
    },
    "options": {
      "votes": 3
    }
  }
];
const results = await Promise.all(lines.map((body) =>
  fetch("https://jevlet.iggy-mw.workers.dev/v1/decide", {
    method: "POST",
    headers: { authorization: "Bearer " + JEVLET_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json())
));
```

</details>

Response (live, CSV built from the two live responses above):

```csv
task_id,status,result,confidence,provider,cost_units,error
"demo-1","200","laptop","0.8","gemini","3",""
"demo-2","200","true","0.875","gemini","3",""
```

**How to read it:** The Batch tab sends one /v1/decide call per line, 4 at a time. result is the label (or true/false, or ABSTAIN), and the CSV export has exactly these columns.

### Calibrate: label a decision

`POST /v1/calibrate` → HTTP 200

```bash
curl -s -X POST https://jevlet.iggy-mw.workers.dev/v1/calibrate \
  -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" \
  -d '{"adapter":"csqa","labels":[{"decision_id":"7281e4bd-1eb3-4eb7-a633-95183ce772be","truth":"laptop"}]}'
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/calibrate", {
  method: "POST",
  headers: { authorization: "Bearer " + JEVLET_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({
    "adapter": "csqa",
    "labels": [
      {
        "decision_id": "7281e4bd-1eb3-4eb7-a633-95183ce772be",
        "truth": "laptop"
      }
    ]
  })
});
const data = await res.json(); // HTTP 200
```

</details>

Response (live, unedited):

```json
{
  "adapter": "csqa",
  "tau": 0.6,
  "temperature": 1,
  "n": 1,
  "ece": 0.19999999999999996,
  "fitted_at": "2026-10-11T23:53:53.166Z",
  "ece_raw": 0.19999999999999996,
  "calibrated": false,
  "labels_received": 1,
  "labels_stored": 1,
  "labels_skipped": 0
}
```

**How to read it:** n is how many of your decisions are labeled for this adapter. calibrated stays false until n reaches 200; until then the temperature is not applied. labels_stored and labels_skipped show what was accepted.

### Check usage

`GET /v1/usage` → HTTP 200

```bash
curl -s https://jevlet.iggy-mw.workers.dev/v1/usage \
  -H "authorization: Bearer $JEVLET_TOKEN"
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/usage", {
  method: "GET",
  headers: { authorization: "Bearer " + JEVLET_TOKEN }
});
const data = await res.json(); // HTTP 200
```

</details>

Response (live, unedited):

```json
{
  "day": "2026-10-11",
  "units_today": 91,
  "calls_today": 16,
  "daily_cap": 100,
  "labels_today": 1,
  "daily_label_cap": 2000,
  "calibration": {
    "csqa": {
      "tau": 0.6,
      "temperature": 1,
      "n": 1,
      "ece": 0.19999999999999996,
      "fitted_at": "2026-10-11T23:53:53.166Z"
    },
    "policy_check": null
  }
}
```

**How to read it:** units_today out of daily_cap is your budget for today (UTC). A decide call needs room for one unit per vote, or it gets 429 BUDGET_EXCEEDED. calibration shows your per-key fit for each adapter.

### Upgrade: start a Stripe Checkout

`POST /v1/billing/checkout` → HTTP 200

```bash
curl -s -X POST https://jevlet.iggy-mw.workers.dev/v1/billing/checkout \
  -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" \
  -d '{"plan":"pro"}'
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/billing/checkout", {
  method: "POST",
  headers: { authorization: "Bearer " + JEVLET_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({
    "plan": "pro"
  })
});
const data = await res.json(); // HTTP 200
```

</details>

Response (live, id and url shortened):

```json
{
  "id": "cs_test_a1idcix0oBLTzKDV…",
  "url": "https://checkout.stripe.com/c/pay/cs_test_a1idci…"
}
```

**How to read it:** Open url in a browser to pay. The session is linked to your key's SHA-256 id (never the key itself). After payment your daily_cap changes within a minute.

### Create a free API key

`POST /v1/keys` → HTTP 201

```bash
curl -s -X POST https://jevlet.iggy-mw.workers.dev/v1/keys
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/keys", {
  method: "POST"
});
const data = await res.json(); // HTTP 201
```

</details>

Response (live, token redacted):

```json
{
  "token": "jvl_••••••••••••••••••••••••••••••••",
  "tier": "free",
  "daily_cap": 100,
  "note": "Shown once. Only its hash is stored."
}
```

**How to read it:** token is your key. It is shown only in this response, so save it now. Each network (IP) can create 3 keys per day; more returns 429 RATE_LIMITED.

### Error: missing key

`GET /v1/adapters` → HTTP 401

```bash
curl -s https://jevlet.iggy-mw.workers.dev/v1/adapters
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/adapters", {
  method: "GET"
});
const data = await res.json(); // HTTP 401
```

</details>

Response (live, unedited):

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "path": "authorization",
    "detail": ""
  }
}
```

**How to read it:** 401 UNAUTHORIZED means the Authorization: Bearer header is missing or the key is unknown.

### Error: invalid state

`POST /v1/decide` → HTTP 400

```bash
curl -s -X POST https://jevlet.iggy-mw.workers.dev/v1/decide \
  -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" \
  -d '{"adapter":"csqa","state":{"question":"Pick one","choices":["only one"]}}'
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/decide", {
  method: "POST",
  headers: { authorization: "Bearer " + JEVLET_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({
    "adapter": "csqa",
    "state": {
      "question": "Pick one",
      "choices": [
        "only one"
      ]
    }
  })
});
const data = await res.json(); // HTTP 400
```

</details>

Response (live, unedited):

```json
{
  "error": {
    "code": "INVALID_SCHEMA",
    "path": "state.choices",
    "detail": "minItems 2"
  }
}
```

**How to read it:** path points at the field that failed (state.choices) and detail says why (it needs at least 2 items).

### Error: unknown adapter

`POST /v1/decide` → HTTP 400

```bash
curl -s -X POST https://jevlet.iggy-mw.workers.dev/v1/decide \
  -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" \
  -d '{"adapter":"sentiment","state":{}}'
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/decide", {
  method: "POST",
  headers: { authorization: "Bearer " + JEVLET_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({
    "adapter": "sentiment",
    "state": {}
  })
});
const data = await res.json(); // HTTP 400
```

</details>

Response (live, unedited):

```json
{
  "error": {
    "code": "UNKNOWN_ADAPTER",
    "path": "adapter",
    "detail": "sentiment"
  }
}
```

**How to read it:** detail echoes the adapter id you sent. GET /v1/adapters lists the valid ones.

### Error: too many votes

`POST /v1/decide` → HTTP 400

```bash
curl -s -X POST https://jevlet.iggy-mw.workers.dev/v1/decide \
  -H "authorization: Bearer $JEVLET_TOKEN" \
  -H "content-type: application/json" \
  -d '{"adapter":"csqa","state":{"question":"q","choices":["a","b"]},"options":{"votes":12}}'
```

<details><summary>JavaScript fetch</summary>

```js
const res = await fetch("https://jevlet.iggy-mw.workers.dev/v1/decide", {
  method: "POST",
  headers: { authorization: "Bearer " + JEVLET_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({
    "adapter": "csqa",
    "state": {
      "question": "q",
      "choices": [
        "a",
        "b"
      ]
    },
    "options": {
      "votes": 12
    }
  })
});
const data = await res.json(); // HTTP 400
```

</details>

Response (live, unedited):

```json
{
  "error": {
    "code": "INVALID_SCHEMA",
    "path": "options.votes",
    "detail": "integer 1..9"
  }
}
```

**How to read it:** options.votes must be an integer from 1 to 9.

<!-- examples:end -->

## Billing (Stripe)

Tiers (confirmed; caps defined in `worker/billing.js` `TIERS`, prices in Stripe):

| Tier | Price | Daily cap |
|------|-------|-----------|
| Free | $0 | 100 units |
| Pro | $19 / month | 5,000 units |
| Team | $99 / month | 50,000 units |

Endpoints:

- `POST /v1/billing/checkout` `{"plan":"pro"|"team"}` with the caller's Bearer key. Returns a Stripe Checkout `url` (subscription mode). The session carries `client_reference_id` and `metadata.key_id` = the key's SHA-256 id, never the raw token.
- `POST /v1/billing/webhook`, called by Stripe. Verifies `Stripe-Signature` (HMAC-SHA256, 300 s tolerance), then writes `{tier, daily_cap}` to `key:<key_id>` on `checkout.session.completed` and `customer.subscription.created/updated`, and drops to Free on `customer.subscription.deleted` (or status `canceled`/`unpaid`/`incomplete_expired`/`paused`). Each event id is processed once (KV `stripe_evt:<id>`, 30-day TTL), and older events never overwrite newer ones. Plan changes take effect within a minute (Workers KV is eventually consistent across locations).
- `POST /v1/keys`: self-serve Free key, enabled on this deployment (`SELF_SERVE_KEYS = "true"`). Limited to 3 per client IP per day, using the same atomic D1 reservation as the unit budget.
- `GET /v1/config` (public): whether self-serve keys are on, plus the Payment Link URLs.
- **Payment Links** (`STRIPE_LINK_PRO`, `STRIPE_LINK_TEAM`): the UI appends `?client_reference_id=<sha256(key)>`. On `checkout.session.completed` without `metadata.plan`, the webhook reads the subscription's price to pick the plan, then tags the subscription with `metadata.key_id`, so later updates or cancellation reach the same key.

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
- **Model names change.** `GEMINI_MODEL` is set to `gemini-3.5-flash-lite` in `wrangler.toml` `[vars]` (also the code default); `gemini-2.0-flash` and `gemini-2.5-flash(-lite)` now return 404. `GROQ_MODEL` is set to `openai/gpt-oss-20b` the same way (`llama-3.1-8b-instant` is no longer offered by Groq). `WORKERS_AI_MODEL` defaults to a name current when this was written. Verify them, and the free-tier limits, before launch. KV write limits are usually the first wall.

## Limitations (from the spec, unchanged)

- Vote-share confidence is only as good as the calibration set.
- Type-safe output can still be wrong. Abstention and human review are the safety net.
- Five votes across five providers can burn a free-tier daily quota quickly.
