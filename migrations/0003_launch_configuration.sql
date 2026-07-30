ALTER TABLE shows
  ADD COLUMN free_mini_episode_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (free_mini_episode_enabled IN (0, 1));

CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  email_lookup_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'suspended', 'revoked')),
  invited_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  last_authenticated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE admin_user_roles (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('super_admin', 'admin', 'producer', 'analyst')),
  show_id TEXT REFERENCES shows(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by_admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  CHECK (
    (role = 'super_admin' AND show_id IS NULL)
    OR role != 'super_admin'
  )
);

CREATE UNIQUE INDEX admin_user_roles_unique
  ON admin_user_roles(admin_user_id, role, COALESCE(show_id, '*'));
CREATE INDEX admin_user_roles_scope
  ON admin_user_roles(show_id, role);

UPDATE shows
SET
  description = 'Belleza y alegría. Y un poco de tecnología de vez en cuando. / Beauty and joy. And a bit of tech from time to time.',
  early_access_days = 7,
  free_mini_episode_enabled = 1,
  updated_at = datetime('now')
WHERE id = 'show_opera_en_la_selva';
