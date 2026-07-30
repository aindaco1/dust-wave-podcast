PRAGMA foreign_keys = ON;

CREATE TABLE podcast_analytics_uniques (
  unique_key TEXT PRIMARY KEY CHECK (length(unique_key) = 64),
  methodology_version TEXT NOT NULL
    CHECK (methodology_version = 'dustwave-analytics-v1'),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('qualified_download', 'engaged_play')),
  window_date TEXT NOT NULL
    CHECK (
      length(window_date) = 10
      AND window_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  app_code TEXT NOT NULL DEFAULT 'other' CHECK (length(app_code) <= 40),
  device_code TEXT NOT NULL DEFAULT 'other' CHECK (length(device_code) <= 40),
  country_code TEXT NOT NULL DEFAULT 'ZZ'
    CHECK (country_code GLOB '[A-Z][A-Z]'),
  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  expires_at TEXT NOT NULL
);

CREATE INDEX podcast_analytics_uniques_expiry
  ON podcast_analytics_uniques(expires_at);

CREATE INDEX podcast_analytics_uniques_show_date
  ON podcast_analytics_uniques(show_id, window_date DESC, event_type);

CREATE TABLE podcast_analytics_rollups (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  methodology_version TEXT NOT NULL
    CHECK (methodology_version = 'dustwave-analytics-v1'),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('qualified_download', 'engaged_play')),
  window_date TEXT NOT NULL
    CHECK (
      length(window_date) = 10
      AND window_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  app_code TEXT NOT NULL DEFAULT 'other' CHECK (length(app_code) <= 40),
  device_code TEXT NOT NULL DEFAULT 'other' CHECK (length(device_code) <= 40),
  country_code TEXT NOT NULL DEFAULT 'ZZ'
    CHECK (country_code GLOB '[A-Z][A-Z]'),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count > 0),
  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  updated_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  UNIQUE (
    methodology_version, event_type, window_date, show_id, episode_id,
    app_code, device_code, country_code
  )
);

CREATE INDEX podcast_analytics_rollups_show_date
  ON podcast_analytics_rollups(show_id, window_date DESC, event_type);

