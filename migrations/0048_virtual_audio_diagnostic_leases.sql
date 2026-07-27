CREATE TABLE virtual_audio_diagnostic_leases (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 16 AND 64),
  token_hash TEXT NOT NULL UNIQUE
    CHECK(length(token_hash) = 64)
    CHECK(token_hash NOT GLOB '*[^a-f0-9]*'),
  expires_at TEXT NOT NULL,
  exchanged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(julianday(expires_at) IS NOT NULL),
  CHECK(exchanged_at IS NULL OR julianday(exchanged_at) IS NOT NULL)
);

CREATE INDEX idx_virtual_audio_diagnostic_leases_expiry
  ON virtual_audio_diagnostic_leases(expires_at, exchanged_at);
