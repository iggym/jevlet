// Worked examples (web/assets/examples.js) must match what the code really returns:
// every example request is replayed against the Worker with fake bindings and a stubbed
// provider, and the status + field names must match. README must carry the generated block.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../worker/worker.js";
import { EXAMPLES, exampleById, exampleCurl, exampleFetch } from "../web/assets/examples.js";
import { TOPIC_EXAMPLES } from "../web/assets/help.js";
import { CARDS } from "../web/assets/seasonal.js";
import { readmeExamples } from "../tools/readme-examples.mjs";
import { FakeD1, FakeKV, makeCtx } from "./helpers/fakes.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const TOKEN = "jvl_examples_test_token";
let env, realFetch;

beforeEach(async () => {
  env = {
    KV: new FakeKV(), DB: new FakeD1(), GEMINI_API_KEY: "t", SELF_SERVE_KEYS: "true",
    STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_TEAM: "price_team",
    APP_URL: "https://jevlet.example", ASSETS: { fetch: () => new Response("ui") },
  };
  await env.KV.put("key:" + sha(TOKEN), JSON.stringify({ tier: "free", daily_cap: 100 }));
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("stripe.com")) return new Response(JSON.stringify({ id: "cs_test_x", url: "https://checkout.stripe.com/c/pay/cs_test_x" }));
    // Gemini stub: always picks option 1 / true
    const text = JSON.stringify({ choice: 1, value: true });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function run(ex, body = ex.body) {
  const headers = { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" };
  if (ex.auth) headers.authorization = "Bearer " + TOKEN;
  const res = await worker.fetch(new Request("https://jevlet.example" + ex.path, { method: ex.method, headers, body: body ? JSON.stringify(body) : undefined }), env, makeCtx());
  return { status: res.status, body: await res.json() };
}

// Same field names recursively (arrays: compare first element). A trimmed example may
// replace a nested value with a string placeholder.
function sameShape(example, actual, path = "$", trimmed = false) {
  if (trimmed && typeof example === "string" && typeof actual === "object") return;
  if (Array.isArray(example)) {
    assert.ok(Array.isArray(actual), `${path} should be an array`);
    if (example.length && actual.length) sameShape(example[0], actual[0], path + "[0]", trimmed);
    return;
  }
  if (example && typeof example === "object") {
    assert.ok(actual && typeof actual === "object", `${path} should be an object`);
    assert.deepEqual(Object.keys(example).sort(), Object.keys(actual).sort(), `field names at ${path}`);
    for (const k of Object.keys(example)) if (example[k] !== null && actual[k] !== null) sameShape(example[k], actual[k], `${path}.${k}`, trimmed);
    return;
  }
  if (example !== null && actual !== null) assert.equal(typeof example, typeof actual, `type at ${path}`);
}

for (const ex of EXAMPLES.filter((e) => e.id !== "batch" && e.id !== "calibrate")) {
  test(`example "${ex.id}" matches the live code (status + fields)`, async () => {
    const r = await run(ex);
    assert.equal(r.status, ex.status);
    sameShape(ex.response, r.body, "$", Boolean(ex.trimmed));
  });
}

test('example "calibrate" matches (label a decision made in this run)', async () => {
  const d = await run(exampleById("decide-csqa"));
  const ex = exampleById("calibrate");
  const r = await run(ex, { ...ex.body, labels: [{ decision_id: d.body.decision_id, truth: "laptop" }] });
  assert.equal(r.status, ex.status);
  sameShape(ex.response, r.body);
});

test('example "batch" lines are valid decide requests and the CSV header matches the UI export', async () => {
  const ex = exampleById("batch");
  for (const b of ex.batch) assert.equal((await run(ex, b)).status, 200);
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const header = ex.response.split("\n")[0];
  const ui = html.match(/const head = (\[[^\]]+\]);/)[1];
  assert.deepEqual(JSON.parse(ui), header.split(","), "CSV header matches index.html export");
});

test("decide examples report the same numbers the response fields imply", () => {
  for (const id of ["decide-csqa", "decide-policy"]) {
    const { body, response: r } = exampleById(id);
    assert.equal(r.diagnostics.cost_units, body.options.votes);
    assert.equal(r.diagnostics.votes, body.options.votes);
    assert.equal(r.decision.abstain, r.decision.confidence < r.diagnostics.tau);
    assert.equal(r.decision.confidence, Math.max(...r.decision.distribution));
    assert.equal(r.adapter, body.adapter);
    assert.equal(r.task_id, body.task_id);
  }
  assert.equal(exampleById("decide-csqa").response.decision.label, "laptop");
});

test("every feature has an example; help topics, cards and README all point at real examples", () => {
  const features = new Set(EXAMPLES.map((e) => e.feature));
  for (const f of ["decision", "adapters", "batch", "calibration", "usage", "plans", "keys", "errors"]) assert.ok(features.has(f), f);
  for (const f of Object.values(TOPIC_EXAMPLES)) assert.ok(features.has(f), `topic feature ${f}`);
  for (const c of CARDS) if (c.example) assert.ok(exampleById(c.example), `card ${c.id} -> ${c.example}`);
  assert.ok(CARDS.filter((c) => c.example).length >= 8);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(readmeExamples()), "README examples block is up to date (node tools/readme-examples.mjs)");
  for (const ex of EXAMPLES) {
    assert.ok(ex.read && ex.read.length > 20, `${ex.id} has a how-to-read line`);
    assert.match(exampleCurl(ex, "https://h"), /^(curl|#)/);
    assert.match(exampleFetch(ex, "https://h"), /fetch\("https:\/\/h\/v1\//);
    if (ex.auth) assert.match(exampleCurl(ex, "https://h"), /authorization: Bearer \$JEVLET_TOKEN/);
  }
});

test("no real key or secret in the examples", () => {
  const s = JSON.stringify(EXAMPLES);
  assert.doesNotMatch(s, /jvl_[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(s, /sk_(test|live)_|whsec_|rk_live/);
});

test("key guide: on the home page, in the tour, and in README", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const help = readFileSync(new URL("../web/assets/help.js", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(html, /id="get-key"/);
  assert.equal((html.match(/<section id="get-key"[\s\S]*?<\/section>/)[0].match(/<li>/g) || []).length, 6);
  assert.match(html, /id="gk-create"/);
  assert.match(help, /sel: "#get-key"/);
  assert.match(readme, /## Get your API key\n\n1\. \*\*Create a key/);
  assert.equal((html.match(/class="paylink"/g) || []).length, 4, "Pay with Stripe on both plans and in the guide");
});
