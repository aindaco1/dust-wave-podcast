CREATE TABLE show_distribution_destinations (
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES distribution_destinations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  owner_setup_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (owner_setup_status IN ('not_started', 'pending', 'verified', 'not_required')),
  listing_url TEXT,
  owner_verified_at TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (show_id, destination_id)
);

INSERT INTO show_distribution_destinations (
  show_id,
  destination_id,
  enabled,
  owner_setup_status
)
SELECT
  s.id,
  d.id,
  d.enabled,
  d.owner_setup_status
FROM shows s
CROSS JOIN distribution_destinations d;

CREATE INDEX show_distribution_setup_status
  ON show_distribution_destinations(show_id, enabled, owner_setup_status);
