PRAGMA foreign_keys = ON;

CREATE TABLE podcast_marketing_links (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
  utm_source TEXT NOT NULL DEFAULT '' CHECK (length(utm_source) <= 160),
  utm_medium TEXT NOT NULL DEFAULT '' CHECK (length(utm_medium) <= 160),
  utm_campaign TEXT NOT NULL DEFAULT '' CHECK (length(utm_campaign) <= 160),
  utm_content TEXT NOT NULL DEFAULT '' CHECK (length(utm_content) <= 160),
  referral_code TEXT NOT NULL DEFAULT '' CHECK (length(referral_code) <= 64),
  tagged_url TEXT NOT NULL CHECK (length(tagged_url) BETWEEN 1 AND 2048),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_admin_user_id TEXT NOT NULL
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  updated_by_admin_user_id TEXT NOT NULL
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  updated_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  UNIQUE (show_id, code)
);

CREATE INDEX podcast_marketing_links_show_recent
  ON podcast_marketing_links(show_id, updated_at DESC, id DESC);

