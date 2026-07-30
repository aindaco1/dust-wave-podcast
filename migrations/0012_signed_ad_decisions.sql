PRAGMA foreign_keys = ON;

ALTER TABLE ad_decisions
  ADD COLUMN inventory_fingerprint TEXT
    CHECK (
      inventory_fingerprint IS NULL
      OR length(inventory_fingerprint) = 64
    );

ALTER TABLE ad_decisions
  ADD COLUMN manifest_sha256 TEXT
    CHECK (
      manifest_sha256 IS NULL
      OR length(manifest_sha256) = 64
    );

ALTER TABLE ad_decisions
  ADD COLUMN signature_version TEXT NOT NULL DEFAULT 'hmac-sha256-v1'
    CHECK (signature_version = 'hmac-sha256-v1');

ALTER TABLE ad_decisions
  ADD COLUMN qualification_expires_at TEXT;

ALTER TABLE ad_decisions
  ADD COLUMN issued_by TEXT NOT NULL DEFAULT 'runtime'
    CHECK (issued_by IN ('runtime', 'staging_admin'));

ALTER TABLE ad_decision_slots
  ADD COLUMN campaign_revision INTEGER
    CHECK (campaign_revision IS NULL OR campaign_revision > 0);

ALTER TABLE ad_decision_slots
  ADD COLUMN creative_object_key TEXT;

ALTER TABLE ad_decision_slots
  ADD COLUMN creative_object_bytes INTEGER
    CHECK (
      creative_object_bytes IS NULL
      OR creative_object_bytes > 0
    );

ALTER TABLE ad_decision_slots
  ADD COLUMN creative_object_etag TEXT;

ALTER TABLE ad_decision_slots
  ADD COLUMN creative_sha256 TEXT
    CHECK (
      creative_sha256 IS NULL
      OR length(creative_sha256) = 64
    );

ALTER TABLE ad_decision_slots
  ADD COLUMN creative_duration_ms INTEGER
    CHECK (
      creative_duration_ms IS NULL
      OR creative_duration_ms > 0
    );

ALTER TABLE ad_decision_slots
  ADD COLUMN stream_profile TEXT;

CREATE UNIQUE INDEX ad_qualification_one_per_slot
  ON ad_impression_qualifications(decision_slot_id)
  WHERE decision_slot_id IS NOT NULL;

CREATE TRIGGER ad_qualification_cap_guard
BEFORE INSERT ON ad_impression_qualifications
WHEN
  NEW.campaign_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM ad_campaigns
    WHERE
      id = NEW.campaign_id
      AND impression_cap IS NOT NULL
      AND qualified_impressions >= impression_cap
  )
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER ad_qualification_counter
AFTER INSERT ON ad_impression_qualifications
WHEN NEW.campaign_id IS NOT NULL
BEGIN
  UPDATE ad_campaigns
  SET
    qualified_impressions = qualified_impressions + 1,
    updated_at = datetime('now')
  WHERE id = NEW.campaign_id;
END;

CREATE VIEW ad_campaign_qualification_reconciliation AS
SELECT
  c.id AS campaign_id,
  c.qualified_impressions AS counter_value,
  COUNT(q.id) AS qualification_rows,
  c.qualified_impressions - COUNT(q.id) AS difference
FROM ad_campaigns c
LEFT JOIN ad_impression_qualifications q
  ON q.campaign_id = c.id
GROUP BY c.id, c.qualified_impressions;
