PRAGMA foreign_keys = ON;

ALTER TABLE shows
  ADD COLUMN dynamic_ads_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (dynamic_ads_enabled IN (0, 1));

ALTER TABLE episodes
  ADD COLUMN dynamic_ads_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (dynamic_ads_enabled IN (0, 1));

ALTER TABLE ad_campaigns
  ADD COLUMN billing_model TEXT NOT NULL DEFAULT 'flat_fee'
    CHECK (billing_model IN ('flat_fee', 'cpm'));

ALTER TABLE ad_campaigns
  ADD COLUMN contract_amount_cents INTEGER
    CHECK (contract_amount_cents IS NULL OR contract_amount_cents >= 0);

ALTER TABLE ad_campaigns
  ADD COLUMN cpm_cents INTEGER
    CHECK (cpm_cents IS NULL OR cpm_cents >= 0);

ALTER TABLE ad_campaigns
  ADD COLUMN qualified_impression_goal INTEGER
    CHECK (
      qualified_impression_goal IS NULL
      OR qualified_impression_goal > 0
    );

ALTER TABLE ad_campaigns
  ADD COLUMN qualified_impressions INTEGER NOT NULL DEFAULT 0
    CHECK (qualified_impressions >= 0);

ALTER TABLE ad_campaigns
  ADD COLUMN pacing_strategy TEXT NOT NULL DEFAULT 'even'
    CHECK (pacing_strategy IN ('even', 'asap', 'manual'));

ALTER TABLE ad_campaigns
  ADD COLUMN kill_switch_at TEXT;

ALTER TABLE ad_creatives
  ADD COLUMN audio_bytes INTEGER
    CHECK (audio_bytes IS NULL OR audio_bytes > 0);

ALTER TABLE ad_creatives
  ADD COLUMN audio_mime_type TEXT;

ALTER TABLE ad_creatives
  ADD COLUMN audio_etag TEXT;

ALTER TABLE ad_creatives
  ADD COLUMN stream_profile TEXT;

ALTER TABLE ad_creatives
  ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      validation_status IN ('pending', 'validating', 'ready', 'failed', 'revoked')
    );

ALTER TABLE ad_creatives
  ADD COLUMN validated_at TEXT;

CREATE TABLE episode_ad_markers (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  position TEXT NOT NULL CHECK (position IN ('pre', 'mid', 'post')),
  starts_at_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (position = 'mid' AND starts_at_ms IS NOT NULL AND starts_at_ms > 0)
    OR (position IN ('pre', 'post') AND starts_at_ms IS NULL)
  ),
  UNIQUE (episode_id, position)
);

CREATE INDEX episode_ad_markers_enabled
  ON episode_ad_markers(episode_id, enabled, position);

CREATE TABLE episode_audio_segments (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  object_key TEXT NOT NULL,
  object_bytes INTEGER NOT NULL CHECK (object_bytes > 0),
  source_offset INTEGER NOT NULL DEFAULT 0 CHECK (source_offset >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  audio_mime_type TEXT NOT NULL
    CHECK (audio_mime_type IN ('audio/mpeg', 'audio/mp4')),
  stream_profile TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      validation_status IN ('pending', 'validating', 'ready', 'failed', 'revoked')
    ),
  validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source_offset + byte_length <= object_bytes),
  UNIQUE (episode_id, sequence)
);

CREATE INDEX episode_audio_segments_ready
  ON episode_audio_segments(episode_id, validation_status, sequence);

CREATE TABLE ad_decisions (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  publication_revision INTEGER NOT NULL CHECK (publication_revision >= 0),
  request_key_hash TEXT NOT NULL,
  privacy_epoch TEXT NOT NULL,
  decision_epoch TEXT NOT NULL,
  device_type TEXT NOT NULL,
  app_name TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('selected', 'fallback', 'expired', 'revoked')),
  fallback_reason TEXT,
  selection_context_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(selection_context_json)),
  manifest_json TEXT CHECK (
    manifest_json IS NULL OR json_valid(manifest_json)
  ),
  manifest_etag TEXT,
  total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes > 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, publication_revision, request_key_hash)
);

CREATE INDEX ad_decisions_token_lookup
  ON ad_decisions(id, status, expires_at);

CREATE INDEX ad_decisions_episode_history
  ON ad_decisions(episode_id, created_at DESC);

CREATE TABLE ad_decision_slots (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES ad_decisions(id) ON DELETE CASCADE,
  marker_id TEXT REFERENCES episode_ad_markers(id) ON DELETE SET NULL,
  position TEXT NOT NULL CHECK (position IN ('pre', 'mid', 'post')),
  campaign_id TEXT REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  creative_id TEXT REFERENCES ad_creatives(id) ON DELETE SET NULL,
  selection_reason_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(selection_reason_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (decision_id, position)
);

CREATE INDEX ad_decision_slots_campaign
  ON ad_decision_slots(campaign_id, creative_id, created_at);

CREATE TABLE ad_impression_qualifications (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES ad_decisions(id) ON DELETE CASCADE,
  decision_slot_id TEXT
    REFERENCES ad_decision_slots(id) ON DELETE SET NULL,
  campaign_id TEXT REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  creative_id TEXT REFERENCES ad_creatives(id) ON DELETE SET NULL,
  qualification_key TEXT NOT NULL UNIQUE,
  qualification_reason TEXT NOT NULL
    CHECK (
      qualification_reason IN (
        'download_complete', 'listen_threshold', 'operator_adjustment'
      )
    ),
  bytes_served INTEGER CHECK (bytes_served IS NULL OR bytes_served >= 0),
  listened_ms INTEGER CHECK (listened_ms IS NULL OR listened_ms >= 0),
  qualified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX ad_impression_qualifications_campaign
  ON ad_impression_qualifications(campaign_id, qualified_at);

CREATE INDEX ad_campaign_pacing
  ON ad_campaigns(
    active, kill_switch_at, starts_at, ends_at, priority DESC,
    qualified_impressions
  );
