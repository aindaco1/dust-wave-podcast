PRAGMA foreign_keys = ON;

ALTER TABLE alignment_benchmark_runs
  ADD COLUMN evidence_schema_version TEXT
    CHECK (
      evidence_schema_version IS NULL
      OR evidence_schema_version = 'alignment-benchmark-evidence-v1'
    );

ALTER TABLE alignment_benchmark_runs
  ADD COLUMN submission_id TEXT
    CHECK (
      submission_id IS NULL
      OR length(submission_id) BETWEEN 1 AND 128
    );

ALTER TABLE alignment_benchmark_runs
  ADD COLUMN input_object_key TEXT
    CHECK (
      input_object_key IS NULL
      OR (
        length(input_object_key) BETWEEN 1 AND 1024
        AND input_object_key NOT LIKE '/%'
        AND instr(input_object_key, '..') = 0
      )
    );

ALTER TABLE alignment_benchmark_runs
  ADD COLUMN input_bytes INTEGER
    CHECK (
      input_bytes IS NULL
      OR input_bytes BETWEEN 1 AND 8388608
    );

ALTER TABLE alignment_benchmark_runs
  ADD COLUMN input_sha256 TEXT
    CHECK (
      input_sha256 IS NULL
      OR (
        length(input_sha256) = 64
        AND input_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE alignment_benchmark_runs
  ADD COLUMN runner_revision TEXT
    CHECK (
      runner_revision IS NULL
      OR (
        length(runner_revision) = 40
        AND runner_revision NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE alignment_benchmark_runs
  ADD COLUMN submitted_by_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX alignment_benchmark_submission
  ON alignment_benchmark_runs(submission_id)
  WHERE submission_id IS NOT NULL;

CREATE UNIQUE INDEX alignment_benchmark_input
  ON alignment_benchmark_runs(input_sha256)
  WHERE input_sha256 IS NOT NULL;

CREATE INDEX alignment_benchmark_report
  ON alignment_benchmark_runs(report_sha256);

CREATE VIEW alignment_passing_benchmark_evidence AS
SELECT benchmark.*
FROM alignment_benchmark_runs benchmark
WHERE benchmark.status = 'passed'
  AND benchmark.clean_environment_reproduced = 1
  AND benchmark.evidence_schema_version =
    'alignment-benchmark-evidence-v1'
  AND benchmark.submission_id IS NOT NULL
  AND benchmark.input_object_key IS NOT NULL
  AND benchmark.input_bytes BETWEEN 1 AND 8388608
  AND benchmark.input_sha256 IS NOT NULL
  AND benchmark.runner_revision IS NOT NULL
  AND benchmark.submitted_by_admin_user_id IS NOT NULL
  AND benchmark.completed_at IS NOT NULL
  AND json_extract(benchmark.report_json, '$.schemaVersion') = '1'
  AND json_extract(benchmark.report_json, '$.passed') = 1
  AND json_extract(
    benchmark.report_json,
    '$.cleanEnvironmentGatePassed'
  ) = 1
  AND json_extract(
    benchmark.report_json,
    '$.benchmarkIntegrityGatePassed'
  ) = 1
  AND json_extract(benchmark.report_json, '$.resourceGatePassed') = 1
  AND json_extract(benchmark.report_json, '$.idempotencyGatePassed') = 1
  AND json_extract(benchmark.report_json, '$.previews.passed') = 1
  AND json_extract(benchmark.report_json, '$.languages.en.passed') = 1
  AND json_extract(benchmark.report_json, '$.languages.es.passed') = 1
  AND json_extract(benchmark.report_json, '$.corpusVersion') =
    benchmark.corpus_version
  AND json_extract(benchmark.report_json, '$.adapter.name') =
    benchmark.adapter
  AND json_extract(benchmark.report_json, '$.adapter.version') =
    benchmark.adapter_version
  AND json_extract(benchmark.report_json, '$.adapter.model') =
    benchmark.model
  AND json_extract(benchmark.report_json, '$.adapter.modelVersion') =
    benchmark.model_version
  AND json_extract(benchmark.report_json, '$.adapter.settingsVersion') =
    benchmark.settings_version
  AND json_extract(benchmark.report_json, '$.adapter.runnerDigest') =
    benchmark.runner_digest;

DROP TRIGGER transcript_alignment_approval_exact_gate;

CREATE TRIGGER transcript_alignment_approval_exact_gate
BEFORE INSERT ON transcript_alignment_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM transcript_alignment_revisions revision
  JOIN transcript_alignment_jobs job
    ON job.alignment_revision_id = revision.id
  JOIN alignment_passing_benchmark_evidence benchmark
    ON benchmark.id = NEW.benchmark_run_id
  JOIN transcripts transcript
    ON transcript.id = job.transcript_id
  JOIN episode_working_master_states master_state
    ON master_state.episode_id = job.episode_id
  WHERE revision.id = NEW.alignment_revision_id
    AND revision.status = 'needs_review'
    AND job.status = 'ready'
    AND json_extract(job.quality_report_json, '$.structurallyEligible') = 1
    AND transcript.status = 'approved'
    AND transcript.revision = job.transcript_revision
    AND transcript.content_sha256 = job.transcript_content_sha256
    AND master_state.current_master_id = job.working_master_id
    AND benchmark.runner_revision = job.runner_revision
    AND benchmark.adapter = job.adapter
    AND benchmark.adapter_version = job.adapter_version
    AND benchmark.model = job.model
    AND benchmark.model_version = job.model_version
    AND benchmark.settings_version = job.settings_version
    AND benchmark.runner_digest = job.runner_digest
)
BEGIN
  SELECT RAISE(
    ABORT,
    'alignment approval requires exact current inputs and private benchmark evidence'
  );
END;
