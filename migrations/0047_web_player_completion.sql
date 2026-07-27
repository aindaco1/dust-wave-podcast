PRAGMA foreign_keys = ON;

CREATE TABLE podcast_analytics_progress_uniques (
  unique_key TEXT PRIMARY KEY CHECK (length(unique_key) = 64),
  methodology_version TEXT NOT NULL
    CHECK (methodology_version = 'dustwave-analytics-v1'),
  window_date TEXT NOT NULL
    CHECK (
      length(window_date) = 10
      AND window_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  milestone_percent INTEGER NOT NULL
    CHECK (milestone_percent IN (25, 50, 75, 100)),
  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  expires_at TEXT NOT NULL
);

CREATE INDEX podcast_analytics_progress_uniques_expiry
  ON podcast_analytics_progress_uniques(expires_at);

CREATE INDEX podcast_analytics_progress_uniques_show_date
  ON podcast_analytics_progress_uniques(
    show_id, window_date DESC, milestone_percent
  );

CREATE TABLE podcast_analytics_progress_rollups (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  methodology_version TEXT NOT NULL
    CHECK (methodology_version = 'dustwave-analytics-v1'),
  window_date TEXT NOT NULL
    CHECK (
      length(window_date) = 10
      AND window_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  milestone_percent INTEGER NOT NULL
    CHECK (milestone_percent IN (25, 50, 75, 100)),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count > 0),
  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  updated_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  UNIQUE (
    methodology_version, window_date, show_id, episode_id,
    milestone_percent
  )
);

CREATE INDEX podcast_analytics_progress_rollups_show_date
  ON podcast_analytics_progress_rollups(
    show_id, window_date DESC, milestone_percent
  );
