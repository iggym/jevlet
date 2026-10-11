// Pure logic shared by the Worker and the Node tests.
// No platform APIs in this file (crypto.subtle exists in both Workers and Node 22).

export const CAL_MIN_N = 200;

export const err = (code, path = "$", detail = "") => ({ error: { code, path, detail } });

// ---------- request validation (JSON-schema subset) ----------

export function validate(value, schema, path = "$") {
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return { path, detail: "expected object" };
    for (const k of schema.required ?? [])
      if (!(k in value)) return { path: `${path}.${k}`, detail: "required" };
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in value) {
        const r = validate(value[k], sub, `${path}.${k}`);
        if (r) return r;
      }
    }
    return null;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return { path, detail: "expected array" };
    if (schema.minItems != null && value.length < schema.minItems)
      return { path, detail: `minItems ${schema.minItems}` };
    if (schema.maxItems != null && value.length > schema.maxItems)
      return { path, detail: `maxItems ${schema.maxItems}` };
    if (schema.items)
      for (let i = 0; i < value.length; i++) {
        const r = validate(value[i], schema.items, `${path}[${i}]`);
        if (r) return r;
      }
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return { path, detail: "expected string" };
    if (schema.minLength != null && value.length < schema.minLength)
      return { path, detail: `minLength ${schema.minLength}` };
    if (schema.maxLength != null && value.length > schema.maxLength)
      return { path, detail: `maxLength ${schema.maxLength}` };
    return null;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return { path, detail: "expected number" };
    if (schema.type === "integer" && !Number.isInteger(value)) return { path, detail: "expected integer" };
    if (schema.minimum != null && value < schema.minimum) return { path, detail: `minimum ${schema.minimum}` };
    if (schema.maximum != null && value > schema.maximum) return { path, detail: `maximum ${schema.maximum}` };
    return null;
  }
  if (schema.type === "boolean")
    return typeof value === "boolean" ? null : { path, detail: "expected boolean" };
  return { path, detail: `unsupported schema type ${schema.type}` };
}

// ---------- hashing and deterministic serialization ----------

export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k]))
      .join(",") +
    "}"
  );
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- seeded option shuffling (position-bias control) ----------

export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// perm[shownPosition] = originalIndex
export function permutation(k, seedStr) {
  const r = rng(hashSeed(seedStr));
  const p = [...Array(k).keys()];
  for (let i = k - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

// ---------- prompts and output parsing ----------

const renderFields = (s) =>
  Object.entries(s)
    .map(([k, v]) => `${k}:\n${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n\n");

export function buildPrompt(adapter, state, shownLabels = []) {
  if (adapter.head === "choice") {
    const opts = shownLabels.map((l, i) => `${i}. ${l}`).join("\n");
    return {
      system: `${adapter.question}\nReply with JSON only, no prose: {"choice": <0-based integer index of the option>}.`,
      user: `Question: ${state.question}\n\nOptions:\n${opts}`,
    };
  }
  if (adapter.head === "boolean") {
    return {
      system: `${adapter.question}\nReply with JSON only, no prose: {"value": true} or {"value": false}.`,
      user: renderFields(state),
    };
  }
  const [lo, hi] = adapter.score_range;
  return {
    system: `${adapter.question}\nReply with JSON only, no prose: {"score": <number from ${lo} to ${hi}>}.`,
    user: renderFields(state),
  };
}

export function extractJson(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}

// Strict: a vote is accepted only if it matches the head's type exactly.
// For choice, `value` is the index in the SHOWN (shuffled) order; the caller maps it back.
export function parseVote(adapter, raw, K = 0) {
  if (!raw || typeof raw !== "object") return { ok: false, detail: "not an object" };
  if (adapter.head === "choice") {
    const c = raw.choice;
    if (!Number.isInteger(c) || c < 0 || c >= K) return { ok: false, detail: "choice out of range" };
    return { ok: true, value: c };
  }
  if (adapter.head === "boolean") {
    return typeof raw.value === "boolean" ? { ok: true, value: raw.value } : { ok: false, detail: "value not boolean" };
  }
  if (adapter.head === "score") {
    const [lo, hi] = adapter.score_range;
    const s = raw.score;
    if (typeof s !== "number" || !Number.isFinite(s) || s < lo || s > hi)
      return { ok: false, detail: "score out of range" };
    return { ok: true, value: s };
  }
  return { ok: false, detail: "unknown head" };
}

// ---------- aggregation and calibration ----------

// originals: array of ORIGINAL label indices (already mapped back from shuffled order)
export function aggregateChoice(originals, K) {
  const counts = new Array(K).fill(0);
  for (const i of originals) counts[i]++;
  const n = originals.length;
  return counts.map((c) => (c + 1 / K) / (n + 1)); // add-1/K smoothing, sums to 1
}

// returns [pFalse, pTrue]
export function aggregateBoolean(values) {
  const t = values.filter(Boolean).length;
  const pt = (t + 0.5) / (values.length + 1);
  return [1 - pt, pt];
}

// Temperature on a probability vector: p_i^(1/T), renormalized.
// For two classes this is equivalent to sigmoid(logit(p)/T).
export function applyTemperature(p, T) {
  if (!T || T === 1) return p.slice();
  const w = p.map((x) => Math.pow(x, 1 / T));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}

export function argmax(p) {
  let b = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i;
  return b;
}

// samples: [{ p: number[], t: number }] where t is the true class index
export function fitTemperature(samples) {
  let best = { T: 1, nll: Infinity };
  for (let k = 6; k <= 60; k++) {
    const T = k / 20; // grid 0.30 .. 3.00
    let nll = 0;
    for (const s of samples) nll -= Math.log(Math.max(applyTemperature(s.p, T)[s.t], 1e-12));
    nll /= samples.length;
    if (nll < best.nll) best = { T, nll };
  }
  return best.T;
}

// Expected calibration error over equal-width confidence bins.
export function ece(samples, bins = 10) {
  const N = samples.length;
  if (!N) return null;
  const cnt = new Array(bins).fill(0);
  const conf = new Array(bins).fill(0);
  const acc = new Array(bins).fill(0);
  for (const s of samples) {
    const pred = argmax(s.p);
    const c = s.p[pred];
    const b = Math.min(bins - 1, Math.floor(c * bins));
    cnt[b]++;
    conf[b] += c;
    acc[b] += pred === s.t ? 1 : 0;
  }
  let e = 0;
  for (let b = 0; b < bins; b++)
    if (cnt[b]) e += (cnt[b] / N) * Math.abs(acc[b] / cnt[b] - conf[b] / cnt[b]);
  return e;
}

// Maps a stored ground-truth string to a distribution index.
// boolean: [false, true]; choice: index into the request's labels.
export function truthIndex(head, labels, truth) {
  if (head === "boolean") return String(truth) === "true" ? 1 : 0;
  const i = labels.indexOf(String(truth));
  if (i >= 0) return i;
  if (/^\d+$/.test(String(truth)) && Number(truth) < labels.length) return Number(truth);
  return -1;
}

// votes: [{ value }] where value is an original label index (choice), boolean, or number (score)
export function decide(adapter, votes, cal, tauOverride, labels) {
  const useCal = !!(cal && cal.n >= CAL_MIN_N && cal.temperature);
  const T = useCal ? cal.temperature : null;
  const tau = tauOverride ?? cal?.tau ?? adapter.tau ?? null;
  const vals = votes.map((v) => v.value);

  if (adapter.head === "score") {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const spread = Math.sqrt(vals.reduce((a, x) => a + (x - mean) ** 2, 0) / vals.length);
    return {
      decision: { type: "score", value: mean, spread, range: adapter.score_range, confidence: null, abstain: false },
      calibrated: false,
      temperature: null,
      tau: null,
    };
  }

  if (adapter.head === "choice") {
    let p = aggregateChoice(vals, labels.length);
    if (T) p = applyTemperature(p, T);
    const best = argmax(p);
    const abstain = tau != null && p[best] < tau;
    return {
      decision: {
        type: "choice",
        value: abstain ? null : best,
        label: abstain ? null : labels[best],
        confidence: p[best],
        distribution: p,
        abstain,
      },
      calibrated: !!T,
      temperature: T,
      tau,
    };
  }

  // boolean
  let p = aggregateBoolean(vals);
  if (T) p = applyTemperature(p, T);
  const best = argmax(p);
  const abstain = tau != null && p[best] < tau;
  return {
    decision: {
      type: "boolean",
      value: abstain ? null : best === 1,
      confidence: p[best],
      distribution: p, // [pFalse, pTrue]
      abstain,
    },
    calibrated: !!T,
    temperature: T,
    tau,
  };
}

// ---------- model output extraction ----------
// (kept here so tests can cover it)
export const TIMEOUT_MS = 4000;
