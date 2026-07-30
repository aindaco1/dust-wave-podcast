ALTER TABLE distribution_jobs
  ADD COLUMN publication_revision INTEGER NOT NULL DEFAULT 0
    CHECK (publication_revision >= 0);

UPDATE distribution_jobs
SET publication_revision = COALESCE(
  (
    SELECT e.publication_revision
    FROM episodes e
    WHERE e.id = distribution_jobs.episode_id
  ),
  0
)
WHERE publication_revision = 0;

CREATE INDEX distribution_jobs_episode_revision
  ON distribution_jobs(
    episode_id,
    publication_revision DESC,
    destination,
    created_at DESC
  );
