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
  author_name: string;
  category: string;
  explicit: number;
}

export interface PriceRow {
  id: string;
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
  | "author_name"
  | "explicit"
> {
  descriptionEn: string;
  authorName: string;
  explicit: boolean;
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
    | "publish-youtube-clip"
    | "execute-rss-import-item"
    | "send-premium-notification"
    | "send-announcement";
  showId: string;
  episodeId?: string;
  announcementId?: string;
  announcementDeliveryId?: string;
  clipRenderId?: string;
  clipPublicationId?: string;
  rssImportExecutionId?: string;
  rssImportSourceIdentitySha256?: string;
  publicationRevision?: number;
  requestedAt: string;
}
