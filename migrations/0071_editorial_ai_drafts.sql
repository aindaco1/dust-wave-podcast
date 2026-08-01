PRAGMA foreign_keys = ON;

-- Private, review-only AI proposals. Draft text remains in D1 and never
-- changes an episode, feed, News page, or publication state by itself.
CREATE TABLE editorial_ai_drafts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  working_master_id TEXT NOT NULL
    REFERENCES episode_working_masters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('show_notes')),
  source_transcript_id TEXT NOT NULL
    REFERENCES transcripts(id) ON DELETE CASCADE,
  source_language TEXT NOT NULL CHECK (source_language IN ('en', 'es')),
  source_transcript_revision INTEGER NOT NULL
    CHECK (source_transcript_revision > 0),
  source_transcript_sha256 TEXT NOT NULL
    CHECK (
      length(source_transcript_sha256) = 64
      AND source_transcript_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  included_cue_count INTEGER NOT NULL CHECK (included_cue_count > 0),
  total_cue_count INTEGER NOT NULL CHECK (total_cue_count >= included_cue_count),
  transcript_truncated INTEGER NOT NULL
    CHECK (transcript_truncated IN (0, 1)),
  episode_evidence_sha256 TEXT NOT NULL
    CHECK (
      length(episode_evidence_sha256) = 64
      AND episode_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  output_language TEXT NOT NULL CHECK (output_language IN ('en', 'es')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 160),
  prompt_version TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 80),
  input_fingerprint TEXT NOT NULL UNIQUE
    CHECK (
      length(input_fingerprint) = 64
      AND input_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'ready', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1
    CHECK (attempt_count BETWEEN 1 AND 3),
  lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 20 AND 100),
  lease_expires_at TEXT,
  draft_json TEXT CHECK (draft_json IS NULL OR json_valid(draft_json)),
  draft_sha256 TEXT
    CHECK (
      draft_sha256 IS NULL
      OR (
        length(draft_sha256) = 64
        AND draft_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  failure_code TEXT
    CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (status = 'generating' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status != 'generating'
  ),
  CHECK (
    (status = 'ready' AND draft_json IS NOT NULL AND draft_sha256 IS NOT NULL
      AND completed_at IS NOT NULL)
    OR status != 'ready'
  ),
  CHECK (status != 'failed' OR failure_code IS NOT NULL)
);

CREATE INDEX editorial_ai_drafts_episode_ready
  ON editorial_ai_drafts(episode_id, kind, status, completed_at DESC);

CREATE INDEX editorial_ai_drafts_recovery
  ON editorial_ai_drafts(status, lease_expires_at, attempt_count, updated_at);
