PRAGMA foreign_keys = ON;

ALTER TABLE subscription_entitlement_sources
  ADD COLUMN provider_event_id TEXT
    CHECK (
      provider_event_id IS NULL
      OR length(provider_event_id) BETWEEN 1 AND 255
    );

ALTER TABLE subscription_entitlement_sources
  ADD COLUMN provider_event_created_at INTEGER
    CHECK (
      provider_event_created_at IS NULL
      OR provider_event_created_at > 0
    );
