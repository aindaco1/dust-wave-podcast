CREATE TABLE virtual_audio_gate_runs (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 20 AND 100)
    CHECK(id NOT GLOB '*[^A-Za-z0-9_-]*'),
  source_commit TEXT NOT NULL
    CHECK(length(source_commit) = 40)
    CHECK(source_commit NOT GLOB '*[^a-f0-9]*'),
  generated_at TEXT NOT NULL
    CHECK(julianday(generated_at) IS NOT NULL),
  paired_requests INTEGER NOT NULL CHECK(paired_requests BETWEEN 5000 AND 10000),
  total_measured_requests INTEGER NOT NULL
    CHECK(total_measured_requests = paired_requests * 2),
  protocol_probe_count INTEGER NOT NULL CHECK(protocol_probe_count BETWEEN 24 AND 200),
  protocol_failed_count INTEGER NOT NULL
    CHECK(protocol_failed_count BETWEEN 0 AND protocol_probe_count),
  failed_requests INTEGER NOT NULL
    CHECK(failed_requests BETWEEN 0 AND total_measured_requests),
  error_rate REAL NOT NULL CHECK(error_rate BETWEEN 0 AND 1),
  content_mismatches INTEGER NOT NULL
    CHECK(content_mismatches BETWEEN 0 AND total_measured_requests),
  p95_added_ms REAL NOT NULL CHECK(p95_added_ms BETWEEN -10000 AND 60000),
  protocol_passed INTEGER NOT NULL CHECK(protocol_passed IN (0, 1)),
  load_passed INTEGER NOT NULL CHECK(load_passed IN (0, 1)),
  cleanup_complete INTEGER NOT NULL CHECK(cleanup_complete IN (0, 1)),
  diagnostic_lease_removed INTEGER NOT NULL
    CHECK(diagnostic_lease_removed IN (0, 1)),
  uploaded_objects_removed INTEGER NOT NULL
    CHECK(uploaded_objects_removed IN (0, 1)),
  failure_code TEXT
    CHECK(failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  github_repository TEXT NOT NULL
    CHECK(github_repository = 'aindaco1/dust-wave-podcast'),
  github_run_id TEXT NOT NULL
    CHECK(length(github_run_id) BETWEEN 1 AND 30)
    CHECK(github_run_id NOT GLOB '*[^0-9]*'),
  github_run_attempt INTEGER NOT NULL
    CHECK(github_run_attempt BETWEEN 1 AND 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(github_repository, github_run_id, github_run_attempt),
  CHECK(
    failure_code IS NOT NULL
    OR (
      protocol_passed = 1
      AND load_passed = 1
      AND cleanup_complete = 1
      AND diagnostic_lease_removed = 1
      AND uploaded_objects_removed = 1
    )
  )
);

CREATE INDEX idx_virtual_audio_gate_runs_freshness
  ON virtual_audio_gate_runs(generated_at DESC, created_at DESC);
