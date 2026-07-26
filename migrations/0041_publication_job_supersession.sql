-- A new root publication revision must not race a provider write already in
-- flight for an older revision. Queue/failed work is safe to cancel
-- atomically; running work must finish before an operator retries Publish.
CREATE TRIGGER prevent_publication_revision_advance_with_running_job
BEFORE UPDATE OF publication_revision ON episodes
WHEN NEW.publication_revision > OLD.publication_revision
  AND EXISTS (
    SELECT 1
    FROM distribution_jobs
    WHERE episode_id = OLD.id
      AND publication_revision < NEW.publication_revision
      AND status = 'running'
  )
BEGIN
  SELECT RAISE(ABORT, 'publication_jobs_running');
END;

CREATE TRIGGER cancel_superseded_distribution_jobs
AFTER UPDATE OF publication_revision ON episodes
WHEN NEW.publication_revision > OLD.publication_revision
BEGIN
  UPDATE distribution_jobs
  SET
    status = 'canceled',
    completed_at = datetime('now'),
    last_error = 'Superseded by a newer publication revision.'
  WHERE episode_id = NEW.id
    AND publication_revision < NEW.publication_revision
    AND status IN ('queued', 'failed');
END;
