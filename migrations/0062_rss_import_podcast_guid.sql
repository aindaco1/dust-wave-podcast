PRAGMA foreign_keys = ON;

-- Freeze a source host's canonical Podcasting 2.0 channel identity into each
-- immutable migration plan. NULL means the exact source feed had no GUID.
ALTER TABLE rss_import_plans
  ADD COLUMN source_podcast_guid TEXT
    CHECK (
      source_podcast_guid IS NULL
      OR (
        length(source_podcast_guid) = 36
        AND source_podcast_guid = lower(source_podcast_guid)
        AND substr(source_podcast_guid, 9, 1) = '-'
        AND substr(source_podcast_guid, 14, 1) = '-'
        AND substr(source_podcast_guid, 19, 1) = '-'
        AND substr(source_podcast_guid, 24, 1) = '-'
        AND length(replace(source_podcast_guid, '-', '')) = 32
        AND replace(source_podcast_guid, '-', '')
          NOT GLOB '*[^0-9a-f]*'
        AND substr(source_podcast_guid, 15, 1) = '5'
        AND substr(source_podcast_guid, 20, 1) IN ('8', '9', 'a', 'b')
      )
    );

CREATE TRIGGER rss_import_plan_podcast_guid_immutable
BEFORE UPDATE OF source_podcast_guid ON rss_import_plans
WHEN OLD.source_podcast_guid IS NOT NEW.source_podcast_guid
BEGIN
  SELECT RAISE(ABORT, 'rss_import_plan_podcast_guid_immutable');
END;
