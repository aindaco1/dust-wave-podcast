PRAGMA foreign_keys = ON;

ALTER TABLE ad_decision_slots
  ADD COLUMN fallback_campaign_id TEXT
    REFERENCES ad_campaigns(id) ON DELETE SET NULL;

ALTER TABLE ad_decision_slots
  ADD COLUMN fallback_creative_id TEXT
    REFERENCES ad_creatives(id) ON DELETE SET NULL;

ALTER TABLE ad_decision_slots
  ADD COLUMN fallback_object_key TEXT;

ALTER TABLE ad_decision_slots
  ADD COLUMN fallback_object_bytes INTEGER
    CHECK (
      fallback_object_bytes IS NULL
      OR fallback_object_bytes > 0
    );

ALTER TABLE ad_decision_slots
  ADD COLUMN fallback_object_etag TEXT;

ALTER TABLE ad_decision_slots
  ADD COLUMN fallback_sha256 TEXT
    CHECK (
      fallback_sha256 IS NULL
      OR length(fallback_sha256) = 64
    );

ALTER TABLE ad_decision_slots
  ADD COLUMN fallback_duration_ms INTEGER
    CHECK (
      fallback_duration_ms IS NULL
      OR fallback_duration_ms > 0
    );

ALTER TABLE ad_decision_slots
  ADD COLUMN fallback_stream_profile TEXT;

CREATE INDEX ad_decision_slots_fallback_campaign
  ON ad_decision_slots(
    fallback_campaign_id, fallback_creative_id, created_at
  );
