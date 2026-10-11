// Minimal eval runner. Each line of the input file is:
//   {"adapter":"csqa","state":{...},"truth":"laptop"}      (choice: truth is the label)
//   {"adapter":"policy_check","state":{...},"truth":true}   (boolean)
// Usage: JEVLET_URL=https://... JEVLET_TOKEN=jvl_... node eval/run.mjs eval/sets/sample.jsonl

import { readFileSync } from "node:fs";

const [, , file] = process.argv;
const base = process.env.JEVLET_URL;
const token = process.env.JEVLET_TOKEN;
if (!file || !base || !token) {
  console.error("usage: JEVLET_URL=... JEVLET_TOKEN=... node eval/run.mjs <file.jsonl>");
  process.exit(2);
}

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let correct = 0, kept = 0, abstained = 0, errors = 0, cost = 0;
const latencies = [];

for (const [i, row] of rows.entries()) {
  const r = await fetch(`${base}/v1/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ adapter: row.adapter, task_id: `eval-${i}`, state: row.state, options: { cache: false } }),
  });
  const j = await r.json();
  if (!r.ok) {
    errors++;
    console.error(`row ${i}: ${j.error?.code} ${j.error?.detail ?? ""}`);
    continue;
  }
  cost += j.diagnostics.cost_units;
  latencies.push(j.diagnostics.latency_ms);
  const d = j.decision;
  if (d.abstain) {
    abstained++;
    continue;
  }
  kept++;
  const pred = d.type === "choice" ? d.label : d.value;
  if (String(pred) === String(row.truth)) correct++;
}

const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))] : null);
const n = rows.length;
console.log(JSON.stringify({
  items: n,
  errors,
  accuracy_on_kept: kept ? +(correct / kept).toFixed(4) : null,
  accuracy_overall_abstain_as_wrong: n ? +(correct / n).toFixed(4) : null,
  abstention_rate: n ? +(abstained / n).toFixed(4) : null,
  cost_units_per_decision: n ? +(cost / n).toFixed(2) : null,
  latency_ms_p50: pct(latencies, 0.5),
  latency_ms_p95: pct(latencies, 0.95),
}, null, 2));
