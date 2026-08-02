PRAGMA foreign_keys = ON;

CREATE INDEX subscription_entitlement_expiry
  ON subscription_entitlement_sources(
    status,
    current_period_end,
    listener_id,
    show_id
  )
  WHERE current_period_end IS NOT NULL;

CREATE INDEX subscription_projection_expiry
  ON subscriptions(
    status,
    current_period_end,
    listener_id,
    show_id
  )
  WHERE current_period_end IS NOT NULL;
