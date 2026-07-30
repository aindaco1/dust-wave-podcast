PRAGMA foreign_keys = ON;

ALTER TABLE episodes
  ADD COLUMN publication_evidence_version INTEGER NOT NULL DEFAULT 0
    CHECK (publication_evidence_version >= 0);

CREATE TABLE publication_show_evidence_versions (
  show_id TEXT PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);

INSERT INTO publication_show_evidence_versions (show_id)
SELECT id FROM shows;

CREATE TABLE publication_global_evidence_versions (
  id TEXT PRIMARY KEY CHECK (id = 'distribution'),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);

INSERT INTO publication_global_evidence_versions (id)
VALUES ('distribution');

CREATE TABLE publication_gate_overrides (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  base_publication_revision INTEGER NOT NULL
    CHECK (base_publication_revision >= 0),
  publication_evidence_version INTEGER NOT NULL
    CHECK (publication_evidence_version >= 0),
  show_evidence_version INTEGER NOT NULL
    CHECK (show_evidence_version >= 0),
  global_evidence_version INTEGER NOT NULL
    CHECK (global_evidence_version >= 0),
  snapshot_digest TEXT NOT NULL
    CHECK (
      length(snapshot_digest) = 64
      AND snapshot_digest NOT GLOB '*[^0-9a-f]*'
    ),
  blocker_count INTEGER NOT NULL CHECK (blocker_count > 0),
  warning_count INTEGER NOT NULL CHECK (warning_count >= 0),
  reason_text TEXT NOT NULL CHECK (length(reason_text) BETWEEN 1 AND 500),
  reason_sha256 TEXT NOT NULL
    CHECK (
      length(reason_sha256) = 64
      AND reason_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX publication_gate_overrides_episode
  ON publication_gate_overrides(episode_id, created_at DESC, id DESC);

-- Publish inserts a one-row guard immediately after its conditional episode
-- update. SQLite changes() excludes auxiliary trigger writes, so the CHECK
-- aborts the whole D1 batch when the snapshot-bound update changed zero rows.
-- Successful batches delete their guard before commit.
CREATE TABLE publication_batch_guards (
  id TEXT PRIMARY KEY,
  update_succeeded INTEGER NOT NULL CHECK (update_succeeded = 1)
);

CREATE TRIGGER publication_evidence_episode_update
AFTER UPDATE OF
  title,
  summary,
  content_html,
  access,
  premium_at,
  public_at,
  canonical_url,
  guid,
  audio_key,
  audio_mime_type,
  audio_bytes,
  audio_etag,
  duration_seconds,
  media_status,
  video_source_key,
  explicit,
  dynamic_ads_enabled
ON episodes
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.id;
END;

CREATE TRIGGER publication_evidence_show_update
AFTER UPDATE OF
  slug,
  status,
  language,
  rss_slug,
  youtube_channel_url,
  premium_enabled,
  dynamic_ads_enabled
ON shows
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = NEW.id;
END;

CREATE TRIGGER publication_evidence_show_insert
AFTER INSERT ON shows
BEGIN
  INSERT INTO publication_show_evidence_versions (show_id)
  VALUES (NEW.id);
END;

CREATE TRIGGER publication_evidence_transcript_insert
AFTER INSERT ON transcripts
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_transcript_update
AFTER UPDATE ON transcripts
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_transcript_delete
AFTER DELETE ON transcripts
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = OLD.episode_id;
END;

CREATE TRIGGER publication_evidence_alignment_insert
AFTER INSERT ON transcript_alignment_revisions
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = (
    SELECT episode_id FROM transcripts WHERE id = NEW.transcript_id
  );
END;

CREATE TRIGGER publication_evidence_alignment_update
AFTER UPDATE ON transcript_alignment_revisions
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = (
    SELECT episode_id FROM transcripts WHERE id = NEW.transcript_id
  );
END;

CREATE TRIGGER publication_evidence_alignment_delete
AFTER DELETE ON transcript_alignment_revisions
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = (
    SELECT episode_id FROM transcripts WHERE id = OLD.transcript_id
  );
END;

CREATE TRIGGER publication_evidence_chapter_set_insert
AFTER INSERT ON episode_chapter_sets
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_chapter_set_update
AFTER UPDATE ON episode_chapter_sets
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_chapter_set_delete
AFTER DELETE ON episode_chapter_sets
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = OLD.episode_id;
END;

CREATE TRIGGER publication_evidence_review_insert
AFTER INSERT ON production_reviews
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_review_update
AFTER UPDATE ON production_reviews
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_review_delete
AFTER DELETE ON production_reviews
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = OLD.episode_id;
END;

CREATE TRIGGER publication_evidence_review_comment_insert
AFTER INSERT ON production_review_comments
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = (
    SELECT episode_id FROM production_reviews WHERE id = NEW.review_id
  );
END;

CREATE TRIGGER publication_evidence_review_comment_update
AFTER UPDATE ON production_review_comments
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = (
    SELECT episode_id FROM production_reviews WHERE id = NEW.review_id
  );
END;

CREATE TRIGGER publication_evidence_review_comment_delete
AFTER DELETE ON production_review_comments
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = (
    SELECT episode_id FROM production_reviews WHERE id = OLD.review_id
  );
END;

CREATE TRIGGER publication_evidence_clip_insert
AFTER INSERT ON clips
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_clip_update
AFTER UPDATE ON clips
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_clip_delete
AFTER DELETE ON clips
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = OLD.episode_id;
END;

CREATE TRIGGER publication_evidence_clip_render_insert
AFTER INSERT ON clip_renders
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = (
    SELECT episode_id FROM clips WHERE id = NEW.clip_id
  );
END;

CREATE TRIGGER publication_evidence_clip_render_update
AFTER UPDATE ON clip_renders
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = (
    SELECT episode_id FROM clips WHERE id = NEW.clip_id
  );
END;

CREATE TRIGGER publication_evidence_clip_render_delete
AFTER DELETE ON clip_renders
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = (
    SELECT episode_id FROM clips WHERE id = OLD.clip_id
  );
END;

CREATE TRIGGER publication_evidence_ad_plan_insert
AFTER INSERT ON episode_ad_plans
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_ad_plan_update
AFTER UPDATE ON episode_ad_plans
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_ad_plan_delete
AFTER DELETE ON episode_ad_plans
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = OLD.episode_id;
END;

CREATE TRIGGER publication_evidence_ad_marker_insert
AFTER INSERT ON episode_ad_markers
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_ad_marker_update
AFTER UPDATE ON episode_ad_markers
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_ad_marker_delete
AFTER DELETE ON episode_ad_markers
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = OLD.episode_id;
END;

CREATE TRIGGER publication_evidence_audio_segment_insert
AFTER INSERT ON episode_audio_segments
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_audio_segment_update
AFTER UPDATE ON episode_audio_segments
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_audio_segment_delete
AFTER DELETE ON episode_audio_segments
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = OLD.episode_id;
END;

CREATE TRIGGER publication_evidence_distribution_job_insert
AFTER INSERT ON distribution_jobs
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_distribution_job_update
AFTER UPDATE ON distribution_jobs
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_distribution_job_delete
AFTER DELETE ON distribution_jobs
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = OLD.episode_id;
END;

CREATE TRIGGER publication_evidence_site_publication_insert
AFTER INSERT ON site_publications
WHEN NEW.episode_id IS NOT NULL
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_site_publication_update
AFTER UPDATE ON site_publications
WHEN NEW.episode_id IS NOT NULL
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = NEW.episode_id;
END;

CREATE TRIGGER publication_evidence_site_publication_delete
AFTER DELETE ON site_publications
WHEN OLD.episode_id IS NOT NULL
BEGIN
  UPDATE episodes
  SET publication_evidence_version = publication_evidence_version + 1
  WHERE id = OLD.episode_id;
END;

CREATE TRIGGER publication_evidence_show_distribution_insert
AFTER INSERT ON show_distribution_destinations
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = NEW.show_id;
END;

CREATE TRIGGER publication_evidence_show_distribution_update
AFTER UPDATE ON show_distribution_destinations
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = NEW.show_id;
END;

CREATE TRIGGER publication_evidence_show_distribution_delete
AFTER DELETE ON show_distribution_destinations
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = OLD.show_id;
END;

CREATE TRIGGER publication_evidence_destination_insert
AFTER INSERT ON distribution_destinations
BEGIN
  UPDATE publication_global_evidence_versions
  SET version = version + 1
  WHERE id = 'distribution';
END;

CREATE TRIGGER publication_evidence_destination_update
AFTER UPDATE ON distribution_destinations
BEGIN
  UPDATE publication_global_evidence_versions
  SET version = version + 1
  WHERE id = 'distribution';
END;

CREATE TRIGGER publication_evidence_destination_delete
AFTER DELETE ON distribution_destinations
BEGIN
  UPDATE publication_global_evidence_versions
  SET version = version + 1
  WHERE id = 'distribution';
END;
