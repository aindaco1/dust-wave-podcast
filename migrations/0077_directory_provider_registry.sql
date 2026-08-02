PRAGMA foreign_keys = ON;

-- Castbox retired the legacy /podcasters route. Keep the current first-party
-- podcaster information and ownership-claim entry point in the registry.
UPDATE distribution_destinations
SET
  submission_url = 'https://castbox.fm/podcasters.html',
  updated_at = datetime('now')
WHERE id = 'castbox';

-- Overcast has no separate owner setup or submission process. It ordinarily
-- discovers public shows through Apple Podcasts; its manual add form is only a
-- recovery path after an Apple listing exists. Preserve any operator-authored
-- show state and update only untouched defaults.
UPDATE distribution_destinations
SET
  owner_setup_status = 'not_required',
  submission_url = 'https://overcast.fm/podcasterinfo',
  updated_at = datetime('now')
WHERE id = 'overcast';

UPDATE show_distribution_destinations
SET
  owner_setup_status = 'not_required',
  updated_at = datetime('now')
WHERE destination_id = 'overcast'
  AND owner_setup_status = 'not_started';
