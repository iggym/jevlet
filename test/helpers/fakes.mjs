// Test doubles for the Worker bindings. FakeD1 runs the real migrations on an in-memory
// SQLite (node:sqlite, Node >= 22.5) and mimics the D1 API surface the Worker uses.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args);
  }
  _exec() {
    const st = this.db.prepare(this.sql);
    if (/\breturning\b|^\s*select/i.test(this.sql)) {
      const results = st.all(...this.args);
      return { results, meta: { changes: results.length } };
    }
    const r = st.run(...this.args);
    return { results: [], meta: { changes: Number(r.changes) } };
  }
  async first() {
    return this._exec().results[0] ?? null;
  }
  async all() {
    return this._exec();
  }
  async run() {
    return this._exec();
  }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
      this.db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  // D1 batches run as one transaction.
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s._exec());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

export class FakeKV {
  constructor() {
    this.m = new Map();
  }
  async get(k, type) {
    const v = this.m.get(k);
    if (v == null) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(k, v) {
    this.m.set(k, v);
  }
  async delete(k) {
    this.m.delete(k);
  }
}

export function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), flush: () => Promise.all(pending.splice(0)) };
}
