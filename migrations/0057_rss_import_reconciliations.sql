PRAGMA foreign_keys = ON;

CREATE TABLE rss_import_reconciliations (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) BETWEEN 1 AND 160
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  execution_id TEXT NOT NULL UNIQUE
    REFERENCES rss_import_executions(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL UNIQUE
    REFERENCES rss_import_plans(id) ON DELETE RESTRICT,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  evidence_sha256 TEXT NOT NULL
    CHECK (
      length(evidence_sha256) = 64
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 25),
  copied_bytes INTEGER NOT NULL CHECK (copied_bytes > 0),
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX rss_import_reconciliations_show_approved
  ON rss_import_reconciliations(show_id, approved_at DESC, id DESC);

CREATE TRIGGER rss_import_reconciliations_immutable_update
BEFORE UPDATE ON rss_import_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'rss_import_reconciliation_immutable');
END;

CREATE TRIGGER rss_import_reconciliations_immutable_delete
BEFORE DELETE ON rss_import_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'rss_import_reconciliation_immutable');
END;

CREATE TRIGGER rss_import_reconciled_execution_lock
BEFORE UPDATE ON rss_import_executions
WHEN EXISTS (
  SELECT 1
  FROM rss_import_reconciliations reconciliation
  WHERE reconciliation.execution_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'rss_import_execution_reconciled');
END;

CREATE TRIGGER rss_import_reconciled_item_lock
BEFORE UPDATE ON rss_import_execution_items
WHEN EXISTS (
  SELECT 1
  FROM rss_import_reconciliations reconciliation
  WHERE reconciliation.execution_id = OLD.execution_id
)
BEGIN
  SELECT RAISE(ABORT, 'rss_import_execution_reconciled');
END;
