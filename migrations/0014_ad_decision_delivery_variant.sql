PRAGMA foreign_keys = ON;

ALTER TABLE ad_decisions
  ADD COLUMN delivery_variant TEXT
    CHECK (
      delivery_variant IS NULL
      OR delivery_variant IN ('primary', 'fallback')
    );

ALTER TABLE ad_decisions
  ADD COLUMN delivery_committed_at TEXT;
