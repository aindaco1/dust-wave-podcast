PRAGMA foreign_keys = ON;

-- A single show-scoped taint keeps every descendant rehearsal artifact out of
-- public discovery and launch evidence without duplicating flags across the
-- episode, billing, distribution, announcement, YouTube, and advertising
-- tables. Only the staging-only signed Launch Lab boundary may set this bit.
ALTER TABLE shows
  ADD COLUMN test_fixture INTEGER NOT NULL DEFAULT 0
    CHECK (test_fixture IN (0, 1));

CREATE INDEX shows_public_catalog
  ON shows(test_fixture, status, title);

-- Fixture identity is write-once. Rehearsal rows must be deleted and recreated
-- rather than converted into real catalog records (or vice versa).
CREATE TRIGGER shows_test_fixture_immutable
BEFORE UPDATE OF test_fixture ON shows
FOR EACH ROW
WHEN OLD.test_fixture != NEW.test_fixture
BEGIN
  SELECT RAISE(ABORT, 'shows.test_fixture is immutable');
END;

CREATE TABLE launch_lab_runs (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  source_commit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'passed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(id) BETWEEN 16 AND 64),
  CHECK (length(source_commit) = 40)
);

CREATE TABLE launch_lab_provider_scenarios (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES launch_lab_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL
    CHECK (provider IN ('resend', 'stripe', 'youtube', 'rss', 'directory', 'ads', 'pool')),
  scenario TEXT NOT NULL,
  expected_status TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'passed', 'failed')),
  observed_status TEXT,
  provider_id TEXT UNIQUE,
  failure_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, provider, scenario),
  CHECK (length(id) BETWEEN 16 AND 160),
  CHECK (length(scenario) BETWEEN 1 AND 80),
  CHECK (length(expected_status) BETWEEN 1 AND 40),
  CHECK (observed_status IS NULL OR length(observed_status) <= 40),
  CHECK (failure_code IS NULL OR length(failure_code) <= 80),
  CHECK (attempt_count BETWEEN 0 AND 20)
);

CREATE INDEX launch_lab_provider_run
  ON launch_lab_provider_scenarios(run_id, provider, scenario);
