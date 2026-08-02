PRAGMA foreign_keys = ON;

-- Launch Lab selects a bounded, exact subscription history before requesting
-- provider-originated duplicate and older-event deliveries.
CREATE INDEX stripe_event_journal_subscription_order
  ON stripe_event_journal(
    subscription_id,
    event_type,
    status,
    provider_created_at,
    event_id
  );
