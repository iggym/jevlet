// Keeps the in-app help (web/assets/help.js) honest: every fact it shows is checked
// against the Worker code, adapters, and UI so the docs cannot drift from behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as H from "../web/assets/help.js";
import * as C from "../worker/core.js";
import { TIERS } from "../worker/billing.js";
import { MAX_LABELS_PER_CALL, DEFAULT_DAILY_LABEL_CAP } from "../worker/store.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const adapter = (id) => JSON.parse(read(`../adapters/${id}.json`));
const workerSrc = read("../worker/worker.js");
const billingSrc = read("../worker/billing.js");
const html = read("../web/index.html");

test("help: adapter facts match adapters/*.json", () => {
  for (const [id, f] of Object.entries(H.FACTS.adapters)) {
    const a = adapter(id);
    assert.equal(f.head, a.head, id);
    assert.equal(f.tau, a.tau, id);
    assert.equal(f.votes, a.votes, id);
  }
  const csqa = adapter("csqa").input_schema.properties;
  assert.match(H.FACTS.adapters.csqa.input, new RegExp(`1–${csqa.question.maxLength} chars`));
  assert.match(H.FACTS.adapters.csqa.input, new RegExp(`${csqa.choices.minItems}–${csqa.choices.maxItems} options, each up to ${csqa.choices.items.maxLength}`));
  const pol = adapter("policy_check").input_schema.properties;
  assert.equal(pol.policy.maxLength, pol.case.maxLength);
  assert.match(H.FACTS.adapters.policy_check.input, new RegExp(`1–${pol.policy.maxLength} chars`));
  // every installed adapter is documented
  assert.deepEqual(Object.keys(H.FACTS.adapters).sort(), ["csqa", "policy_check"]);
  assert.match(workerSrc, /\[csqa, policyCheck\]/);
});

test("help: limits match the Worker", () => {
  assert.equal(H.FACTS.maxVotes, Number(workerSrc.match(/const MAX_VOTES = (\d+)/)[1]));
  assert.equal(H.FACTS.calMinN, C.CAL_MIN_N);
  assert.equal(H.FACTS.timeoutS * 1000, C.TIMEOUT_MS);
  assert.equal(H.FACTS.cacheHours * 3600, Number(workerSrc.match(/cacheKey, JSON\.stringify\(out\), \{ expirationTtl: (\d+)/)[1]));
  assert.equal(H.FACTS.maxLabelsPerCall, MAX_LABELS_PER_CALL);
  assert.equal(H.FACTS.dailyLabelCap, DEFAULT_DAILY_LABEL_CAP);
  assert.match(html, new RegExp(`Array\\.from\\(\\{ length: ${H.FACTS.batchConcurrency} \\}, worker\\)`));
});

test("help: plans match billing TIERS and the Plans tab copy", () => {
  for (const [k, t] of Object.entries(H.FACTS.tiers)) {
    assert.equal(t.cap, TIERS[k].daily_cap, k);
    assert.ok(html.includes(`<div class="price">$${t.price}</div>`), `price ${k}`);
    assert.ok(html.includes(`${t.cap.toLocaleString("en-US")} units / day`), `cap ${k}`);
  }
  assert.deepEqual(Object.keys(H.FACTS.tiers), Object.keys(TIERS));
});

test("help: error table covers exactly the codes the Worker can return", () => {
  const src = workerSrc + billingSrc;
  const emitted = new Set([...src.matchAll(/err\("([A-Z_]+)"/g)].map((m) => m[1]));
  for (const m of billingSrc.matchAll(/code: "([A-Z_]+)"/g)) emitted.add(m[1]);
  const documented = new Set(H.FACTS.errors.map((e) => e[0]));
  assert.deepEqual([...documented].sort(), [...emitted].sort());
});

test("help: error HTTP statuses match the Worker", () => {
  const status = Object.fromEntries(H.FACTS.errors.map(([c, s]) => [c, s]));
  for (const [, code, s] of workerSrc.matchAll(/err\("([A-Z_]+)"[^;]*?\),\s*(\d{3})\)/g))
    assert.equal(status[code], Number(s), code);
  assert.equal(status.BILLING_ERROR, 502);
  assert.equal(status.BILLING_NOT_CONFIGURED, 503);
});

test("help: simulation math is the Worker's aggregation", () => {
  for (let k = 0; k < 50; k++) {
    const K = 2 + (k % 5);
    const votes = Array.from({ length: 1 + (k % 9) }, (_, i) => (i * 7 + k) % K);
    assert.deepEqual(H.aggregateChoice(votes, K), C.aggregateChoice(votes, K));
    const b = votes.map((v) => v % 2 === 0);
    assert.deepEqual(H.aggregateBoolean(b), C.aggregateBoolean(b));
  }
});

test("help: cap meter uses the same rule as the atomic reservation", () => {
  assert.match(read("../worker/store.js"), /\$\{column\} \+ \?1 <= \?4/);
  assert.equal(H.fitsBudget(95, 5, 100), true);
  assert.equal(H.fitsBudget(96, 5, 100), false);
});
