PRAGMA foreign_keys = ON;

CREATE INDEX ad_rules_show_active_campaign
  ON ad_rules(show_id, active, campaign_id);

CREATE INDEX ad_campaigns_reporting_created
  ON ad_campaigns(created_at DESC, id);
