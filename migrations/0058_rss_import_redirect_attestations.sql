PRAGMA foreign_keys = ON;

CREATE TABLE rss_import_redirect_attestations (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) BETWEEN 1 AND 160
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  reconciliation_id TEXT NOT NULL
    REFERENCES rss_import_reconciliations(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL
    REFERENCES rss_import_executions(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL
    REFERENCES rss_import_plans(id) ON DELETE RESTRICT,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  reconciliation_evidence_sha256 TEXT NOT NULL
    CHECK (
      length(reconciliation_evidence_sha256) = 64
      AND reconciliation_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  old_feed_url_sha256 TEXT NOT NULL
    CHECK (
      length(old_feed_url_sha256) = 64
      AND old_feed_url_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  new_feed_url_sha256 TEXT NOT NULL
    CHECK (
      length(new_feed_url_sha256) = 64
      AND new_feed_url_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  redirect_method TEXT NOT NULL
    CHECK (
      redirect_method IN (
        'provider_managed_redirect',
        'self_managed_http_301'
      )
    ),
  owner_control_confirmed INTEGER NOT NULL CHECK (owner_control_confirmed = 1),
  permanence_acknowledged INTEGER NOT NULL CHECK (permanence_acknowledged = 1),
  no_activation_confirmed INTEGER NOT NULL CHECK (no_activation_confirmed = 1),
  attested_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  attested_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (
    execution_id,
    reconciliation_evidence_sha256,
    old_feed_url_sha256,
    new_feed_url_sha256,
    redirect_method
  )
);

CREATE INDEX rss_import_redirect_attestations_show_attested
  ON rss_import_redirect_attestations(
    show_id,
    attested_at DESC,
    id DESC
  );

CREATE TRIGGER rss_import_redirect_attestation_evidence_guard
BEFORE INSERT ON rss_import_redirect_attestations
WHEN NOT EXISTS (
  SELECT 1
  FROM rss_import_reconciliations reconciliation
  JOIN rss_import_executions execution
    ON execution.id = reconciliation.execution_id
  JOIN rss_import_plans plan
    ON plan.id = execution.plan_id
  WHERE reconciliation.id = NEW.reconciliation_id
    AND reconciliation.execution_id = NEW.execution_id
    AND reconciliation.plan_id = NEW.plan_id
    AND reconciliation.show_id = NEW.show_id
    AND reconciliation.evidence_sha256 =
      NEW.reconciliation_evidence_sha256
    AND execution.id = NEW.execution_id
    AND execution.plan_id = NEW.plan_id
    AND execution.show_id = NEW.show_id
    AND execution.feed_url_sha256 = NEW.old_feed_url_sha256
    AND plan.id = NEW.plan_id
    AND plan.show_id = NEW.show_id
    AND plan.requested_feed_url_sha256 = NEW.old_feed_url_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'rss_import_redirect_attestation_evidence_mismatch');
END;

CREATE TRIGGER rss_import_redirect_attestations_immutable_update
BEFORE UPDATE ON rss_import_redirect_attestations
BEGIN
  SELECT RAISE(ABORT, 'rss_import_redirect_attestation_immutable');
END;

CREATE TRIGGER rss_import_redirect_attestations_immutable_delete
BEFORE DELETE ON rss_import_redirect_attestations
BEGIN
  SELECT RAISE(ABORT, 'rss_import_redirect_attestation_immutable');
END;
