PRAGMA foreign_keys = ON;

-- Podcasting 2.0 channel identity is assigned once and follows the show when
-- its feed URL or hosting provider changes. UUIDv5 is used for identity, not
-- for a cryptographic security decision.
ALTER TABLE shows
  ADD COLUMN podcast_guid TEXT
    CHECK (
      podcast_guid IS NULL
      OR (
        length(podcast_guid) = 36
        AND podcast_guid = lower(podcast_guid)
        AND substr(podcast_guid, 9, 1) = '-'
        AND substr(podcast_guid, 14, 1) = '-'
        AND substr(podcast_guid, 19, 1) = '-'
        AND substr(podcast_guid, 24, 1) = '-'
        AND length(replace(podcast_guid, '-', '')) = 32
        AND replace(podcast_guid, '-', '')
          NOT GLOB '*[^0-9a-f]*'
        AND substr(podcast_guid, 15, 1) = '5'
        AND substr(podcast_guid, 20, 1) IN ('8', '9', 'a', 'b')
      )
    );

-- Assigned from the permanent public feed URL
-- feeds.dustwave.xyz/opera-en-la-selva/rss.xml using the Podcasting 2.0
-- namespace ead4c236-bf58-58c6-a2c6-a6b28d128cb6.
UPDATE shows
SET podcast_guid = 'd21642df-1816-55c8-b308-6209066e9ef6'
WHERE id = 'show_opera_en_la_selva'
  AND podcast_guid IS NULL;

CREATE UNIQUE INDEX shows_podcast_guid_unique
  ON shows(podcast_guid)
  WHERE podcast_guid IS NOT NULL;

CREATE TRIGGER shows_podcast_guid_immutable
BEFORE UPDATE OF podcast_guid ON shows
WHEN
  OLD.podcast_guid IS NOT NULL
  AND OLD.podcast_guid IS NOT NEW.podcast_guid
BEGIN
  SELECT RAISE(ABORT, 'show_podcast_guid_immutable');
END;

CREATE TRIGGER podcast_guid_feed_evidence_update
AFTER UPDATE OF podcast_guid ON shows
WHEN OLD.podcast_guid IS NOT NEW.podcast_guid
BEGIN
  UPDATE publication_show_evidence_versions
  SET version = version + 1
  WHERE show_id = NEW.id;

  DELETE FROM show_feed_validations
  WHERE show_id = NEW.id;
END;

-- Validator v3 requires the immutable channel GUID, so no v1/v2 exact-feed
-- fingerprint may remain current after this migration.
DELETE FROM show_feed_validations;
