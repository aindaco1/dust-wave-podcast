import type { PodcastEnv } from "./env";

const PUBLICATION_DATA_PATH = "src/_data/podcastEpisodePublications.json";

type GitHubFile = {
  content?: string;
  encoding?: string;
  sha?: string;
};

type PublicationEpisode = {
  id: string;
  show_slug: string;
  slug: string;
  title: string;
  summary: string;
  public_at: string;
  canonical_url: string;
  duration_seconds: number;
  audio_mime_type: string;
  audio_bytes: number;
  publication_revision: number;
};

export async function publishEpisodeNewsSnapshot(
  env: PodcastEnv,
  episodeId: string,
  expectedRevision: number
): Promise<{ published: boolean; dryRun: boolean; commitSha?: string }> {
  const episode = await env.DB
    .prepare(
      `SELECT
         e.id, s.slug AS show_slug, e.slug, e.title, e.summary, e.public_at,
         e.canonical_url, e.duration_seconds, e.audio_mime_type, e.audio_bytes,
         e.publication_revision
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       WHERE e.id = ?
         AND e.status = 'published'
         AND e.public_at <= datetime('now')
         AND e.access IN ('public', 'early_access', 'free_mini')
         AND e.media_status = 'ready'`
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
  publications.push({
    id: episode.id,
    showSlug: episode.show_slug,
    slug: episode.slug,
    title: episode.title,
    summary: episode.summary,
    publicAt: episode.public_at,
    url: new URL(episode.canonical_url).pathname,
    canonicalUrl: episode.canonical_url,
    duration: episode.duration_seconds,
    audioUrl: `${env.MEDIA_ORIGIN.replace(/\/$/, "")}/episodes/${episode.id}/audio`,
    downloadUrl: `${env.MEDIA_ORIGIN.replace(/\/$/, "")}/episodes/${episode.id}/audio?download=1`,
    audioMimeType: episode.audio_mime_type,
    audioBytes: episode.audio_bytes,
    publicationRevision: episode.publication_revision
  });
  publications.sort((left, right) =>
    String(right.publicAt).localeCompare(String(left.publicAt))
  );
  const payload = `${JSON.stringify(publications, null, 2)}\n`;
  const result = await putPublicationFile(
    env,
    payload,
    current.sha,
    `Publish podcast episode ${episode.show_slug}/${episode.slug}`
  );
  return { published: true, dryRun: false, commitSha: result.commitSha };
}

async function getPublicationFile(
  env: PodcastEnv
): Promise<{
  publications: Array<Record<string, unknown> & { id: string }>;
  sha?: string;
}> {
  const response = await fetch(githubContentsUrl(env, PUBLICATION_DATA_PATH, true), {
    headers: githubHeaders(env)
  });
  if (response.status === 404) return { publications: [] };
  const data = await response.json().catch(() => ({})) as GitHubFile;
  if (!response.ok || data.encoding !== "base64" || !data.content || !data.sha) {
    throw new Error(`Unable to read Podcast publication data (${response.status})`);
  }
  const decoded = decodeBase64Utf8(data.content);
  const parsed = JSON.parse(decoded) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Podcast publication data is invalid");
  return {
    publications: parsed.filter(
      (value): value is Record<string, unknown> & { id: string } =>
        Boolean(value)
        && typeof value === "object"
        && typeof (value as { id?: unknown }).id === "string"
    ),
    sha: data.sha
  };
}

async function putPublicationFile(
  env: PodcastEnv,
  content: string,
  sha: string | undefined,
  message: string
): Promise<{ commitSha: string }> {
  const response = await fetch(githubContentsUrl(env, PUBLICATION_DATA_PATH, false), {
    method: "PUT",
    headers: {
      ...githubHeaders(env),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      message,
      content: encodeBase64Utf8(content),
      branch: env.GITHUB_REF || "main",
      ...(sha ? { sha } : {})
    })
  });
  const payload = await response.json().catch(() => ({})) as {
    commit?: { sha?: string };
  };
  if (!response.ok || !payload.commit?.sha) {
    throw new Error(`Unable to publish Podcast News snapshot (${response.status})`);
  }
  return { commitSha: payload.commit.sha };
}

function githubContentsUrl(
  env: PodcastEnv,
  path: string,
  includeRef: boolean
): string {
  const owner = env.GITHUB_OWNER || "aindaco1";
  const repo = env.GITHUB_REPO || "dust-wave-new";
  const ref = encodeURIComponent(env.GITHUB_REF || "main");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const base = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  return includeRef ? `${base}?ref=${ref}` : base;
}

function githubHeaders(env: PodcastEnv): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dust-wave-podcast-worker"
  };
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
