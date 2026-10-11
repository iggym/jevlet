// Seasonal adornments + showcase: season logic, real-only card content, asset budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import * as S from "../web/assets/seasonal.js";
import { TOPIC_IDS, FACTS } from "../web/assets/help.js";
import { TIERS } from "../worker/billing.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const html = read("web/index.html");
const helpSrc = read("web/assets/help.js");

test("season: picked by month (Northern Hemisphere), override only for known seasons", () => {
  const at = (m) => S.pickSeason(new Date(2026, m, 15));
  assert.deepEqual([...Array(12).keys()].map(at), [
    "winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter",
  ]);
  assert.equal(S.pickSeason(new Date(2026, 9, 11)), "autumn"); // today's deploy date
  assert.equal(S.pickSeason(new Date(2026, 9, 11), "winter"), "winter");
  assert.equal(S.pickSeason(new Date(2026, 9, 11), "monsoon"), "autumn");
});

test("season: hero images exist for autumn and winter as WebP; spring/summer fall back to gradient", () => {
  for (const s of ["autumn", "winter"]) {
    for (const w of [800, 1600]) {
      const f = new URL(`web${S.HERO[s].base}-${w}.webp`, root);
      assert.ok(existsSync(f), f.pathname);
      assert.equal(readFileSync(f).subarray(8, 12).toString(), "WEBP");
    }
    assert.match(S.HERO[s].credit.page, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    assert.equal(S.HERO[s].credit.license, "CC BY-SA 4.0");
  }
  assert.equal(S.HERO.spring, null);
  assert.equal(S.HERO.summer, null);
  for (const s of S.SEASONS) assert.ok(S.SEASON_SET[s], s);
});

test("particles are capped", () => {
  assert.ok(S.MAX_PARTICLES.desktop <= 24 && S.MAX_PARTICLES.mobile <= S.MAX_PARTICLES.desktop);
});

test("showcase: every card is a real Jevlet tool wired to a real tab, help topic and screenshot", () => {
  const cats = new Set(S.CATEGORIES.map((c) => c.id));
  assert.deepEqual(S.CATEGORIES.map((c) => c.label), ["All Apps", "Seasonal Specials", "Productivity", "Utilities"]);
  const ids = S.CARDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of S.CARDS) {
    assert.ok(cats.has(c.cat) && c.cat !== "all", c.id);
    assert.ok(TOPIC_IDS.includes(c.topic), `${c.id} topic ${c.topic}`);
    if (c.tab) assert.ok(html.includes(`data-tab="${c.tab}"`), `${c.id} tab ${c.tab}`);
    if (c.adapter) assert.ok(existsSync(new URL(`adapters/${c.adapter}.json`, root)), c.adapter);
    assert.ok(existsSync(new URL(`web/assets/img/apps/${c.id}.webp`, root)), `${c.id} thumbnail`);
    assert.doesNotMatch(c.desc, /https?:\/\//, "no external URLs in card copy");
  }
  // Exactly the requested real features are present.
  for (const need of ["csqa", "policy_check", "calibrate", "usage", "plans", "quickstart", "eval", "mkkey"]) assert.ok(ids.includes(need), need);
  // Nothing invented for the seasonal category: it shows the empty state instead.
  assert.equal(S.CARDS.filter((c) => c.cat === "seasonal").length, 0);
});

test("showcase: card facts match the code", () => {
  const card = (id) => S.CARDS.find((c) => c.id === id).desc;
  for (const t of Object.values(FACTS.tiers)) assert.ok(card("plans").includes(t.cap.toLocaleString("en-US")), t.name);
  assert.ok(card("plans").includes("$19/mo") && card("plans").includes("$99/mo"));
  assert.equal(TIERS.pro.daily_cap, 5000);
  const csqa = JSON.parse(read("adapters/csqa.json")).input_schema.properties.choices;
  assert.ok(card("csqa").includes(`${csqa.minItems}–${csqa.maxItems} options`));
  assert.ok(card("batch").includes(`${FACTS.batchConcurrency} at a time`));
  assert.ok(card("calibrate").includes(`${FACTS.calMinN} labels`));
  // eval card lists fields the runner really prints
  const ev = read("eval/run.mjs");
  for (const f of ["accuracy_on_kept", "abstention_rate", "cost_units_per_decision", "latency_ms_p50", "latency_ms_p95"]) assert.ok(ev.includes(f), f);
  assert.ok(read("package.json").includes('"eval": "node eval/run.mjs eval/sets/sample.jsonl"'));
  assert.ok(read("tools/mkkey.mjs").includes("sha256"));
});

test("help: TOPIC_IDS matches the topics defined in help.js", () => {
  for (const id of TOPIC_IDS) assert.match(helpSrc, new RegExp(`\\n    ${id}: \\{\\n      title:`), id);
  const defined = [...helpSrc.matchAll(/\n    ([a-z]+): \{\n      title:/g)].map((m) => m[1]);
  assert.deepEqual(defined.sort(), [...TOPIC_IDS].sort());
});

test("page weight: all static UI assets stay well under budget", () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  const files = walk(new URL("web/assets", root).pathname);
  const total = files.reduce((a, f) => a + statSync(f).size, 0);
  assert.ok(total < 1.5 * 1024 * 1024, `web/assets is ${total} bytes`);
  // Each image is WebP.
  for (const f of files.filter((f) => f.includes("/img/"))) assert.match(f, /\.webp$/);
});
