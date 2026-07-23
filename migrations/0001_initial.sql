PRAGMA foreign_keys = ON;

CREATE TABLE shows (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'coming_soon'
    CHECK (status IN ('coming_soon', 'active', 'archived')),
  artwork_url TEXT,
  canonical_url TEXT NOT NULL,
  rss_slug TEXT NOT NULL UNIQUE,
  youtube_channel_url TEXT,
  premium_enabled INTEGER NOT NULL DEFAULT 0 CHECK (premium_enabled IN (0, 1)),
  early_access_days INTEGER CHECK (early_access_days IS NULL OR early_access_days >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE show_prices (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  billing_period TEXT NOT NULL CHECK (billing_period IN ('month', 'year')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  stripe_price_id TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (show_id, billing_period)
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content_html TEXT NOT NULL DEFAULT '',
  season_number INTEGER,
  episode_number INTEGER,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'published')),
  access TEXT NOT NULL DEFAULT 'public'
    CHECK (access IN ('public', 'early_access', 'premium_bonus', 'free_mini')),
  premium_at TEXT,
  public_at TEXT,
  canonical_url TEXT NOT NULL,
  audio_key TEXT,
  source_audio_key TEXT,
  video_source_key TEXT,
  youtube_video_id TEXT,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  explicit INTEGER NOT NULL DEFAULT 0 CHECK (explicit IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (show_id, slug)
);

CREATE INDEX episodes_show_schedule
  ON episodes(show_id, status, public_at DESC);

CREATE TABLE episode_chapters (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  starts_at_ms INTEGER NOT NULL CHECK (starts_at_ms >= 0),
  title TEXT NOT NULL,
  url TEXT,
  image_url TEXT,
  sort_order INTEGER NOT NULL,
  UNIQUE (episode_id, sort_order)
);

CREATE TABLE listener_accounts (
  id TEXT PRIMARY KEY,
  email_lookup_hash TEXT NOT NULL UNIQUE,
  email_ciphertext TEXT NOT NULL,
  email_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  listener_id TEXT NOT NULL REFERENCES listener_accounts(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  price_id TEXT REFERENCES show_prices(id),
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe', 'pool', 'manual')),
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'active', 'past_due', 'paused', 'canceled', 'expired')),
  current_period_end TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (listener_id, show_id)
);

CREATE TABLE redemption_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'pool',
  duration_days INTEGER CHECK (duration_days IS NULL OR duration_days > 0),
  max_redemptions INTEGER NOT NULL DEFAULT 1 CHECK (max_redemptions > 0),
  redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE redemptions (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES redemption_codes(id) ON DELETE CASCADE,
  listener_id TEXT NOT NULL REFERENCES listener_accounts(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (code_id, listener_id)
);

CREATE TABLE private_feed_tokens (
  id TEXT PRIMARY KEY,
  listener_id TEXT NOT NULL REFERENCES listener_accounts(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX private_feed_tokens_lookup
  ON private_feed_tokens(show_id, token_hash) WHERE revoked_at IS NULL;

CREATE TABLE sponsors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website_url TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ad_campaigns (
  id TEXT PRIMARY KEY,
  sponsor_id TEXT REFERENCES sponsors(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  campaign_type TEXT NOT NULL DEFAULT 'house'
    CHECK (campaign_type IN ('house', 'direct')),
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  impression_cap INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ad_creatives (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  audio_key TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  click_url TEXT,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ad_rules (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  show_id TEXT REFERENCES shows(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  position TEXT CHECK (position IN ('pre', 'mid', 'post')),
  device_type TEXT,
  app_name TEXT,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX ad_campaign_selection
  ON ad_campaigns(active, starts_at, ends_at, priority DESC);
CREATE INDEX ad_rule_selection
  ON ad_rules(show_id, episode_id, position, device_type, app_name);

CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'workers_ai',
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'needs_review', 'approved', 'failed')),
  content_json TEXT NOT NULL DEFAULT '{}',
  edited_html TEXT NOT NULL DEFAULT '',
  alignment_score REAL,
  aligned_word_ratio REAL,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, language)
);

CREATE TABLE transcript_words (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  word TEXT NOT NULL,
  starts_at_ms INTEGER,
  ends_at_ms INTEGER,
  confidence REAL,
  UNIQUE (transcript_id, position)
);

CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at_ms INTEGER NOT NULL CHECK (starts_at_ms >= 0),
  ends_at_ms INTEGER NOT NULL CHECK (ends_at_ms > starts_at_ms),
  aspect_ratio TEXT NOT NULL DEFAULT '9:16'
    CHECK (aspect_ratio IN ('9:16', '1:1', '16:9')),
  caption_html TEXT NOT NULL DEFAULT '',
  output_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'queued', 'rendering', 'ready', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE distribution_jobs (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('rss', 'youtube', 'news', 'email')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  provider_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX distribution_jobs_due
  ON distribution_jobs(status, scheduled_at);

