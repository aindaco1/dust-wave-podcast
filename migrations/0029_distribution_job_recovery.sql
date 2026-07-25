CREATE INDEX distribution_jobs_running_lease
  ON distribution_jobs(status, started_at)
  WHERE status = 'running';
