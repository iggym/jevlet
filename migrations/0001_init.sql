-- Durable state (D1). Hot state (keys, cache, calibration) lives in KV.

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  task_id TEXT,
  head TEXT NOT NULL,
  value TEXT,                 -- JSON-encoded decision value (null when abstained)
  confidence REAL,
  abstained INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  votes INTEGER,
  cost_units INTEGER,
  latency_ms INTEGER,
  input_hash TEXT,
  labels TEXT,                -- JSON array of choice labels in request order (choice head only)
  distribution TEXT           -- JSON array; needed to fit calibration later
);

CREATE TABLE labels (
  decision_id TEXT NOT NULL,  -- ground truth for calibration
  truth TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE usage_daily (
  key_id TEXT NOT NULL,
  day TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

CREATE INDEX idx_dec_adapter_ts ON decisions(adapter, ts);
CREATE INDEX idx_labels_decision ON labels(decision_id);
