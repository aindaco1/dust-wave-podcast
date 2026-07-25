PRAGMA foreign_keys = ON;

CREATE TABLE production_reviews (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL
    CHECK (
      target_type IN (
        'source_audio', 'transcript', 'chapters', 'clip', 'ad_plan'
      )
    ),
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
  target_digest TEXT NOT NULL
    CHECK (length(target_digest) BETWEEN 1 AND 256),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (
      status IN (
        'draft', 'ready_for_review', 'changes_requested', 'approved'
      )
    ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  assigned_to_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (
    episode_id, target_type, target_id, target_revision, target_digest
  )
);

CREATE TABLE production_review_comments (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL
    REFERENCES production_reviews(id) ON DELETE CASCADE,
  starts_at_ms INTEGER CHECK (starts_at_ms IS NULL OR starts_at_ms >= 0),
  ends_at_ms INTEGER CHECK (ends_at_ms IS NULL OR ends_at_ms >= 0),
  body_text TEXT NOT NULL CHECK (length(body_text) BETWEEN 1 AND 4000),
  blocker INTEGER NOT NULL DEFAULT 0 CHECK (blocker IN (0, 1)),
  resolution_status TEXT NOT NULL DEFAULT 'open'
    CHECK (resolution_status IN ('open', 'resolved')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  assigned_to_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  resolved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (starts_at_ms IS NULL AND ends_at_ms IS NULL)
    OR (
      starts_at_ms IS NOT NULL
      AND (ends_at_ms IS NULL OR ends_at_ms > starts_at_ms)
    )
  ),
  CHECK (
    (resolution_status = 'open' AND resolved_at IS NULL)
    OR (resolution_status = 'resolved' AND resolved_at IS NOT NULL)
  )
);

CREATE TABLE production_review_mutations (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('review', 'comment')),
  entity_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  target_revision INTEGER NOT NULL CHECK (target_revision = base_revision + 1),
  payload_sha256 TEXT NOT NULL
    CHECK (
      length(payload_sha256) = 64
      AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, entity_id, base_revision)
);

CREATE INDEX production_reviews_episode
  ON production_reviews(episode_id, updated_at DESC, id DESC);

CREATE INDEX production_reviews_readiness
  ON production_reviews(episode_id, status, updated_at DESC);

CREATE INDEX production_review_comments_review
  ON production_review_comments(review_id, created_at, id);

CREATE INDEX production_review_comments_open_blockers
  ON production_review_comments(review_id, blocker, resolution_status)
  WHERE blocker = 1 AND resolution_status = 'open';
