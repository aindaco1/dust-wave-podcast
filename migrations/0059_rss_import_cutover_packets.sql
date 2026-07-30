PRAGMA foreign_keys = ON;

CREATE TABLE rss_import_cutover_packets (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) BETWEEN 1 AND 160
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  reconciliation_id TEXT NOT NULL
    REFERENCES rss_import_reconciliations(id) ON DELETE RESTRICT,
  redirect_attestation_id TEXT NOT NULL
    REFERENCES rss_import_redirect_attestations(id) ON DELETE RESTRICT,
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
  imported_episode_state_sha256 TEXT NOT NULL
    CHECK (
      length(imported_episode_state_sha256) = 64
      AND imported_episode_state_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  feed_validation_evidence_sha256 TEXT NOT NULL
    CHECK (
      length(feed_validation_evidence_sha256) = 64
      AND feed_validation_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  directory_evidence_sha256 TEXT NOT NULL
    CHECK (
      length(directory_evidence_sha256) = 64
      AND directory_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  evidence_sha256 TEXT NOT NULL
    CHECK (
      length(evidence_sha256) = 64
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  imported_episode_count INTEGER NOT NULL
    CHECK (imported_episode_count BETWEEN 1 AND 25),
  public_episode_count INTEGER NOT NULL
    CHECK (public_episode_count = imported_episode_count),
  certified_destination_count INTEGER NOT NULL
    CHECK (certified_destination_count >= 10),
  reobserved_destination_count INTEGER NOT NULL
    CHECK (reobserved_destination_count >= 10),
  feed_item_count INTEGER NOT NULL CHECK (feed_item_count >= 0),
  expected_feed_item_count INTEGER NOT NULL
    CHECK (
      expected_feed_item_count >= imported_episode_count
      AND feed_item_count = expected_feed_item_count
    ),
  feed_validated_at TEXT NOT NULL,
  show_evidence_version INTEGER NOT NULL CHECK (show_evidence_version >= 0),
  episode_evidence_version_total INTEGER NOT NULL
    CHECK (episode_evidence_version_total >= 0),
  owner_review_confirmed INTEGER NOT NULL CHECK (owner_review_confirmed = 1),
  no_activation_confirmed INTEGER NOT NULL CHECK (no_activation_confirmed = 1),
  prepared_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  prepared_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (execution_id, evidence_sha256)
);

CREATE INDEX rss_import_cutover_packets_show_prepared
  ON rss_import_cutover_packets(
    show_id,
    prepared_at DESC,
    id DESC
  );

CREATE TRIGGER rss_import_cutover_packet_evidence_guard
BEFORE INSERT ON rss_import_cutover_packets
WHEN NOT EXISTS (
  SELECT 1
  FROM rss_import_reconciliations reconciliation
  JOIN rss_import_executions execution
    ON execution.id = reconciliation.execution_id
  JOIN rss_import_redirect_attestations attestation
    ON attestation.reconciliation_id = reconciliation.id
   AND attestation.execution_id = execution.id
  WHERE reconciliation.id = NEW.reconciliation_id
    AND reconciliation.execution_id = NEW.execution_id
    AND reconciliation.plan_id = NEW.plan_id
    AND reconciliation.show_id = NEW.show_id
    AND reconciliation.evidence_sha256 =
      NEW.reconciliation_evidence_sha256
    AND attestation.id = NEW.redirect_attestation_id
    AND attestation.plan_id = NEW.plan_id
    AND attestation.show_id = NEW.show_id
    AND attestation.reconciliation_evidence_sha256 =
      NEW.reconciliation_evidence_sha256
    AND attestation.owner_control_confirmed = 1
    AND attestation.permanence_acknowledged = 1
    AND attestation.no_activation_confirmed = 1
)
BEGIN
  SELECT RAISE(ABORT, 'rss_import_cutover_packet_evidence_mismatch');
END;

CREATE TRIGGER rss_import_cutover_packets_immutable_update
BEFORE UPDATE ON rss_import_cutover_packets
BEGIN
  SELECT RAISE(ABORT, 'rss_import_cutover_packet_immutable');
END;

CREATE TRIGGER rss_import_cutover_packets_immutable_delete
BEFORE DELETE ON rss_import_cutover_packets
BEGIN
  SELECT RAISE(ABORT, 'rss_import_cutover_packet_immutable');
END;
