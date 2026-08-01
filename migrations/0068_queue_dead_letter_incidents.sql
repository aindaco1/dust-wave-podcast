PRAGMA foreign_keys = ON;

-- Persist content-free terminal Queue evidence beyond the staging DLQ's
-- retention window. Raw Queue bodies, provider responses, URLs, and secrets
-- are never stored here.
CREATE TABLE queue_dead_letter_incidents (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 100),
  payload_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(payload_sha256) = 64
      AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  source_queue TEXT NOT NULL CHECK (length(source_queue) BETWEEN 1 AND 120),
  dead_letter_queue TEXT NOT NULL
    CHECK (length(dead_letter_queue) BETWEEN 1 AND 120),
  classification TEXT NOT NULL
    CHECK (classification IN ('podcast_job', 'malformed')),
  job_id TEXT CHECK (job_id IS NULL OR length(job_id) BETWEEN 1 AND 160),
  job_type TEXT CHECK (
    job_type IS NULL
    OR job_type IN (
      'transcribe',
      'align-transcript',
      'render-clip',
      'publish-news',
      'publish-rss',
      'publish-youtube',
      'publish-youtube-clip',
      'execute-rss-import-item',
      'send-premium-notification',
      'send-announcement'
    )
  ),
  show_id TEXT CHECK (show_id IS NULL OR length(show_id) BETWEEN 1 AND 160),
  episode_id TEXT
    CHECK (episode_id IS NULL OR length(episode_id) BETWEEN 1 AND 160),
  publication_revision INTEGER
    CHECK (publication_revision IS NULL OR publication_revision >= 0),
  failure_code TEXT NOT NULL
    CHECK (
      failure_code IN (
        'queue_delivery_attempts_exhausted',
        'malformed_queue_job'
      )
    ),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved')),
  exhausted_after_retries INTEGER NOT NULL DEFAULT 3
    CHECK (exhausted_after_retries = 3),
  occurrence_count INTEGER NOT NULL DEFAULT 1
    CHECK (occurrence_count > 0),
  last_dlq_delivery_attempt INTEGER NOT NULL
    CHECK (last_dlq_delivery_attempt > 0),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  CHECK (
    (classification = 'podcast_job' AND job_id IS NOT NULL AND job_type IS NOT NULL)
    OR (classification = 'malformed' AND job_id IS NULL AND job_type IS NULL)
  ),
  CHECK (
    (status = 'open' AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX queue_dead_letter_incidents_open
  ON queue_dead_letter_incidents(status, last_seen_at DESC);

CREATE INDEX queue_dead_letter_incidents_show
  ON queue_dead_letter_incidents(show_id, status, last_seen_at DESC)
  WHERE show_id IS NOT NULL;

CREATE INDEX queue_dead_letter_incidents_episode
  ON queue_dead_letter_incidents(episode_id, status, last_seen_at DESC)
  WHERE episode_id IS NOT NULL;
