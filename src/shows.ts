import type { EpisodeRow, PriceRow, PublicShow, ShowRow } from "./types";

const SHOW_COLUMNS = `
  id, slug, title, description, language, status, artwork_url,
  canonical_url, youtube_channel_url, premium_enabled, early_access_days
`;

function presentShow(show: ShowRow, prices: PriceRow[], episodes?: EpisodeRow[]): PublicShow {
  const { premium_enabled, ...rest } = show;
  return {
    ...rest,
    premiumEnabled: premium_enabled === 1,
    prices,
    ...(episodes ? { episodes } : {})
  };
}

export async function listPublicShows(db: D1Database): Promise<PublicShow[]> {
  const showResult = await db
    .prepare(`SELECT ${SHOW_COLUMNS} FROM shows WHERE status != 'archived' ORDER BY title`)
    .all<ShowRow>();

  const priceResult = await db
    .prepare(
      `SELECT show_id, billing_period, amount_cents, currency
       FROM show_prices WHERE active = 1 ORDER BY amount_cents`
    )
    .all<PriceRow & { show_id: string }>();

  const pricesByShow = new Map<string, PriceRow[]>();
  for (const { show_id, ...price } of priceResult.results) {
    const prices = pricesByShow.get(show_id) ?? [];
    prices.push(price);
    pricesByShow.set(show_id, prices);
  }

  return showResult.results.map((show) =>
    presentShow(show, pricesByShow.get(show.id) ?? [])
  );
}

export async function getPublicShow(db: D1Database, slug: string): Promise<PublicShow | null> {
  const show = await db
    .prepare(`SELECT ${SHOW_COLUMNS} FROM shows WHERE slug = ? AND status != 'archived'`)
    .bind(slug)
    .first<ShowRow>();

  if (!show) {
    return null;
  }

  const [priceResult, episodeResult] = await Promise.all([
    db
      .prepare(
        `SELECT billing_period, amount_cents, currency
         FROM show_prices WHERE show_id = ? AND active = 1 ORDER BY amount_cents`
      )
      .bind(show.id)
      .all<PriceRow>(),
    db
      .prepare(
        `SELECT id, slug, title, summary, episode_number, season_number, access,
                public_at, premium_at, canonical_url, duration_seconds
         FROM episodes
         WHERE show_id = ? AND status = 'published' AND public_at <= datetime('now')
         ORDER BY public_at DESC`
      )
      .bind(show.id)
      .all<EpisodeRow>()
  ]);

  return presentShow(show, priceResult.results, episodeResult.results);
}

