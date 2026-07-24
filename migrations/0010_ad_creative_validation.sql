PRAGMA foreign_keys = ON;

ALTER TABLE ad_creatives
  ADD COLUMN duration_ms INTEGER
    CHECK (duration_ms IS NULL OR duration_ms > 0);

ALTER TABLE ad_creatives
  ADD COLUMN sha256 TEXT
    CHECK (sha256 IS NULL OR length(sha256) = 64);

ALTER TABLE ad_creatives
  ADD COLUMN validation_report_json TEXT
    CHECK (
      validation_report_json IS NULL
      OR json_valid(validation_report_json)
    );

ALTER TABLE ad_creatives
  ADD COLUMN uploaded_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE ad_creatives
  ADD COLUMN validated_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE ad_creatives
  ADD COLUMN uploaded_at TEXT;

CREATE INDEX ad_creatives_validation
  ON ad_creatives(campaign_id, validation_status, active, stream_profile);
