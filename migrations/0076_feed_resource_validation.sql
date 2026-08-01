PRAGMA foreign_keys = ON;

-- Preserve the rights-provided source image for the site while publishing the
-- deterministic, directory-sized derivative in RSS. The projection trigger
-- removes prior exact-feed evidence when this value changes.
UPDATE shows
SET artwork_url =
  'https://dustwave.xyz/img/podcasts/opera-en-la-selva/artwork-feed.jpg'
WHERE id = 'show_opera_en_la_selva'
  AND artwork_url =
    'https://dustwave.xyz/img/podcasts/opera-en-la-selva/artwork.png';

-- Validator v4 certifies public pages, artwork dimensions, enclosure transport,
-- transcripts, and chapters in addition to the exact RSS body. Older rows do
-- not contain that evidence.
DELETE FROM show_feed_validations
WHERE validator_version != 'dustwave-rss-launch-v4';
