PRAGMA foreign_keys = ON;

-- Preserve operator-authored show identities. Only replace the legacy network
-- fallback that was seeded before author became a per-show setting.
UPDATE shows
SET
  author_name = 'Jay Renteria',
  updated_at = datetime('now')
WHERE id = 'show_opera_en_la_selva'
  AND author_name = 'Dust Wave';
