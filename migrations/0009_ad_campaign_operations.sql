PRAGMA foreign_keys = ON;

ALTER TABLE ad_campaigns
  ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (approval_status IN ('draft', 'approved', 'rejected', 'revoked'));

ALTER TABLE ad_campaigns
  ADD COLUMN approved_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE ad_campaigns
  ADD COLUMN approved_at TEXT;

ALTER TABLE ad_campaigns
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision > 0);

ALTER TABLE ad_rules
  ADD COLUMN active INTEGER NOT NULL DEFAULT 1
    CHECK (active IN (0, 1));

ALTER TABLE ad_rules
  ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

CREATE INDEX sponsors_name_lookup
  ON sponsors(name COLLATE NOCASE);

CREATE INDEX ad_campaign_approval
  ON ad_campaigns(approval_status, active, starts_at, ends_at);

CREATE INDEX ad_rules_campaign_active
  ON ad_rules(campaign_id, active, show_id, episode_id, position);
