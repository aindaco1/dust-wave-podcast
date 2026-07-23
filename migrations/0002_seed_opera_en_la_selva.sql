INSERT INTO shows (
  id,
  slug,
  title,
  description,
  language,
  status,
  artwork_url,
  canonical_url,
  rss_slug,
  youtube_channel_url,
  premium_enabled,
  early_access_days
) VALUES (
  'show_opera_en_la_selva',
  'opera-en-la-selva',
  'Ópera en la Selva',
  'Beauty and joy. And a bit of tech from time to time.',
  'es',
  'coming_soon',
  'https://dustwave.xyz/img/podcasts/opera-en-la-selva/artwork.png',
  'https://dustwave.xyz/podcasts/opera-en-la-selva/',
  'opera-en-la-selva',
  'https://youtube.com/@dustwavecollective',
  1,
  NULL
);

INSERT INTO show_prices (
  id,
  show_id,
  billing_period,
  amount_cents,
  currency
) VALUES
  ('price_opera_monthly_usd', 'show_opera_en_la_selva', 'month', 500, 'USD'),
  ('price_opera_annual_usd', 'show_opera_en_la_selva', 'year', 5000, 'USD');

