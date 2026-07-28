PRAGMA foreign_keys = ON;

-- A feed validation certifies one exact rendered RSS body. Remove that
-- evidence whenever a channel field, item field, or approval can change the
-- public projection. The existing validation-delete trigger advances the
-- publication evidence version for the affected show.

CREATE TRIGGER feed_validation_show_projection_update
AFTER UPDATE OF
  slug,
  title,
  description,
  language,
  status,
  artwork_url,
  canonical_url,
  rss_slug,
  author_name,
  category,
  explicit
ON shows
WHEN
  OLD.slug IS NOT NEW.slug
  OR OLD.title IS NOT NEW.title
  OR OLD.description IS NOT NEW.description
  OR OLD.language IS NOT NEW.language
  OR OLD.status IS NOT NEW.status
  OR OLD.artwork_url IS NOT NEW.artwork_url
  OR OLD.canonical_url IS NOT NEW.canonical_url
  OR OLD.rss_slug IS NOT NEW.rss_slug
  OR OLD.author_name IS NOT NEW.author_name
  OR OLD.category IS NOT NEW.category
  OR OLD.explicit IS NOT NEW.explicit
BEGIN
  DELETE FROM show_feed_validations WHERE show_id = NEW.id;
END;

CREATE TRIGGER feed_validation_episode_projection_insert
AFTER INSERT ON episodes
WHEN
  NEW.status = 'published'
  AND NEW.public_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  AND NEW.access IN ('public', 'early_access', 'free_mini')
  AND NEW.media_status = 'ready'
  AND NEW.audio_key IS NOT NULL
  AND NEW.guid IS NOT NULL
BEGIN
  DELETE FROM show_feed_validations WHERE show_id = NEW.show_id;
END;

CREATE TRIGGER feed_validation_episode_projection_update
AFTER UPDATE OF
  show_id,
  slug,
  title,
  summary,
  status,
  access,
  public_at,
  canonical_url,
  duration_seconds,
  audio_key,
  audio_mime_type,
  audio_bytes,
  audio_filename,
  media_status,
  guid,
  explicit,
  season_number,
  episode_number,
  created_at
ON episodes
WHEN
  OLD.show_id IS NOT NEW.show_id
  OR OLD.slug IS NOT NEW.slug
  OR OLD.title IS NOT NEW.title
  OR OLD.summary IS NOT NEW.summary
  OR OLD.status IS NOT NEW.status
  OR OLD.access IS NOT NEW.access
  OR OLD.public_at IS NOT NEW.public_at
  OR OLD.canonical_url IS NOT NEW.canonical_url
  OR OLD.duration_seconds IS NOT NEW.duration_seconds
  OR OLD.audio_key IS NOT NEW.audio_key
  OR OLD.audio_mime_type IS NOT NEW.audio_mime_type
  OR OLD.audio_bytes IS NOT NEW.audio_bytes
  OR OLD.audio_filename IS NOT NEW.audio_filename
  OR OLD.media_status IS NOT NEW.media_status
  OR OLD.guid IS NOT NEW.guid
  OR OLD.explicit IS NOT NEW.explicit
  OR OLD.season_number IS NOT NEW.season_number
  OR OLD.episode_number IS NOT NEW.episode_number
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  DELETE FROM show_feed_validations
  WHERE show_id = OLD.show_id OR show_id = NEW.show_id;
END;

CREATE TRIGGER feed_validation_episode_projection_delete
BEFORE DELETE ON episodes
WHEN
  OLD.status = 'published'
  AND OLD.public_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  AND OLD.access IN ('public', 'early_access', 'free_mini')
  AND OLD.media_status = 'ready'
  AND OLD.audio_key IS NOT NULL
  AND OLD.guid IS NOT NULL
BEGIN
  DELETE FROM show_feed_validations WHERE show_id = OLD.show_id;
END;

CREATE TRIGGER feed_validation_transcript_approval_insert
AFTER INSERT ON transcript_approvals
BEGIN
  DELETE FROM show_feed_validations
  WHERE show_id = (
    SELECT episode.show_id
    FROM transcripts transcript
    JOIN episodes episode ON episode.id = transcript.episode_id
    WHERE transcript.id = NEW.transcript_id
  );
END;

CREATE TRIGGER feed_validation_transcript_approval_update
AFTER UPDATE ON transcript_approvals
BEGIN
  DELETE FROM show_feed_validations
  WHERE show_id IN (
    SELECT episode.show_id
    FROM transcripts transcript
    JOIN episodes episode ON episode.id = transcript.episode_id
    WHERE transcript.id IN (OLD.transcript_id, NEW.transcript_id)
  );
END;

CREATE TRIGGER feed_validation_transcript_approval_delete
BEFORE DELETE ON transcript_approvals
BEGIN
  DELETE FROM show_feed_validations
  WHERE show_id = (
    SELECT episode.show_id
    FROM transcripts transcript
    JOIN episodes episode ON episode.id = transcript.episode_id
    WHERE transcript.id = OLD.transcript_id
  );
END;

CREATE TRIGGER feed_validation_chapter_approval_insert
AFTER INSERT ON episode_chapter_approvals
BEGIN
  DELETE FROM show_feed_validations
  WHERE show_id = (
    SELECT show_id FROM episodes WHERE id = NEW.episode_id
  );
END;

CREATE TRIGGER feed_validation_chapter_approval_update
AFTER UPDATE ON episode_chapter_approvals
BEGIN
  DELETE FROM show_feed_validations
  WHERE show_id IN (
    SELECT show_id
    FROM episodes
    WHERE id IN (OLD.episode_id, NEW.episode_id)
  );
END;

CREATE TRIGGER feed_validation_chapter_approval_delete
BEFORE DELETE ON episode_chapter_approvals
BEGIN
  DELETE FROM show_feed_validations
  WHERE show_id = (
    SELECT show_id FROM episodes WHERE id = OLD.episode_id
  );
END;
