export type ShowStatus = "coming_soon" | "active" | "archived";
export type EpisodeStatus = "draft" | "scheduled" | "published";
export type EpisodeAccess = "public" | "early_access" | "premium_bonus" | "free_mini";

export interface ShowRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  description_en: string;
  language: string;
  status: ShowStatus;
  artwork_url: string | null;
  canonical_url: string;
  youtube_channel_url: string | null;
  premium_enabled: number;
  early_access_days: number | null;
  free_mini_episode_enabled: number;
}

export interface PriceRow {
  billing_period: "month" | "year";
  amount_cents: number;
  currency: string;
}

export interface EpisodeRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  episode_number: number | null;
  season_number: number | null;
  access: EpisodeAccess;
  public_at: string | null;
  premium_at: string | null;
  canonical_url: string;
  duration_seconds: number | null;
}

export interface PublicShow extends Omit<
  ShowRow,
  | "premium_enabled"
  | "early_access_days"
  | "free_mini_episode_enabled"
  | "description_en"
> {
  descriptionEn: string;
  premiumEnabled: boolean;
  earlyAccessDays: number | null;
  freeMiniEpisodeEnabled: boolean;
  prices: PriceRow[];
  episodes?: EpisodeRow[];
}

export interface PodcastJob {
  id: string;
  type:
    | "transcribe"
    | "align-transcript"
    | "render-clip"
    | "publish-news"
    | "publish-rss"
    | "publish-youtube"
    | "send-premium-notification";
  showId: string;
  episodeId?: string;
  publicationRevision?: number;
  requestedAt: string;
}
