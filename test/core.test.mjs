import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../worker/core.js";

const csqa = JSON.parse(readFileSync(new URL("../adapters/csqa.json", import.meta.url), "utf8"));
const policy = JSON.parse(readFileSync(new URL("../adapters/policy_check.json", import.meta.url), "utf8"));
const sum = (a) => a.reduce((x, y) => x + y, 0);

test("validate: accepts a good CSQA state and rejects bad ones with a path", () => {
  const ok = { question: "Where do people keep books?", choices: ["lab", "bookshelf"] };
  assert.equal(C.validate(ok, csqa.input_schema, "state"), null);
  const one = C.validate({ question: "q", choices: ["only"] }, csqa.input_schema, "state");
  assert.equal(one.path, "state.choices");
  const missing = C.validate({ question: "q" }, csqa.input_schema, "state");
  assert.equal(missing.path, "state.choices");
  const wrongType = C.validate({ question: 5, choices: ["a", "b"] }, csqa.input_schema, "state");
  assert.equal(wrongType.path, "state.question");
});

test("permutation is a true permutation and mapping back recovers each label", () => {
  for (const seed of ["a", "seed-2", "xyz|3"]) {
    const labels = ["lab", "desktop", "laptop", "server", "bookshelf"];
    const perm = C.permutation(labels.length, seed);
    assert.deepEqual([...perm].sort(), [0, 1, 2, 3, 4]);
    const shown = perm.map((j) => labels[j]);
    // Reversibility: for every original index j, the shown position that holds it maps back to j.
    const inv = [];
    perm.forEach((orig, pos) => (inv[orig] = pos));
    labels.forEach((label, j) => assert.equal(shown[inv[j]], label));
  }
});

test("permutation is deterministic for the same seed", () => {
  assert.deepEqual(C.permutation(6, "same"), C.permutation(6, "same"));
});

test("aggregateChoice sums to 1 and never gives exactly 0", () => {
  const p = C.aggregateChoice([2, 2, 2, 0, 4], 5);
  assert.ok(Math.abs(sum(p) - 1) < 1e-9);
  assert.ok(p.every((x) => x > 0));
  assert.equal(C.argmax(p), 2);
});

test("aggregateBoolean sums to 1 and tracks the majority", () => {
  const [pf, pt] = C.aggregateBoolean([true, true, true, false, true]);
  assert.ok(Math.abs(pf + pt - 1) < 1e-9);
  assert.ok(pt > 0.5);
});

test("applyTemperature keeps a distribution normalized; T=1 is identity", () => {
  const p = [0.1, 0.2, 0.7];
  assert.deepEqual(C.applyTemperature(p, 1), p);
  for (const T of [0.5, 1.31, 2.5]) assert.ok(Math.abs(sum(C.applyTemperature(p, T)) - 1) < 1e-9);
  // Higher T flattens the distribution.
  assert.ok(C.applyTemperature(p, 3)[2] < p[2]);
});

test("parseVote is strict about type and range", () => {
  assert.equal(C.parseVote(csqa, { choice: 2 }, 5).ok, true);
  assert.equal(C.parseVote(csqa, { choice: 5 }, 5).ok, false);
  assert.equal(C.parseVote(csqa, { choice: "2" }, 5).ok, false);
  assert.equal(C.parseVote(csqa, null, 5).ok, false);
  assert.equal(C.parseVote(policy, { value: true }).ok, true);
  assert.equal(C.parseVote(policy, { value: "yes" }).ok, false);
  const score = { head: "score", score_range: [0, 1] };
  assert.equal(C.parseVote(score, { score: 1.5 }).ok, false);
  assert.equal(C.parseVote(score, { score: 0.4 }).ok, true);
});

test("extractJson handles code fences and surrounding prose", () => {
  assert.deepEqual(C.extractJson('```json\n{"choice": 1}\n```'), { choice: 1 });
  assert.deepEqual(C.extractJson('Sure! {"value": false}'), { value: false });
  assert.equal(C.extractJson("no json here"), null);
});

test("stableStringify ignores key order", () => {
  assert.equal(C.stableStringify({ a: 1, b: { y: 2, x: 1 } }), C.stableStringify({ b: { x: 1, y: 2 }, a: 1 }));
});

test("decide: a clear majority is kept; a split vote abstains below tau", () => {
  const labels = ["lab", "desktop", "laptop", "server", "bookshelf"];
  const clear = C.decide(csqa, [{ value: 2 }, { value: 2 }, { value: 2 }, { value: 2 }, { value: 0 }], null, null, labels);
  assert.equal(clear.decision.abstain, false);
  assert.equal(clear.decision.label, "laptop");
  assert.ok(Math.abs(sum(clear.decision.distribution) - 1) < 1e-9);

  const split = C.decide(csqa, [{ value: 0 }, { value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }], null, null, labels);
  assert.equal(split.decision.abstain, true);
  assert.equal(split.decision.value, null);
  assert.equal(split.decision.label, null);
});

test("decide: boolean majority and abstention", () => {
  const yes = C.decide(policy, [1, 1, 1, 1, 1].map((v) => ({ value: true })), null, null, null);
  assert.equal(yes.decision.value, true);
  assert.equal(yes.decision.abstain, false);
  const tie = C.decide(policy, [true, false, true, false].map((v) => ({ value: v })), null, null, null);
  assert.equal(tie.decision.abstain, true);
});

test("decide: calibration is only applied once n >= 200", () => {
  const votes = [{ value: 2 }, { value: 2 }, { value: 2 }, { value: 2 }, { value: 2 }];
  const labels = ["a", "b", "c"];
  const early = C.decide(csqa, votes, { tau: 0.2, temperature: 2, n: 50 }, null, labels);
  assert.equal(early.calibrated, false);
  const late = C.decide(csqa, votes, { tau: 0.2, temperature: 2, n: 300 }, null, labels);
  assert.equal(late.calibrated, true);
  assert.ok(late.decision.confidence < early.decision.confidence);
});

test("fitTemperature returns a value on the grid and ece is in [0,1]", () => {
  const samples = [];
  for (let i = 0; i < 100; i++) samples.push({ p: [0.9, 0.1], t: i % 3 === 0 ? 1 : 0 }); // overconfident
  const T = C.fitTemperature(samples);
  assert.ok(T >= 0.3 && T <= 3.0);
  assert.ok(T > 1, "overconfident predictions should be softened (T > 1)");
  const e = C.ece(samples);
  assert.ok(e >= 0 && e <= 1);
});

test("truthIndex maps labels and booleans", () => {
  assert.equal(C.truthIndex("choice", ["a", "b", "c"], "b"), 1);
  assert.equal(C.truthIndex("choice", ["a", "b", "c"], "2"), 2);
  assert.equal(C.truthIndex("choice", ["a", "b"], "zzz"), -1);
  assert.equal(C.truthIndex("boolean", null, "true"), 1);
  assert.equal(C.truthIndex("boolean", null, "false"), 0);
});

test("buildPrompt for choice lists options in the shown order", () => {
  const state = { question: "Q?", choices: ["x", "y"] };
  const p = C.buildPrompt(csqa, state, ["y", "x"]);
  assert.match(p.user, /0\. y\n1\. x/);
});
