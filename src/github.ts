import type { PodcastEnv } from "./env";
import {
  readGitHubContentFile,
  writeGitHubContentFile
} from "./github-content";
import {
  planEpisodePublication,
  type NewsPublicationMode
} from "./publication-intent";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import type { EpisodeAccess } from "./types";

const PUBLICATION_DATA_PATH = "src/_data/podcastEpisodePublications.json";

type PublicationEpisode = {
  id: string;
  show_slug: string;
  slug: string;
  title: string;
  summary: string;
  access: EpisodeAccess;
  public_at: string;
  canonical_url: string;
  duration_seconds: number;
  audio_mime_type: string;
  audio_bytes: number;
  publication_revision: number;
};

export type EpisodeNewsPublication = {
  publicationSchemaVersion: 1;
  pageMode: NewsPublicationMode;
  id: string;
  showSlug: string;
  slug: string;
  title: string;
  summary: string;
  publicAt: string;
  url: string;
  canonicalUrl: string;
  subscribeUrl: string;
  publicationRevision: number;
} & (
  | {
      pageMode: "full_episode";
      duration: number;
      audioUrl: string;
      downloadUrl: string;
      peaksUrl: string;
      audioMimeType: string;
      audioBytes: number;
      transcriptUrl: string;
      chapterUrl: string;
    }
  | {
      pageMode: "premium_teaser";
    }
);

export async function publishEpisodeNewsSnapshot(
  env: PodcastEnv,
  episodeId: string,
  expectedRevision: number
): Promise<{ published: boolean; dryRun: boolean; commitSha?: string }> {
  const episode = await env.DB
    .prepare(
      `SELECT
         e.id, s.slug AS show_slug, e.slug, e.title, e.summary, e.access,
         e.public_at,
         e.canonical_url, e.duration_seconds, e.audio_mime_type, e.audio_bytes,
         e.publication_revision
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       WHERE e.id = ?
         AND e.status = 'published'
         AND e.public_at <= ${SQL_UTC_NOW_RFC3339}
         AND e.access IN ('public', 'early_access', 'premium_bonus', 'free_mini')
         AND e.media_status = 'ready'
         AND EXISTS (
           SELECT 1
           FROM delivery_audio_jobs delivery
           JOIN episode_working_master_states master_state
             ON master_state.episode_id = e.id
            AND master_state.current_master_id = delivery.source_master_id
           WHERE delivery.episode_id = e.id
             AND delivery.status = 'approved'
             AND delivery.stream_profile =
               'mp3-44100-stereo-cbr128-frame-v1'
             AND delivery.output_object_key = e.audio_key
             AND delivery.output_object_bytes = e.audio_bytes
             AND delivery.output_object_etag = e.audio_etag
             AND delivery.output_sha256 IS NOT NULL
             AND delivery.peaks_sha256 IS NOT NULL
             AND delivery.peaks_object_bytes > 0
             AND delivery.peaks_length > 0
         )`
    )
    .bind(episodeId)
    .first<PublicationEpisode>();
  if (!episode || episode.publication_revision !== expectedRevision) {
    throw new Error("Published episode revision is not available for News");
  }
  if (String(env.GITHUB_PUBLISH_MODE) !== "live") {
    return { published: false, dryRun: true };
  }
  if (!env.GITHUB_TOKEN) throw new Error("GitHub publishing is not configured");

  const current = await getPublicationFile(env);
  const publications = current.publications.filter(({ id }) => id !== episode.id);
  publications.push(buildEpisodeNewsPublication(episode, {
    mediaOrigin: env.MEDIA_ORIGIN,
    feedOrigin: env.FEED_ORIGIN
  }));
  publications.sort((left, right) =>
    String(right.publicAt).localeCompare(String(left.publicAt))
  );
  const payload = `${JSON.stringify(publications, null, 2)}\n`;
  const result = await writeGitHubContentFile(env, {
    path: PUBLICATION_DATA_PATH,
    content: payload,
    sha: current.sha,
    message: `Publish podcast episode ${episode.show_slug}/${episode.slug}`
  });
  return { published: true, dryRun: false, commitSha: result.commitSha };
}

export function buildEpisodeNewsPublication(
  episode: PublicationEpisode,
  origins: {
    mediaOrigin: string;
    feedOrigin: string;
  }
): EpisodeNewsPublication {
  const plan = planEpisodePublication({
    access: episode.access,
    videoSourceKey: null
  });
  const common = {
    publicationSchemaVersion: 1 as const,
    pageMode: plan.newsMode,
    id: episode.id,
    showSlug: episode.show_slug,
    slug: episode.slug,
    title: episode.title,
    summary: episode.summary,
    publicAt: episode.public_at,
    url: new URL(episode.canonical_url).pathname,
    canonicalUrl: episode.canonical_url,
    subscribeUrl: `/podcasts/${episode.show_slug}/#podcast-membership`,
    publicationRevision: episode.publication_revision
  };
  if (plan.newsMode === "premium_teaser") {
    return {
      ...common,
      pageMode: "premium_teaser"
    };
  }
  return {
    ...common,
    pageMode: "full_episode",
    duration: episode.duration_seconds,
    audioUrl:
      `${origins.mediaOrigin.replace(/\/$/, "")}/episodes/${episode.id}/audio`,
    downloadUrl:
      `${origins.mediaOrigin.replace(/\/$/, "")}/episodes/${episode.id}/audio?download=1`,
    peaksUrl:
      `${origins.mediaOrigin.replace(/\/$/, "")}/episodes/${episode.id}/peaks`,
    audioMimeType: episode.audio_mime_type,
    audioBytes: episode.audio_bytes,
    transcriptUrl:
      `${origins.feedOrigin.replace(/\/$/, "")}/v1/shows/`
      + `${episode.show_slug}/episodes/${episode.slug}/transcripts`,
    chapterUrl:
      `${origins.feedOrigin.replace(/\/$/, "")}/v1/shows/`
      + `${episode.show_slug}/episodes/${episode.slug}/chapters.json`
  };
}

async function getPublicationFile(
  env: PodcastEnv
): Promise<{
  publications: Array<Record<string, unknown> & { id: string }>;
  sha?: string;
}> {
  const current = await readGitHubContentFile(env, PUBLICATION_DATA_PATH);
  if (!current) return { publications: [] };
  const parsed = JSON.parse(current.content) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Podcast publication data is invalid");
  return {
    publications: parsed.filter(
      (value): value is Record<string, unknown> & { id: string } =>
        Boolean(value)
        && typeof value === "object"
        && typeof (value as { id?: unknown }).id === "string"
    ),
    sha: current.sha
  };
}
