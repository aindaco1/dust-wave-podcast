import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import { recordAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import {
  readGitHubContentFile,
  writeGitHubContentFile
} from "./github-content";
import { privateJson } from "./http";
import {
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const SHOW_CATALOG_PATH = "src/_data/podcastShows.json";
const SHOW_EDIT_ROLES = ["super_admin", "admin"] as const;
const SHOW_PROJECTION_FIELDS = [
  "title",
  "description",
  "descriptionEn",
  "language",
  "status",
  "canonicalUrl",
  "feedArtworkUrl",
  "youtubeChannel",
  "authorName",
  "category",
  "explicit",
  "premium",
  "earlyAccess",
  "freeMiniEpisode"
] as const;

type ShowProjectionRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  description_en: string;
  language: string;
  status: string;
  artwork_url: string | null;
  canonical_url: string;
  rss_slug: string;
  youtube_channel_url: string | null;
  premium_enabled: number;
  early_access_days: number | null;
  free_mini_episode_enabled: number;
  author_name: string;
  category: string;
  explicit: number;
};

type ShowPriceRow = {
  billing_period: "month" | "year";
  amount_cents: number;
  currency: string;
};

type JsonObject = Record<string, unknown>;

export async function previewAdminShowSiteProjection(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: [...SHOW_EDIT_ROLES],
    showId
  });
  if (!auth.ok) return auth.response;
  const context = await loadProjectionContext(request, env, showId);
  if (context instanceof Response) return context;
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    presentProjectionContext(env, context)
  );
}

export async function publishAdminShowSiteProjection(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const recent = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recent) return recent;
  const body = await readJsonObject(request, 5_000);
  const expectedCatalogSha = requiredText(
    body.expectedCatalogSha,
    "expectedCatalogSha",
    64
  ).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(expectedCatalogSha)) {
    throw new RequestValidationError(
      "expectedCatalogSha must be the reviewed Git blob SHA"
    );
  }
  const confirmation = requiredText(
    body.confirmation,
    "confirmation",
    120
  );
  if (confirmation !== `PUBLISH_SHOW_CATALOG ${showId}`) {
    throw new RequestValidationError(
      `Type PUBLISH_SHOW_CATALOG ${showId} to confirm`,
      "show_site_projection_confirmation_required"
    );
  }

  const context = await loadProjectionContext(request, env, showId);
  if (context instanceof Response) return context;
  if (context.catalogSha !== expectedCatalogSha) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "show_site_projection_conflict",
        message: "The site catalog changed after the reviewed preview"
      },
      { status: 409 }
    );
  }
  if (context.blockers.length > 0) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "show_site_projection_blocked",
        blockers: context.blockers
      },
      { status: 409 }
    );
  }
  if (!context.changed) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      ...presentProjectionContext(env, context),
      published: false,
      dryRun: String(env.GITHUB_PUBLISH_MODE) !== "live",
      idempotent: true
    });
  }

  const dryRun = String(env.GITHUB_PUBLISH_MODE) !== "live";
  if (dryRun) {
    await recordAdminAudit(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "show.site_projection_dry_run",
      targetType: "show",
      targetId: showId,
      metadata: {
        catalogSha: context.catalogSha,
        changedFields: context.changedFields
      }
    });
    return privateJson(request, env.ALLOWED_ORIGINS, {
      ...presentProjectionContext(env, context),
      published: false,
      dryRun: true,
      idempotent: false
    });
  }

  const catalog = [...context.catalog];
  catalog[context.catalogIndex] = context.projectedShow;
  let commitSha: string;
  try {
    const result = await writeGitHubContentFile(env, {
      path: SHOW_CATALOG_PATH,
      content: `${JSON.stringify(catalog, null, 2)}\n`,
      sha: context.catalogSha,
      message: `Project podcast show settings for ${context.show.slug}`
    });
    commitSha = result.commitSha;
  } catch (error) {
    logProjectionFailure(error, showId, "write");
    return projectionUnavailable(request, env);
  }
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "show.site_projection_published",
    targetType: "show",
    targetId: showId,
    metadata: {
      sourceCatalogSha: context.catalogSha,
      commitSha,
      changedFields: context.changedFields
    }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    ...presentProjectionContext(env, context),
    published: true,
    dryRun: false,
    idempotent: false,
    commitSha
  });
}

export function buildProjectedSiteShow(
  currentShow: JsonObject,
  show: ShowProjectionRow,
  prices: ShowPriceRow[]
): {
  projectedShow: JsonObject;
  changedFields: string[];
  blockers: string[];
} {
  const blockers: string[] = [];
  if (currentShow.id !== show.id || currentShow.slug !== show.slug) {
    blockers.push("site_show_identity_mismatch");
  }
  for (const field of ["artwork", "wordmark", "socialImage"]) {
    if (
      typeof currentShow[field] !== "string"
      || !String(currentShow[field]).startsWith("/img/")
    ) {
      blockers.push(`site_${field}_missing`);
    }
  }
  const monthly = prices.find(
    (price) => price.billing_period === "month" && price.currency === "USD"
  );
  const annual = prices.find(
    (price) => price.billing_period === "year" && price.currency === "USD"
  );
  if (show.premium_enabled === 1 && !monthly) {
    blockers.push("active_monthly_usd_price_missing");
  }
  if (show.premium_enabled === 1 && !annual) {
    blockers.push("active_annual_usd_price_missing");
  }

  const currentPremium = jsonObject(currentShow.premium);
  const currentEarlyAccess = jsonObject(currentShow.earlyAccess);
  const currentFreeMini = jsonObject(currentShow.freeMiniEpisode);
  const projectedShow: JsonObject = {
    ...currentShow,
    title: show.title,
    description: show.description,
    descriptionEn: show.description_en,
    language: show.language,
    status: show.status,
    canonicalUrl: show.canonical_url,
    feedArtworkUrl: show.artwork_url,
    youtubeChannel: show.youtube_channel_url,
    authorName: show.author_name,
    category: show.category,
    explicit: show.explicit === 1,
    premium: {
      ...currentPremium,
      enabled: show.premium_enabled === 1,
      currency: "USD",
      ...(monthly ? { monthlyCents: monthly.amount_cents } : {}),
      ...(annual ? { annualCents: annual.amount_cents } : {})
    },
    earlyAccess: {
      ...currentEarlyAccess,
      ...(show.early_access_days === null
        ? {}
        : {
            mode: "days_before_public",
            days: show.early_access_days
          })
    },
    freeMiniEpisode: {
      ...currentFreeMini,
      enabled: show.free_mini_episode_enabled === 1
    }
  };
  const changedFields = SHOW_PROJECTION_FIELDS.filter(
    (field) => !jsonEqual(currentShow[field], projectedShow[field])
  );
  return { projectedShow, changedFields, blockers };
}

async function loadProjectionContext(
  request: Request,
  env: PodcastEnv,
  showId: string
): Promise<ProjectionContext | Response> {
  const show = await env.DB
    .prepare(
      `SELECT
         id, slug, title, description, description_en, language, status,
         artwork_url, canonical_url, rss_slug, youtube_channel_url,
         premium_enabled, early_access_days, free_mini_episode_enabled,
         author_name, category, explicit
       FROM shows
       WHERE id = ?`
    )
    .bind(showId)
    .first<ShowProjectionRow>();
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  const priceResult = await env.DB
    .prepare(
      `SELECT billing_period, amount_cents, currency
       FROM show_prices
       WHERE show_id = ? AND active = 1
       ORDER BY amount_cents`
    )
    .bind(showId)
    .all<ShowPriceRow>();

  let current;
  try {
    current = await readGitHubContentFile(env, SHOW_CATALOG_PATH);
  } catch (error) {
    logProjectionFailure(error, showId, "read");
    return projectionUnavailable(request, env);
  }
  if (!current) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_site_catalog_missing" },
      { status: 409 }
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(current.content) as unknown;
  } catch {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_site_catalog_invalid" },
      { status: 409 }
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isJsonObject)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_site_catalog_invalid" },
      { status: 409 }
    );
  }
  const indexes = parsed.flatMap((entry, index) =>
    entry.id === show.id || entry.slug === show.slug ? [index] : []
  );
  if (indexes.length !== 1) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_site_catalog_identity_conflict" },
      { status: 409 }
    );
  }
  const catalogIndex = indexes[0];
  const projection = buildProjectedSiteShow(
    parsed[catalogIndex],
    show,
    priceResult.results
  );
  return {
    catalog: parsed,
    catalogIndex,
    catalogSha: current.sha,
    show,
    ...projection,
    changed: projection.changedFields.length > 0
  };
}

type ProjectionContext = {
  catalog: JsonObject[];
  catalogIndex: number;
  catalogSha: string;
  show: ShowProjectionRow;
  projectedShow: JsonObject;
  changedFields: string[];
  blockers: string[];
  changed: boolean;
};

function presentProjectionContext(
  env: PodcastEnv,
  context: ProjectionContext
): JsonObject {
  return {
    target: {
      owner: env.GITHUB_OWNER || "aindaco1",
      repository: env.GITHUB_REPO || "dust-wave-new",
      ref: env.GITHUB_REF || "main",
      path: SHOW_CATALOG_PATH
    },
    mode: String(env.GITHUB_PUBLISH_MODE) === "live" ? "live" : "dry_run",
    showId: context.show.id,
    catalogSha: context.catalogSha,
    changed: context.changed,
    changedFields: context.changedFields,
    blockers: context.blockers
  };
}

function projectionUnavailable(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "show_site_projection_unavailable" },
    { status: 502 }
  );
}

function logProjectionFailure(
  error: unknown,
  showId: string,
  operation: "read" | "write"
): void {
  console.error(JSON.stringify({
    level: "error",
    event: "show_site_projection_failed",
    operation,
    showId,
    failureType: error instanceof Error ? error.name : "unknown"
  }));
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
