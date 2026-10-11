// D1/KV access for metering and calibration. Kept separate from worker.js so the
// SQL can be tested against a real SQLite engine (see test/helpers/fakes.mjs).

// ---------- per-key calibration (KV) ----------

// Calibration is scoped to the key that submitted the labels. One customer's labels
// must never change another customer's output, so there is no global fallback:
// a key without its own fit is served uncalibrated (adapter tau, no temperature).
export const calKey = (adapterId, keyId) => `cal:${adapterId}:${keyId}`;

export async function getCalibration(env, adapterId, keyId) {
  return (await env.KV.get(calKey(adapterId, keyId), "json")) ?? null;
}

export async function putCalibration(env, adapterId, keyId, cal) {
  await env.KV.put(calKey(adapterId, keyId), JSON.stringify(cal));
}

// ---------- atomic budget (D1) ----------
// D1 runs each statement, and each batch, as one SQLite transaction on a single writer.
// The conditional UPDATE below checks and increments in one statement, so two
// concurrent requests cannot both pass the check on a stale read.

// Reserves `amount` of `column` (units | labels) for key/day if it stays within `cap`.
// Returns { ok: true, used } (used includes this reservation) or { ok: false, used }.
export async function reserve(db, keyId, day, amount, cap, column = "units") {
  if (column !== "units" && column !== "labels") throw new Error("bad column");
  const [, upd] = await db.batch([
    db.prepare("INSERT INTO usage_daily (key_id, day) VALUES (?, ?) ON CONFLICT(key_id, day) DO NOTHING").bind(keyId, day),
    db
      .prepare(
        `UPDATE usage_daily SET ${column} = ${column} + ?1
          WHERE key_id = ?2 AND day = ?3 AND ${column} + ?1 <= ?4
        RETURNING ${column} AS used`
      )
      .bind(amount, keyId, day, cap),
  ]);
  const row = upd?.results?.[0];
  if (row) return { ok: true, used: row.used };
  const cur = await db.prepare(`SELECT ${column} AS used FROM usage_daily WHERE key_id = ? AND day = ?`).bind(keyId, day).first();
  return { ok: false, used: cur?.used ?? 0 };
}

// Adjusts a units reservation to what was actually spent. delta = actual - reserved
// (negative refunds unused votes). countCall increments `calls`.
export function settleUnitsStmt(db, keyId, day, delta, countCall) {
  return db
    .prepare("UPDATE usage_daily SET units = MAX(0, units + ?), calls = calls + ? WHERE key_id = ? AND day = ?")
    .bind(delta, countCall ? 1 : 0, keyId, day);
}

// ---------- calibration labels ----------

export const MAX_LABELS_PER_CALL = 500;
export const DEFAULT_DAILY_LABEL_CAP = 2000;

// Validates and de-duplicates a /v1/calibrate labels array.
// The last label for a decision_id wins. Returns { ok, labels } or { ok: false, path, detail }.
export function normalizeLabels(input) {
  if (input == null) return { ok: true, labels: [] };
  if (!Array.isArray(input)) return { ok: false, path: "labels", detail: "must be an array" };
  if (input.length > MAX_LABELS_PER_CALL)
    return { ok: false, path: "labels", detail: `max ${MAX_LABELS_PER_CALL} per call` };
  const byId = new Map();
  for (const [i, l] of input.entries()) {
    if (!l || typeof l.decision_id !== "string" || !l.decision_id || l.decision_id.length > 64 || l.truth == null)
      return { ok: false, path: `labels[${i}]`, detail: "needs decision_id (string) and truth" };
    const truth = String(l.truth);
    if (truth.length > 300) return { ok: false, path: `labels[${i}].truth`, detail: "maxLength 300" };
    byId.delete(l.decision_id); // keep insertion order = position of the last occurrence
    byId.set(l.decision_id, truth);
  }
  return { ok: true, labels: [...byId].map(([decision_id, truth]) => ({ decision_id, truth })) };
}

// Upserts labels, but only for decisions made by this key (others are silently skipped
// and not counted as stored). Requires the unique index from migration 0002.
export async function storeLabels(db, keyId, labels, now = Date.now()) {
  if (!labels.length) return 0;
  const res = await db.batch(
    labels.map((l) =>
      db
        .prepare(
          `INSERT INTO labels (decision_id, truth, ts)
             SELECT id, ?1, ?2 FROM decisions WHERE id = ?3 AND key_id = ?4
           ON CONFLICT(decision_id) DO UPDATE SET truth = excluded.truth, ts = excluded.ts`
        )
        .bind(l.truth, now, l.decision_id, keyId)
    )
  );
  return res.reduce((a, r) => a + (r?.meta?.changes ?? 0), 0);
}
