ALTER TABLE shows ADD COLUMN description_en TEXT NOT NULL DEFAULT '';
ALTER TABLE shows ADD COLUMN author_name TEXT NOT NULL DEFAULT 'Dust Wave';
ALTER TABLE shows ADD COLUMN category TEXT NOT NULL DEFAULT 'Arts';
ALTER TABLE shows ADD COLUMN explicit INTEGER NOT NULL DEFAULT 0
  CHECK (explicit IN (0, 1));

ALTER TABLE episodes ADD COLUMN guid TEXT;
ALTER TABLE episodes ADD COLUMN audio_mime_type TEXT;
ALTER TABLE episodes ADD COLUMN audio_bytes INTEGER
  CHECK (audio_bytes IS NULL OR audio_bytes >= 0);
ALTER TABLE episodes ADD COLUMN audio_etag TEXT;
ALTER TABLE episodes ADD COLUMN audio_filename TEXT;
ALTER TABLE episodes ADD COLUMN media_status TEXT NOT NULL DEFAULT 'missing'
  CHECK (media_status IN ('missing', 'uploading', 'processing', 'ready', 'failed'));
ALTER TABLE episodes ADD COLUMN publication_revision INTEGER NOT NULL DEFAULT 0
  CHECK (publication_revision >= 0);

CREATE UNIQUE INDEX episodes_guid_unique
  ON episodes(guid)
  WHERE guid IS NOT NULL;

CREATE TABLE admin_login_tokens (
  token_hash TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX admin_login_tokens_expiry
  ON admin_login_tokens(expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX admin_sessions_user
  ON admin_sessions(admin_user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE admin_audit_events (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX admin_audit_events_target
  ON admin_audit_events(target_type, target_id, occurred_at DESC);

CREATE TABLE media_uploads (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('source_audio', 'delivery_audio', 'video_source', 'artwork', 'transcript')),
  object_key TEXT NOT NULL UNIQUE,
  r2_upload_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'completing', 'completed', 'aborted', 'failed')),
  completed_bytes INTEGER,
  object_etag TEXT,
  initiated_by_admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX media_uploads_episode
  ON media_uploads(episode_id, status, created_at DESC);

CREATE TABLE media_upload_parts (
  upload_id TEXT NOT NULL REFERENCES media_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  uploaded_bytes INTEGER NOT NULL CHECK (uploaded_bytes > 0),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE distribution_destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL
    CHECK (mode IN ('rss_directory', 'direct_api')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  owner_setup_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (owner_setup_status IN ('not_started', 'pending', 'verified', 'not_required')),
  submission_url TEXT,
  display_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO distribution_destinations (
  id, name, mode, owner_setup_status, submission_url, display_order
) VALUES
  ('spotify', 'Spotify', 'rss_directory', 'not_started', 'https://podcasters.spotify.com/', 10),
  ('apple_podcasts', 'Apple Podcasts', 'rss_directory', 'not_started', 'https://podcastsconnect.apple.com/', 20),
  ('youtube_music', 'YouTube Music', 'rss_directory', 'not_started', 'https://studio.youtube.com/', 30),
  ('amazon_music', 'Amazon Music and Audible', 'rss_directory', 'not_started', 'https://podcasters.amazon.com/', 40),
  ('pocket_casts', 'Pocket Casts', 'rss_directory', 'not_started', 'https://pocketcasts.com/submit/', 50),
  ('overcast', 'Overcast', 'rss_directory', 'not_started', 'https://overcast.fm/add', 60),
  ('castbox', 'Castbox', 'rss_directory', 'not_started', 'https://castbox.fm/podcasters', 70),
  ('podcast_addict', 'Podcast Addict', 'rss_directory', 'not_started', 'https://podcastaddict.com/submit', 80),
  ('player_fm', 'Player FM', 'rss_directory', 'not_started', 'https://player.fm/importer/new', 90),
  ('iheartradio', 'iHeartRadio', 'rss_directory', 'not_started', 'https://podcasters.iheart.com/', 100),
  ('deezer', 'Deezer', 'rss_directory', 'not_started', 'https://podcasters.deezer.com/', 110);

CREATE TABLE episode_publications (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES distribution_destinations(id) ON DELETE CASCADE,
  publication_revision INTEGER NOT NULL CHECK (publication_revision > 0),
  status TEXT NOT NULL
    CHECK (status IN ('setup_required', 'waiting_for_feed', 'queued', 'processing', 'observed', 'failed', 'disabled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_id TEXT,
  last_observed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, destination_id, publication_revision)
);

CREATE INDEX episode_publications_status
  ON episode_publications(status, destination_id, updated_at);

CREATE TABLE site_publications (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  publication_revision INTEGER NOT NULL CHECK (publication_revision >= 0),
  canonical_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  github_commit_sha TEXT,
  github_run_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

UPDATE shows
SET
  description = 'Belleza y alegría. Y un poco de tecnología de vez en cuando.',
  description_en = 'Beauty and joy. And a bit of tech from time to time.',
  author_name = 'Dust Wave',
  updated_at = datetime('now')
WHERE id = 'show_opera_en_la_selva';
