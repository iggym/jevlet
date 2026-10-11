-- One label per decision (re-labelling replaces it), and a per-key daily label counter
-- used to cap /v1/calibrate.

DELETE FROM labels
 WHERE rowid NOT IN (SELECT MAX(rowid) FROM labels GROUP BY decision_id);

DROP INDEX IF EXISTS idx_labels_decision;
CREATE UNIQUE INDEX idx_labels_decision_unique ON labels(decision_id);

ALTER TABLE usage_daily ADD COLUMN labels INTEGER NOT NULL DEFAULT 0;
