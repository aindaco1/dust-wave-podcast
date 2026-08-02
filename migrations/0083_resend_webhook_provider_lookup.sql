PRAGMA foreign_keys = ON;

CREATE INDEX podcast_resend_webhook_events_provider_status
  ON podcast_resend_webhook_events(provider_id, event_type, processed_at DESC)
  WHERE provider_id IS NOT NULL;
