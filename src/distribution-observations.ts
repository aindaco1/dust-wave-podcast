import type { PodcastEnv } from "./env";
import { PUBLIC_FEED_VALIDATOR_VERSION } from "./feed-validation";
import {
  recordDistributionObservation,
  type DistributionObservationPublication
} from "./distribution-observation-store";

const MAXIMUM_PROBES_PER_RUN = 4;
const MAXIMUM_REDIRECTS = 3;
const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

const DIRECTORY_HOSTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    spotify: Object.freeze(["open.spotify.com"]),
    apple_podcasts: Object.freeze(["podcasts.apple.com"]),
    youtube_music: Object.freeze(["music.youtube.com", "youtube.com"]),
    amazon_music: Object.freeze(["music.amazon.com", "amazon.com"]),
    pocket_casts: Object.freeze(["pocketcasts.com", "pca.st"]),
    overcast: Object.freeze(["overcast.fm"]),
    castbox: Object.freeze(["castbox.fm"]),
    podcast_addict: Object.freeze(["podcastaddict.com"]),
    player_fm: Object.freeze(["player.fm"]),
    iheartradio: Object.freeze(["iheart.com"]),
    deezer: Object.freeze(["deezer.com"])
  });

type DistributionObservationCandidateRow = {
  publication_id: string;
  show_id: string;
  show_title: string;
  episode_id: string;
  episode_title: string;
  destination_id: string;
  publication_revision: number;
  publication_status: string;
  evidence_url: string | null;
  evidence_source: string | null;
  last_error: string | null;
  listing_url: string;
};

export type DistributionListingProbeResult =
  | { status: "observed"; evidenceUrl: string; error: null }
  | { status: "failed"; evidenceUrl: null; error: string };

export async function scheduleAutomaticDistributionObservations(
  env: PodcastEnv,
  fetcher: typeof fetch = fetch
): Promise<number> {
  if (
    env.ENVIRONMENT !== "staging"
    || env.DISTRIBUTION_OBSERVATION_MODE !== "staging_probe"
  ) {
    return 0;
  }
  let candidates: D1Result<DistributionObservationCandidateRow>;
  try {
    candidates = await env.DB.prepare(
      `SELECT
         publication.id AS publication_id,
         episode.show_id,
         show.title AS show_title,
         episode.id AS episode_id,
         episode.title AS episode_title,
         publication.destination_id,
         publication.publication_revision,
         publication.status AS publication_status,
         publication.evidence_url,
         publication.evidence_source,
         publication.last_error,
         setup.listing_url
       FROM episode_publications publication
       JOIN episodes episode ON episode.id = publication.episode_id
       JOIN shows show ON show.id = episode.show_id
       JOIN show_distribution_destinations setup
         ON setup.show_id = episode.show_id
        AND setup.destination_id = publication.destination_id
       JOIN show_feed_validations feed ON feed.show_id = episode.show_id
       WHERE publication.publication_revision = episode.publication_revision
         AND publication.status IN (
           'waiting_for_feed', 'processing', 'failed'
         )
         AND setup.enabled = 1
         AND setup.owner_setup_status IN ('verified', 'not_required')
         AND setup.listing_url IS NOT NULL
         AND feed.status = 'valid'
         AND feed.validator_version = ?
         AND (
           setup.last_checked_at IS NULL
           OR setup.last_checked_at <= datetime('now', '-15 minutes')
         )
       ORDER BY
         CASE publication.status WHEN 'failed' THEN 1 ELSE 0 END,
         COALESCE(setup.last_checked_at, '1970-01-01'),
         publication.updated_at,
         publication.id
       LIMIT ?`
    ).bind(
      PUBLIC_FEED_VALIDATOR_VERSION,
      MAXIMUM_PROBES_PER_RUN
    ).all<DistributionObservationCandidateRow>();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "distribution_observation_scan_failed",
      errorName: error instanceof Error ? error.name : "UnknownError"
    }));
    return 0;
  }

  let recorded = 0;
  for (const candidate of candidates.results) {
    try {
      const probe = await probeDistributionListing({
        destinationId: candidate.destination_id,
        listingUrl: candidate.listing_url,
        expectedLabels: [candidate.show_title, candidate.episode_title],
        fetcher
      });
      const publication: DistributionObservationPublication = {
        id: candidate.publication_id,
        showId: candidate.show_id,
        episodeId: candidate.episode_id,
        destinationId: candidate.destination_id,
        publicationRevision: candidate.publication_revision,
        priorStatus: candidate.publication_status,
        priorEvidenceUrl: candidate.evidence_url,
        priorError: candidate.last_error,
        priorEvidenceSource: candidate.evidence_source
      };
      const result = await recordDistributionObservation(env.DB, {
        publication,
        status: probe.status,
        evidenceUrl: probe.evidenceUrl,
        error: probe.error,
        evidenceSource: "automated_probe",
        adminUserId: null
      });
      if (result.status === "conflict") {
        throw new Error("Distribution observation changed during probe");
      }
      await env.DB.prepare(
        `UPDATE show_distribution_destinations
         SET
           last_checked_at = datetime('now'),
           last_error = ?,
           updated_at = datetime('now')
         WHERE show_id = ? AND destination_id = ?`
      ).bind(
        probe.error,
        candidate.show_id,
        candidate.destination_id
      ).run();
      if (result.status === "recorded") recorded += 1;
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "distribution_observation_failed",
        destinationId: candidate.destination_id,
        episodeId: candidate.episode_id,
        errorName: error instanceof Error ? error.name : "UnknownError"
      }));
    }
  }
  return recorded;
}

export async function probeDistributionListing({
  destinationId,
  listingUrl,
  expectedLabels,
  fetcher = fetch
}: {
  destinationId: string;
  listingUrl: string;
  expectedLabels: string[];
  fetcher?: typeof fetch;
}): Promise<DistributionListingProbeResult> {
  let currentUrl: URL;
  try {
    currentUrl = validatedDirectoryUrl(destinationId, listingUrl);
  } catch {
    return failedProbe("listing_url_not_allowlisted");
  }

  for (let redirect = 0; redirect <= MAXIMUM_REDIRECTS; redirect += 1) {
    let response: Response;
    try {
      response = await fetcher(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html,application/json;q=0.9,text/plain;q=0.8",
          "user-agent": "DustWavePodcastDirectoryObserver/1.0"
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
    } catch {
      return failedProbe("listing_probe_network_failed");
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAXIMUM_REDIRECTS) {
        return failedProbe("listing_probe_redirect_invalid");
      }
      try {
        currentUrl = validatedDirectoryUrl(
          destinationId,
          new URL(location, currentUrl).toString()
        );
      } catch {
        return failedProbe("listing_probe_redirect_not_allowlisted");
      }
      continue;
    }
    if (response.status !== 200) {
      return failedProbe(`listing_probe_http_${boundedHttpStatus(
        response.status
      )}`);
    }
    const contentType = response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      ?.toLowerCase() ?? "";
    if (![
      "text/html",
      "text/plain",
      "application/json"
    ].includes(contentType)) {
      return failedProbe("listing_probe_content_type_invalid");
    }
    let body: string;
    try {
      body = await readBoundedText(response, MAXIMUM_RESPONSE_BYTES);
    } catch {
      return failedProbe("listing_probe_response_too_large");
    }
    const searchable = normalizeSearchText(body);
    const expected = expectedLabels
      .map(normalizeSearchText)
      .filter((label) => label.length >= 4);
    if (!expected.length || !expected.some((label) => searchable.includes(label))) {
      return failedProbe("listing_probe_identity_not_confirmed");
    }
    return {
      status: "observed",
      evidenceUrl: currentUrl.toString(),
      error: null
    };
  }
  return failedProbe("listing_probe_redirect_invalid");
}

function validatedDirectoryUrl(destinationId: string, value: string): URL {
  const allowedHosts = DIRECTORY_HOSTS[destinationId];
  if (!allowedHosts) throw new TypeError("Directory is not allowlisted");
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || url.hash
    || !allowedHosts.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`)
    )
  ) {
    throw new TypeError("Directory URL is not allowlisted");
  }
  return url;
}

async function readBoundedText(
  response: Response,
  maximumBytes: number
): Promise<string> {
  if (!response.body) throw new TypeError("Response body is missing");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new RangeError("Response is too large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new RangeError("Response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false
  }).decode(bytes);
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/<[^>]*>/gu, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function boundedHttpStatus(value: number): number {
  return Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : 0;
}

function failedProbe(error: string): DistributionListingProbeResult {
  return { status: "failed", evidenceUrl: null, error };
}
