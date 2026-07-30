PRAGMA foreign_keys = ON;

CREATE INDEX subscription_admin_show_updated
  ON subscriptions(show_id, updated_at DESC, id DESC);

CREATE INDEX subscription_admin_updated
  ON subscriptions(updated_at DESC, id DESC);
