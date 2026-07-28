import {
  hmacSha256,
  sha256Hex
} from "@dustwave/worker-core/crypto";
import {
  requireAdmin,
  type AdminRole
} from "./admin-auth";
import { adminCsvResponse } from "./admin-csv";
import type { PodcastEnv } from "./env";
import {
  privateJson,
  trustedAllowedOrigin
} from "./http";
import { SQL_UTC_NOW_RFC3339 } from "./sql-time";
import {
  readJsonObject,
  RequestValidationError,
  validIdentifier
} from "./validation";

const METHODOLOGY_VERSION = "dustwave-analytics-v1";
const ANALYTICS_UNIQUE_RETENTION_DAYS = 35;
const ANALYTICS_ROLLUP_RETENTION_DAYS = 400;
const READ_ROLES: AdminRole[] = [
  "super_admin",
  "admin",
  "producer",
  "analyst"
];
const VALID_WINDOWS = new Set([7, 30, 90]);
const BOT_PATTERN =
  /(bot|spider|crawler|slurp|headless|preview|monitor|uptime|curl|wget|python-requests)/i;
const WATCH_OS_PATTERN = /\b(?:watch\s?os|watch\d+,\d+)\b/i;

type AnalyticsEventType = "qualified_download" | "engaged_play";
type AnalyticsTelemetryEventType =
  | AnalyticsEventType
  | "web_player_completion";
type ProgressMilestone = 25 | 50 | 75 | 100;
type AnalyticsDimensions = {
  appCode: string;
  countryCode: string;
  deviceCode: string;
};
type AnalyticsEpisode = {
  id: string;
  showId: string;
  durationSeconds: number | null;
  audioBytes: number;
};
type MediaDelivery = {
  bytesServed: number;
  status: 200 | 206;
};
type RollupRow = {
  event_type: AnalyticsEventType;
  window_date: string;
  episode_id: string;
  episode_title: string;
  app_code: string;
  device_code: string;
  country_code: string;
  event_count: number;
};
type ProgressRollupRow = {
  window_date: string;
  episode_id: string;
  episode_title: string;
  milestone_percent: ProgressMilestone;
  event_count: number;
};

export async function recordPodcastMediaDelivery(
  request: Request,
  env: PodcastEnv,
  episode: AnalyticsEpisode,
  delivery: MediaDelivery
): Promise<void> {
  if (request.method !== "GET") return;
  const identity = analyticsIdentity(request);
  if (!identity) return;
  const dimensions = analyticsDimensions(request, identity.userAgent);
  const qualifies = qualifiedMediaDelivery(episode, delivery);
  writeAnalyticsEngine(env, {
    eventType: "qualified_download",
    episode,
    dimensions,
    eventCount: qualifies ? 1 : 0,
    status: delivery.status,
    bytes: delivery.bytesServed
  });
  if (!qualifies || !env.ANALYTICS_HASH_SECRET) return;
  await recordUniqueEvent(
    env,
    "qualified_download",
    episode,
    dimensions,
    identity,
    env.ANALYTICS_HASH_SECRET
  );
}

export async function recordPodcastPlayerEvent(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  if (!trustedAllowedOrigin(request, env.ALLOWED_ORIGINS)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "origin_not_allowed" },
      { status: 403 }
    );
  }
  const body = await readJsonObject(request, 2_048);
  const episodeId = validIdentifier(body.episodeId, "episodeId");
  if (
    body.event !== "engaged_play"
    && body.event !== "web_player_completion"
  ) {
    throw new RequestValidationError("event is invalid");
  }
  const seconds = Number(body.seconds);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 86_400) {
    throw new RequestValidationError("seconds must be between 60 and 86400");
  }
  const milestones = body.event === "web_player_completion"
    ? progressMilestones(body.milestones)
    : [];
  const episode = await env.DB.prepare(
    `SELECT
       id, show_id, duration_seconds, audio_bytes
     FROM episodes
     WHERE id = ?
       AND status = 'published'
       AND public_at <= ${SQL_UTC_NOW_RFC3339}
       AND access IN ('public', 'early_access', 'free_mini')
       AND media_status = 'ready'
       AND audio_key IS NOT NULL`
  ).bind(episodeId).first<{
    id: string;
    show_id: string;
    duration_seconds: number | null;
    audio_bytes: number;
  }>();
  if (!episode) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_found" },
      { status: 404 }
    );
  }
  if (body.event === "web_player_completion") {
    validateProgressThresholds(
      milestones,
      seconds,
      episode.duration_seconds
    );
  }
  const identity = analyticsIdentity(request);
  if (identity) {
    const dimensions = analyticsDimensions(request, identity.userAgent);
    const analyticsEpisode = {
      id: episode.id,
      showId: episode.show_id,
      durationSeconds: episode.duration_seconds,
      audioBytes: Number(episode.audio_bytes)
    };
    if (body.event === "engaged_play") {
      writeAnalyticsEngine(env, {
        eventType: "engaged_play",
        episode: analyticsEpisode,
        dimensions,
        eventCount: 1,
        status: 202,
        bytes: 0
      });
      if (env.ANALYTICS_HASH_SECRET) {
        await recordUniqueEvent(
          env,
          "engaged_play",
          analyticsEpisode,
          dimensions,
          identity,
          env.ANALYTICS_HASH_SECRET
        );
      }
    } else {
      for (const milestonePercent of milestones) {
        writeAnalyticsEngine(env, {
          eventType: "web_player_completion",
          episode: analyticsEpisode,
          dimensions,
          eventCount: 1,
          status: 202,
          bytes: 0,
          milestonePercent
        });
      }
      if (env.ANALYTICS_HASH_SECRET) {
        await recordUniqueProgress(
          env,
          analyticsEpisode,
          milestones,
          identity,
          env.ANALYTICS_HASH_SECRET
        );
      }
    }
  }
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { accepted: true },
    { status: 202 }
  );
}

export async function getAdminPodcastAnalyticsOverview(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const days = analyticsWindow(request);
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES,
    showId
  });
  if (!auth.ok) return auth.response;
  const overview = await loadAnalyticsOverview(env.DB, showId, days);
  return privateJson(request, env.ALLOWED_ORIGINS, overview);
}

export async function exportAdminPodcastAnalyticsCsv(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const days = analyticsWindow(request);
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES,
    showId
  });
  if (!auth.ok) return auth.response;
  const overview = await loadAnalyticsOverview(env.DB, showId, days);
  return adminCsvResponse(request, env.ALLOWED_ORIGINS, {
    filename: `podcast-analytics-${showId}-${days}d.csv`,
    columns: [
      "date",
      "qualified_downloads",
      "engaged_plays",
      "web_player_completion_25",
      "web_player_completion_50",
      "web_player_completion_75",
      "web_player_completion_100",
      "methodology_version"
    ],
    rows: overview.daily.map((day) => ({
      date: day.date,
      qualified_downloads: day.qualifiedDownloads,
      engaged_plays: day.engagedPlays,
      web_player_completion_25: day.webPlayerCompletion[25],
      web_player_completion_50: day.webPlayerCompletion[50],
      web_player_completion_75: day.webPlayerCompletion[75],
      web_player_completion_100: day.webPlayerCompletion[100],
      methodology_version: METHODOLOGY_VERSION
    }))
  });
}

export async function cleanupPodcastAnalytics(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM podcast_analytics_uniques
       WHERE expires_at <= datetime('now')`
    ),
    db.prepare(
      `DELETE FROM podcast_analytics_rollups
       WHERE window_date < date('now', ?)`
    ).bind(`-${ANALYTICS_ROLLUP_RETENTION_DAYS} days`),
    db.prepare(
      `DELETE FROM podcast_analytics_progress_uniques
       WHERE expires_at <= datetime('now')`
    ),
    db.prepare(
      `DELETE FROM podcast_analytics_progress_rollups
       WHERE window_date < date('now', ?)`
    ).bind(`-${ANALYTICS_ROLLUP_RETENTION_DAYS} days`)
  ]);
}

function analyticsWindow(request: Request): number {
  const raw = new URL(request.url).searchParams.get("days") ?? "30";
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || !VALID_WINDOWS.has(days)) {
    throw new RequestValidationError("days must be 7, 30, or 90");
  }
  return days;
}

async function loadAnalyticsOverview(
  db: D1Database,
  showId: string,
  days: number
) {
  const startDate = utcDateOffset(-(days - 1));
  const endDate = utcDateOffset(0);
  const [rollups, progressRollups, premiumRow] = await Promise.all([
    db.prepare(
      `SELECT
         rollup.event_type, rollup.window_date, rollup.episode_id,
         episode.title AS episode_title, rollup.app_code,
         rollup.device_code, rollup.country_code,
         SUM(rollup.event_count) AS event_count
       FROM podcast_analytics_rollups rollup
       JOIN episodes episode ON episode.id = rollup.episode_id
       WHERE rollup.show_id = ?
         AND rollup.methodology_version = ?
         AND rollup.window_date BETWEEN ? AND ?
       GROUP BY
         rollup.event_type, rollup.window_date, rollup.episode_id,
         episode.title, rollup.app_code, rollup.device_code,
         rollup.country_code`
    ).bind(
      showId,
      METHODOLOGY_VERSION,
      startDate,
      endDate
    ).all<RollupRow>(),
    db.prepare(
      `SELECT
         progress.window_date, progress.episode_id,
         episode.title AS episode_title, progress.milestone_percent,
         SUM(progress.event_count) AS event_count
       FROM podcast_analytics_progress_rollups progress
       JOIN episodes episode ON episode.id = progress.episode_id
       WHERE progress.show_id = ?
         AND progress.methodology_version = ?
         AND progress.window_date BETWEEN ? AND ?
       GROUP BY
         progress.window_date, progress.episode_id, episode.title,
         progress.milestone_percent`
    ).bind(
      showId,
      METHODOLOGY_VERSION,
      startDate,
      endDate
    ).all<ProgressRollupRow>(),
    db.prepare(
      `SELECT COUNT(DISTINCT listener_id) AS listener_count
       FROM subscriptions
       WHERE show_id = ?
         AND status = 'active'
         AND (
           current_period_end IS NULL
           OR current_period_end > ${SQL_UTC_NOW_RFC3339}
         )`
    ).bind(showId).first<{ listener_count: number }>()
  ]);
  const daily = Array.from({ length: days }, (_, index) => ({
    date: utcDateOffset(-(days - index - 1)),
    qualifiedDownloads: 0,
    engagedPlays: 0,
    webPlayerCompletion: emptyProgressCounts()
  }));
  const dailyByDate = new Map(daily.map((row) => [row.date, row]));
  const episodeMap = new Map<string, {
    episodeId: string;
    title: string;
    qualifiedDownloads: number;
    engagedPlays: number;
    webPlayerCompletion: Record<ProgressMilestone, number>;
  }>();
  const appMap = new Map<string, number>();
  const deviceMap = new Map<string, number>();
  const countryMap = new Map<string, number>();
  let qualifiedDownloads = 0;
  let engagedPlays = 0;
  const webPlayerCompletion = emptyProgressCounts();

  for (const row of rollups.results) {
    const count = Number(row.event_count ?? 0);
    const dailyRow = dailyByDate.get(row.window_date);
    const episodeRow = episodeMap.get(row.episode_id) ?? {
      episodeId: row.episode_id,
      title: row.episode_title,
      qualifiedDownloads: 0,
      engagedPlays: 0,
      webPlayerCompletion: emptyProgressCounts()
    };
    if (row.event_type === "qualified_download") {
      qualifiedDownloads += count;
      if (dailyRow) dailyRow.qualifiedDownloads += count;
      episodeRow.qualifiedDownloads += count;
      increment(appMap, row.app_code, count);
      increment(deviceMap, row.device_code, count);
      increment(countryMap, row.country_code, count);
    } else {
      engagedPlays += count;
      if (dailyRow) dailyRow.engagedPlays += count;
      episodeRow.engagedPlays += count;
    }
    episodeMap.set(row.episode_id, episodeRow);
  }

  for (const row of progressRollups.results) {
    const count = Number(row.event_count ?? 0);
    const milestone = Number(row.milestone_percent) as ProgressMilestone;
    if (!isProgressMilestone(milestone)) continue;
    webPlayerCompletion[milestone] += count;
    const dailyRow = dailyByDate.get(row.window_date);
    if (dailyRow) dailyRow.webPlayerCompletion[milestone] += count;
    const episodeRow = episodeMap.get(row.episode_id) ?? {
      episodeId: row.episode_id,
      title: row.episode_title,
      qualifiedDownloads: 0,
      engagedPlays: 0,
      webPlayerCompletion: emptyProgressCounts()
    };
    episodeRow.webPlayerCompletion[milestone] += count;
    episodeMap.set(row.episode_id, episodeRow);
  }

  return {
    showId,
    range: { days, startDate, endDate, timeZone: "UTC" },
    methodology: {
      version: METHODOLOGY_VERSION,
      certification: "not_iab_certified",
      deduplicationWindow: "fixed_utc_calendar_day",
      qualifiedDownload:
        "One eligible GET per episode and privacy-minimized network plus user-agent key per UTC day when a 200 response or one 206 response contains at least an estimated minute of audio. HEAD, byte probes, known bots, command-line clients, and watchOS traffic are excluded.",
      engagedPlay:
        "One first-party Dust Wave web-player event per episode and privacy-minimized network plus user-agent key per UTC day after at least 60 cumulative seconds of foreground playback.",
      webPlayerCompletion:
        "First-party Dust Wave web-player completion counts use cumulative foreground playback time, not playhead position. A daily episode listener is counted once at each reached 25%, 50%, 75%, or 100% milestone after the 60-second engagement threshold.",
      caveat:
        "This provisional first-party method estimates download duration from file bytes, does not reassemble ranges or confirm transfer completion, cannot measure playback completion in third-party podcast apps, and must not be represented as IAB certification."
    },
    totals: {
      qualifiedDownloads,
      engagedPlays,
      activePremiumListeners: Number(premiumRow?.listener_count ?? 0)
    },
    daily,
    episodes: [...episodeMap.values()]
      .map((episode) => ({
        ...episode,
        webPlayerCompletionRates: progressRates(
          episode.webPlayerCompletion,
          episode.engagedPlays
        )
      }))
      .sort((left, right) =>
        right.qualifiedDownloads - left.qualifiedDownloads
        || right.engagedPlays - left.engagedPlays
        || left.title.localeCompare(right.title)
      )
      .slice(0, 20),
    webPlayerCompletion: {
      scope: "dust_wave_web_player_only",
      cohort: "engaged_plays",
      engagedPlays,
      counts: webPlayerCompletion,
      rates: progressRates(webPlayerCompletion, engagedPlays)
    },
    breakdowns: {
      apps: sortedBreakdown(appMap, 20),
      devices: sortedBreakdown(deviceMap, 20),
      countries: sortedBreakdown(countryMap, 20)
    },
    generatedAt: new Date().toISOString()
  };
}

async function recordUniqueEvent(
  env: PodcastEnv,
  eventType: AnalyticsEventType,
  episode: AnalyticsEpisode,
  dimensions: AnalyticsDimensions,
  identity: { network: string; userAgent: string },
  analyticsHashSecret: string
): Promise<void> {
  const windowDate = utcDateOffset(0);
  const identityKey = await hmacSha256(
    [
      METHODOLOGY_VERSION,
      eventType,
      windowDate,
      episode.id,
      identity.network,
      identity.userAgent
    ].join("\0"),
    analyticsHashSecret,
    "hex"
  );
  const rollupId = await sha256Hex([
    METHODOLOGY_VERSION,
    eventType,
    windowDate,
    episode.showId,
    episode.id,
    dimensions.appCode,
    dimensions.deviceCode,
    dimensions.countryCode
  ].join("\0"));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO podcast_analytics_uniques (
         unique_key, methodology_version, event_type, window_date,
         show_id, episode_id, app_code, device_code, country_code,
         expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
    ).bind(
      identityKey,
      METHODOLOGY_VERSION,
      eventType,
      windowDate,
      episode.showId,
      episode.id,
      dimensions.appCode,
      dimensions.deviceCode,
      dimensions.countryCode,
      `+${ANALYTICS_UNIQUE_RETENTION_DAYS} days`
    ),
    env.DB.prepare(
      `INSERT INTO podcast_analytics_rollups (
         id, methodology_version, event_type, window_date,
         show_id, episode_id, app_code, device_code, country_code,
         event_count
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
       WHERE changes() = 1
       ON CONFLICT(id) DO UPDATE SET
         event_count = event_count + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).bind(
      rollupId,
      METHODOLOGY_VERSION,
      eventType,
      windowDate,
      episode.showId,
      episode.id,
      dimensions.appCode,
      dimensions.deviceCode,
      dimensions.countryCode
    )
  ]);
}

async function recordUniqueProgress(
  env: PodcastEnv,
  episode: AnalyticsEpisode,
  milestones: ProgressMilestone[],
  identity: { network: string; userAgent: string },
  analyticsHashSecret: string
): Promise<void> {
  const windowDate = utcDateOffset(0);
  const hashes = await Promise.all(milestones.map(async (milestone) => ({
    milestone,
    identityKey: await hmacSha256(
      [
        METHODOLOGY_VERSION,
        "web_player_completion",
        milestone,
        windowDate,
        episode.id,
        identity.network,
        identity.userAgent
      ].join("\0"),
      analyticsHashSecret,
      "hex"
    ),
    rollupId: await sha256Hex([
      METHODOLOGY_VERSION,
      "web_player_completion",
      milestone,
      windowDate,
      episode.showId,
      episode.id
    ].join("\0"))
  })));
  await env.DB.batch(hashes.flatMap((hash) => [
    env.DB.prepare(
      `INSERT OR IGNORE INTO podcast_analytics_progress_uniques (
         unique_key, methodology_version, window_date, show_id,
         episode_id, milestone_percent, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`
    ).bind(
      hash.identityKey,
      METHODOLOGY_VERSION,
      windowDate,
      episode.showId,
      episode.id,
      hash.milestone,
      `+${ANALYTICS_UNIQUE_RETENTION_DAYS} days`
    ),
    env.DB.prepare(
      `INSERT INTO podcast_analytics_progress_rollups (
         id, methodology_version, window_date, show_id, episode_id,
         milestone_percent, event_count
       )
       SELECT ?, ?, ?, ?, ?, ?, 1
       WHERE changes() = 1
       ON CONFLICT(id) DO UPDATE SET
         event_count = event_count + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).bind(
      hash.rollupId,
      METHODOLOGY_VERSION,
      windowDate,
      episode.showId,
      episode.id,
      hash.milestone
    )
  ]));
}

function qualifiedMediaDelivery(
  episode: AnalyticsEpisode,
  delivery: MediaDelivery
): boolean {
  if (delivery.status === 200) return delivery.bytesServed >= minuteByteThreshold(episode);
  return delivery.bytesServed >= minuteByteThreshold(episode);
}

function minuteByteThreshold(episode: AnalyticsEpisode): number {
  const bytes = Math.max(0, Number(episode.audioBytes) || 0);
  const duration = Number(episode.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return bytes;
  return Math.max(1, Math.ceil(bytes * Math.min(60, duration) / duration));
}

function analyticsIdentity(
  request: Request
): { network: string; userAgent: string } | null {
  const userAgent = (request.headers.get("user-agent") ?? "").trim().slice(0, 512);
  if (!userAgent || BOT_PATTERN.test(userAgent) || WATCH_OS_PATTERN.test(userAgent)) {
    return null;
  }
  const network = normalizedNetwork(
    request.headers.get("cf-connecting-ip") ?? ""
  );
  if (!network) return null;
  return { network, userAgent };
}

function normalizedNetwork(raw: string): string {
  const value = raw.trim().toLowerCase().split("%")[0];
  const ipv4 = value.split(".");
  if (
    ipv4.length === 4
    && ipv4.every((part) =>
      /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255
    )
  ) {
    return ipv4.map((part) => String(Number(part))).join(".");
  }
  if (!value.includes(":")) return "";
  const halves = value.split("::");
  if (halves.length > 2) return "";
  const parseHalf = (half: string): string[] =>
    half ? half.split(":").filter(Boolean) : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))
    || (halves.length === 1 && left.length !== 8)
    || left.length + right.length > 8
  ) {
    return "";
  }
  const expanded = halves.length === 2
    ? [
      ...left,
      ...Array(8 - left.length - right.length).fill("0"),
      ...right
    ]
    : left;
  return `${expanded.slice(0, 4).map((part) =>
    Number.parseInt(part, 16).toString(16)
  ).join(":")}::/64`;
}

function analyticsDimensions(
  request: Request,
  userAgent: string
): AnalyticsDimensions {
  return {
    appCode: appCode(userAgent),
    deviceCode: deviceCode(userAgent),
    countryCode: countryCode(request)
  };
}

function appCode(userAgent: string): string {
  const value = userAgent.toLowerCase();
  if (value.includes("podcasts/") || value.includes("applecoremedia")) return "apple_podcasts";
  if (value.includes("spotify")) return "spotify";
  if (value.includes("overcast")) return "overcast";
  if (value.includes("pocket casts") || value.includes("pocketcasts")) return "pocket_casts";
  if (value.includes("castbox")) return "castbox";
  if (value.includes("podcast addict")) return "podcast_addict";
  if (value.includes("player fm") || value.includes("playerfm")) return "player_fm";
  if (value.includes("iheart")) return "iheart";
  if (value.includes("audible")) return "audible";
  if (value.includes("amazon")) return "amazon_music";
  if (value.includes("youtube")) return "youtube_music";
  if (/\b(?:mozilla|safari|chrome|firefox|edg)\b/i.test(userAgent)) return "browser";
  return "other";
}

function deviceCode(userAgent: string): string {
  if (/ipad|tablet|kindle|silk/i.test(userAgent)) return "tablet";
  if (/iphone|ipod|android.+mobile|mobile/i.test(userAgent)) return "mobile";
  if (/alexa|echo|homepod|smart.?speaker/i.test(userAgent)) return "smart_speaker";
  if (/windows|macintosh|x11|linux/i.test(userAgent)) return "desktop";
  return "other";
}

function countryCode(request: Request): string {
  const value = String(request.cf?.country ?? "").toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : "ZZ";
}

function writeAnalyticsEngine(
  env: PodcastEnv,
  event: {
    eventType: AnalyticsTelemetryEventType;
    episode: AnalyticsEpisode;
    dimensions: AnalyticsDimensions;
    eventCount: number;
    status: number;
    bytes: number;
    milestonePercent?: ProgressMilestone;
  }
): void {
  try {
    env.ANALYTICS.writeDataPoint({
      indexes: [event.episode.showId],
      blobs: [
        METHODOLOGY_VERSION,
        event.eventType,
        event.episode.id,
        event.dimensions.appCode,
        event.dimensions.deviceCode,
        event.dimensions.countryCode,
        utcDateOffset(0)
      ],
      doubles: [
        event.eventCount,
        event.status,
        event.bytes,
        event.milestonePercent ?? 0
      ]
    });
  } catch {
    // Analytics is intentionally best effort and must never affect playback.
  }
}

function progressMilestones(value: unknown): ProgressMilestone[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new RequestValidationError(
      "milestones must contain one through four completion thresholds"
    );
  }
  const milestones = value.map(Number);
  if (
    milestones.some((milestone) => !isProgressMilestone(milestone))
    || new Set(milestones).size !== milestones.length
    || milestones.some((milestone, index) =>
      index > 0 && milestone <= milestones[index - 1]
    )
  ) {
    throw new RequestValidationError(
      "milestones must be unique ascending values from 25, 50, 75, and 100"
    );
  }
  return milestones as ProgressMilestone[];
}

function validateProgressThresholds(
  milestones: ProgressMilestone[],
  seconds: number,
  durationSeconds: number | null
): void {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RequestValidationError(
      "episode duration is required for completion analytics"
    );
  }
  const highest = milestones[milestones.length - 1];
  if (seconds + 2 < duration * highest / 100) {
    throw new RequestValidationError(
      "seconds do not reach the highest completion milestone"
    );
  }
}

function isProgressMilestone(value: number): value is ProgressMilestone {
  return value === 25 || value === 50 || value === 75 || value === 100;
}

function emptyProgressCounts(): Record<ProgressMilestone, number> {
  return { 25: 0, 50: 0, 75: 0, 100: 0 };
}

function progressRates(
  counts: Record<ProgressMilestone, number>,
  engagedPlays: number
): Record<ProgressMilestone, number | null> {
  const denominator = Number(engagedPlays);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return { 25: null, 50: null, 75: null, 100: null };
  }
  return {
    25: Math.min(1, counts[25] / denominator),
    50: Math.min(1, counts[50] / denominator),
    75: Math.min(1, counts[75] / denominator),
    100: Math.min(1, counts[100] / denominator)
  };
}

function utcDateOffset(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function increment(map: Map<string, number>, key: string, count: number): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

function sortedBreakdown(
  map: Map<string, number>,
  limit: number
): Array<{ code: string; count: number }> {
  return [...map.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) =>
      right.count - left.count || left.code.localeCompare(right.code)
    )
    .slice(0, limit);
}
