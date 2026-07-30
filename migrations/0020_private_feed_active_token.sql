PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX private_feed_tokens_one_active
  ON private_feed_tokens(listener_id, show_id)
  WHERE revoked_at IS NULL;
