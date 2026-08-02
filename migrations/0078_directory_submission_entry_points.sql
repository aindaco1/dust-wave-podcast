PRAGMA foreign_keys = ON;

-- Keep operator actions on the providers' current first-party entry points.
-- These registry-only updates intentionally do not alter show setup evidence.
UPDATE distribution_destinations
SET
  submission_url = 'https://creators.spotify.com/',
  updated_at = datetime('now')
WHERE id = 'spotify';

UPDATE distribution_destinations
SET
  submission_url = 'https://podcasters.amazon.com/submit-rss',
  updated_at = datetime('now')
WHERE id = 'amazon_music';

UPDATE distribution_destinations
SET
  submission_url = 'https://player.fm/add',
  updated_at = datetime('now')
WHERE id = 'player_fm';

UPDATE distribution_destinations
SET
  submission_url = 'https://castbox.fm/podcasters-tools/',
  updated_at = datetime('now')
WHERE id = 'castbox';

UPDATE distribution_destinations
SET
  submission_url = 'https://podcasters.iheart.com/add-podcast/',
  updated_at = datetime('now')
WHERE id = 'iheartradio';
