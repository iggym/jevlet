// Provider chain: Jev (optional) -> Gemini -> Groq -> Workers AI.
// Each call returns raw text or throws. judgeOnce() falls through on error,
// timeout, or off-schema output, and reports how many real provider calls were made.

import { extractJson, TIMEOUT_MS } from "./core.js";

function withTimeout(promise, ms) {
  let t;
  const to = new Promise((_, rej) => {
    t = setTimeout(() => {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      rej(e);
    }, ms);
  });
  return Promise.race([promise, to]).finally(() => clearTimeout(t));
}

// Model names change; verify before launch and override via env.
async function callGemini(env, p) {
  const model = env.GEMINI_MODEL || "gemini-2.0-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: p.system }] },
      contents: [{ role: "user", parts: [{ text: p.user }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const j = await r.json();
  return j.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function callGroq(env, p) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: env.GROQ_MODEL || "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: p.system },
        { role: "user", content: p.user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.8,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
}

async function callWorkersAI(env, p) {
  const r = await withTimeout(
    env.AI.run(env.WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: p.system },
        { role: "user", content: p.user },
      ],
    }),
    TIMEOUT_MS
  );
  return r?.response ?? "";
}

// Jev: wired as a generic JSON-over-HTTP provider. The real TypeSafe API
// request/response shape is NOT verified here; check its docs before enabling.
async function callJev(env, p) {
  const r = await fetch(env.JEV_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.JEV_API_KEY}` },
    body: JSON.stringify({ system: p.system, user: p.user, response_format: "json" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`jev ${r.status}`);
  const j = await r.json();
  return j.output ?? j.text ?? "";
}

const CHAIN = [
  ["jev", callJev, (env) => !!(env.JEV_API_KEY && env.JEV_URL)],
  ["gemini", callGemini, (env) => !!env.GEMINI_API_KEY],
  ["groq", callGroq, (env) => !!env.GROQ_API_KEY],
  ["workers_ai", callWorkersAI, (env) => !!env.AI],
];

// parse(rawObject) -> { ok, value, detail }
export async function judgeOnce(env, prompt, parse) {
  const fallbacks = [];
  let attempts = 0;
  for (const [name, call, configured] of CHAIN) {
    if (!configured(env)) continue; // unconfigured providers cost nothing
    attempts++;
    try {
      const text = await call(env, prompt);
      const parsed = parse(extractJson(text));
      if (parsed.ok) return { ok: true, value: parsed.value, provider: name, attempts, fallbacks };
      fallbacks.push(`${name}:OFF_SCHEMA_OUTPUT`);
    } catch (e) {
      fallbacks.push(`${name}:${e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "error"}`);
    }
  }
  return { ok: false, attempts, fallbacks };
}
