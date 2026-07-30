CREATE TABLE show_feed_validations (
  show_id TEXT PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('valid', 'failed')),
  feed_url TEXT NOT NULL
    CHECK (
      length(feed_url) BETWEEN 8 AND 2048
      AND substr(feed_url, 1, 8) = 'https://'
      AND instr(feed_url, '#') = 0
    ),
  validator_version TEXT NOT NULL
    CHECK (length(validator_version) BETWEEN 1 AND 64),
  feed_sha256 TEXT
    CHECK (
      feed_sha256 IS NULL
      OR (
        length(feed_sha256) = 64
        AND feed_sha256 NOT GLOB '*[^a-f0-9]*'
      )
    ),
  item_count INTEGER CHECK (item_count IS NULL OR item_count >= 0),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR length(failure_code) BETWEEN 1 AND 160
    ),
  checked_at TEXT NOT NULL,
  validated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (
      status = 'valid'
      AND feed_sha256 IS NOT NULL
      AND item_count IS NOT NULL
      AND failure_code IS NULL
      AND validated_at IS NOT NULL
    )
    OR (
      status = 'failed'
      AND feed_sha256 IS NULL
      AND item_count IS NULL
      AND failure_code IS NOT NULL
      AND validated_at IS NULL
    )
  )
);

CREATE TABLE distribution_observation_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE
    CHECK (length(id) BETWEEN 1 AND 160),
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL
    REFERENCES distribution_destinations(id) ON DELETE CASCADE,
  publication_revision INTEGER NOT NULL CHECK (publication_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('observed', 'failed')),
  evidence_url TEXT
    CHECK (
      evidence_url IS NULL
      OR (
        length(evidence_url) BETWEEN 8 AND 2048
        AND substr(evidence_url, 1, 8) = 'https://'
        AND instr(evidence_url, '#') = 0
      )
    ),
  failure_detail TEXT
    CHECK (
      failure_detail IS NULL
      OR length(failure_detail) BETWEEN 1 AND 500
    ),
  evidence_source TEXT NOT NULL
    CHECK (
      evidence_source IN (
        'manual_review',
        'provider_dashboard',
        'automated_probe'
      )
    ),
  evidence_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (
      status = 'observed'
      AND evidence_url IS NOT NULL
      AND failure_detail IS NULL
    )
    OR (
      status = 'failed'
      AND failure_detail IS NOT NULL
    )
  )
);

INSERT INTO distribution_observation_events (
  id,
  show_id,
  episode_id,
  destination_id,
  publication_revision,
  status,
  evidence_url,
  failure_detail,
  evidence_source,
  evidence_admin_user_id,
  recorded_at
)
SELECT
  'history_' || publication.id,
  episode.show_id,
  publication.episode_id,
  publication.destination_id,
  publication.publication_revision,
  publication.status,
  publication.evidence_url,
  CASE
    WHEN publication.status = 'failed'
      THEN COALESCE(publication.last_error, 'historical_failure')
    ELSE NULL
  END,
  COALESCE(publication.evidence_source, 'manual_review'),
  publication.evidence_admin_user_id,
  COALESCE(publication.last_observed_at, publication.updated_at)
FROM episode_publications publication
JOIN episodes episode ON episode.id = publication.episode_id
WHERE publication.status IN ('observed', 'failed')
  AND (
    publication.status = 'failed'
    OR publication.evidence_url IS NOT NULL
  );

CREATE INDEX distribution_observation_events_show_destination
  ON distribution_observation_events(
    show_id,
    destination_id,
    status,
    sequence
  );

CREATE INDEX distribution_observation_events_episode
  ON distribution_observation_events(
    episode_id,
    publication_revision,
    destination_id,
    sequence
  );

CREATE TRIGGER distribution_observation_events_immutable
BEFORE UPDATE ON distribution_observation_events
BEGIN
  SELECT RAISE(
    ABORT,
    'distribution_observation_events_immutable'
  );
END;

CREATE TRIGGER publication_evidence_feed_validation_insert
AFTER INSERT ON show_feed_validations
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = NEW.show_id;
END;

CREATE TRIGGER publication_evidence_feed_validation_update
AFTER UPDATE ON show_feed_validations
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = NEW.show_id;
END;

CREATE TRIGGER publication_evidence_feed_validation_delete
AFTER DELETE ON show_feed_validations
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = OLD.show_id;
END;

CREATE TRIGGER publication_evidence_distribution_observation_insert
AFTER INSERT ON distribution_observation_events
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = NEW.show_id;
END;

CREATE TRIGGER publication_evidence_distribution_observation_delete
AFTER DELETE ON distribution_observation_events
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = OLD.show_id;
END;
