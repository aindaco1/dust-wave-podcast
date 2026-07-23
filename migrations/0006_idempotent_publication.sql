ALTER TABLE episodes ADD COLUMN publication_fingerprint TEXT;

CREATE INDEX episodes_publication_fingerprint
  ON episodes(id, publication_revision, publication_fingerprint);
