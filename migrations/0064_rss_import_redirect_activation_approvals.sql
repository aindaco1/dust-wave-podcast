PRAGMA foreign_keys = ON;

CREATE TABLE rss_import_redirect_activation_approvals (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) BETWEEN 1 AND 160
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  cutover_packet_id TEXT NOT NULL UNIQUE
    REFERENCES rss_import_cutover_packets(id) ON DELETE RESTRICT,
  redirect_attestation_id TEXT NOT NULL
    REFERENCES rss_import_redirect_attestations(id) ON DELETE RESTRICT,
  reconciliation_id TEXT NOT NULL
    REFERENCES rss_import_reconciliations(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL
    REFERENCES rss_import_executions(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL
    REFERENCES rss_import_plans(id) ON DELETE RESTRICT,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  cutover_evidence_sha256 TEXT NOT NULL
    CHECK (
      length(cutover_evidence_sha256) = 64
      AND cutover_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
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
  show_evidence_version INTEGER NOT NULL
    CHECK (show_evidence_version >= 0),
  episode_evidence_version_total INTEGER NOT NULL
    CHECK (episode_evidence_version_total >= 0),
  final_review_confirmed INTEGER NOT NULL
    CHECK (final_review_confirmed = 1),
  manual_action_acknowledged INTEGER NOT NULL
    CHECK (manual_action_acknowledged = 1),
  rollback_plan_confirmed INTEGER NOT NULL
    CHECK (rollback_plan_confirmed = 1),
  no_activation_performed_confirmed INTEGER NOT NULL
    CHECK (no_activation_performed_confirmed = 1),
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (execution_id, cutover_evidence_sha256)
);

CREATE INDEX rss_import_redirect_activation_approvals_show_approved
  ON rss_import_redirect_activation_approvals(
    show_id,
    approved_at DESC,
    id DESC
  );

CREATE TRIGGER rss_import_redirect_activation_approval_evidence_guard
BEFORE INSERT ON rss_import_redirect_activation_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM rss_import_cutover_packets packet
  JOIN rss_import_redirect_attestations attestation
    ON attestation.id = packet.redirect_attestation_id
   AND attestation.reconciliation_id = packet.reconciliation_id
   AND attestation.execution_id = packet.execution_id
  WHERE packet.id = NEW.cutover_packet_id
    AND packet.redirect_attestation_id = NEW.redirect_attestation_id
    AND packet.reconciliation_id = NEW.reconciliation_id
    AND packet.execution_id = NEW.execution_id
    AND packet.plan_id = NEW.plan_id
    AND packet.show_id = NEW.show_id
    AND packet.evidence_sha256 = NEW.cutover_evidence_sha256
    AND packet.reconciliation_evidence_sha256 =
      NEW.reconciliation_evidence_sha256
    AND packet.show_evidence_version = NEW.show_evidence_version
    AND packet.episode_evidence_version_total =
      NEW.episode_evidence_version_total
    AND packet.owner_review_confirmed = 1
    AND packet.no_activation_confirmed = 1
    AND attestation.old_feed_url_sha256 = NEW.old_feed_url_sha256
    AND attestation.new_feed_url_sha256 = NEW.new_feed_url_sha256
    AND attestation.redirect_method = NEW.redirect_method
    AND attestation.owner_control_confirmed = 1
    AND attestation.permanence_acknowledged = 1
    AND attestation.no_activation_confirmed = 1
)
BEGIN
  SELECT RAISE(
    ABORT,
    'rss_import_redirect_activation_approval_evidence_mismatch'
  );
END;

CREATE TRIGGER rss_import_redirect_activation_approvals_immutable_update
BEFORE UPDATE ON rss_import_redirect_activation_approvals
BEGIN
  SELECT RAISE(
    ABORT,
    'rss_import_redirect_activation_approval_immutable'
  );
END;

CREATE TRIGGER rss_import_redirect_activation_approvals_immutable_delete
BEFORE DELETE ON rss_import_redirect_activation_approvals
BEGIN
  SELECT RAISE(
    ABORT,
    'rss_import_redirect_activation_approval_immutable'
  );
END;
