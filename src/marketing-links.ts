import {
  buildTaggedMarketingUrl,
  normalizeMarketingReferralCode
} from "@dustwave/admin-shell/marketing-assets";

import {
  requireAdmin,
  type AdminRole
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  boundedPageSize,
  optionalText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const READ_ROLES: AdminRole[] = [
  "super_admin",
  "admin",
  "producer",
  "analyst"
];
const WRITE_ROLES: AdminRole[] = [
  "super_admin",
  "admin",
  "producer"
];
const DEFAULT_PAGE_SIZE = 20;

type MarketingLinkRow = {
  id: string;
  show_id: string;
  code: string;
  label: string;
  canonical_url: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  referral_code: string;
  tagged_url: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

type ShowMarketingTarget = {
  id: string;
  canonical_url: string;
};

export async function listAdminMarketingLinks(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const url = new URL(request.url);
  const limit = boundedPageSize(
    url.searchParams.get("limit"),
    DEFAULT_PAGE_SIZE
  );
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue
    ? validIdentifier(cursorValue, "cursor")
    : null;
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES,
    showId
  });
  if (!auth.ok) return auth.response;

  const show = await loadShowMarketingTarget(env.DB, showId);
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  const cursorRow = cursor
    ? await env.DB.prepare(
      `SELECT id, updated_at
       FROM podcast_marketing_links
       WHERE id = ? AND show_id = ?`
    ).bind(cursor, showId).first<{ id: string; updated_at: string }>()
    : null;
  if (cursor && !cursorRow) {
    throw new RequestValidationError("cursor is invalid");
  }

  const cursorClause = cursorRow
    ? `AND (
         updated_at < ?
         OR (updated_at = ? AND id < ?)
       )`
    : "";
  const statement = env.DB.prepare(
    `SELECT
       id, show_id, code, label, canonical_url,
       utm_source, utm_medium, utm_campaign, utm_content,
       referral_code, tagged_url, revision, created_at, updated_at
     FROM podcast_marketing_links
     WHERE show_id = ?
     ${cursorClause}
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`
  );
  const page = cursorRow
    ? await statement.bind(
      showId,
      cursorRow.updated_at,
      cursorRow.updated_at,
      cursorRow.id,
      limit + 1
    ).all<MarketingLinkRow>()
    : await statement.bind(showId, limit + 1).all<MarketingLinkRow>();
  const hasMore = page.results.length > limit;
  const rows = page.results.slice(0, limit);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    showId,
    links: rows.map(presentMarketingLink),
    pagination: {
      limit,
      nextCursor: hasMore ? rows.at(-1)?.id ?? null : null
    }
  });
}

export async function saveAdminMarketingLink(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: WRITE_ROLES,
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const body = await readJsonObject(request, 16_000);
  const show = await loadShowMarketingTarget(env.DB, showId);
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  const input = normalizeMarketingLinkInput(body, show.canonical_url);
  const existingId = body.id
    ? validIdentifier(body.id, "id")
    : null;
  const expectedUpdatedAt = existingId
    ? requiredText(body.expectedUpdatedAt, "expectedUpdatedAt", 80)
    : "";
  const conflicting = await env.DB.prepare(
    `SELECT id
     FROM podcast_marketing_links
     WHERE show_id = ? AND code = ? AND (? IS NULL OR id != ?)`
  ).bind(showId, input.code, existingId, existingId)
    .first<{ id: string }>();
  if (conflicting) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "marketing_link_code_conflict" },
      { status: 409 }
    );
  }

  const actorId = auth.authorization.identity.id;
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  if (!existingId) {
    const linkId = `marketing_link_${crypto.randomUUID().replace(/-/g, "")}`;
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO podcast_marketing_links (
           id, show_id, code, label, canonical_url,
           utm_source, utm_medium, utm_campaign, utm_content,
           referral_code, tagged_url,
           created_by_admin_user_id, updated_by_admin_user_id
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1
           FROM podcast_marketing_links
           WHERE show_id = ? AND code = ?
         )`
      ).bind(
        linkId,
        showId,
        input.code,
        input.label,
        input.canonicalUrl,
        input.utmSource,
        input.utmMedium,
        input.utmCampaign,
        input.utmContent,
        input.referralCode,
        input.taggedUrl,
        actorId,
        actorId,
        showId,
        input.code
      ),
      env.DB.prepare(
        `INSERT INTO admin_audit_events (
           id, admin_user_id, action, target_type, target_id, metadata_json
         )
         SELECT ?, ?, 'marketing_link.created', 'marketing_link', ?, ?
         WHERE changes() = 1`
      ).bind(
        auditId,
        actorId,
        linkId,
        JSON.stringify({ showId, code: input.code })
      )
    ]);
    if (!results[0].success || results[0].meta.changes !== 1) {
      return privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "marketing_link_code_conflict" },
        { status: 409 }
      );
    }
    const link = await loadMarketingLink(env.DB, showId, linkId);
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { created: true, link: presentMarketingLink(link!) },
      { status: 201 }
    );
  }

  const existing = await loadMarketingLink(env.DB, showId, existingId);
  if (!existing) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "marketing_link_not_found" },
      { status: 404 }
    );
  }
  if (existing.updated_at !== expectedUpdatedAt) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "marketing_link_changed",
        current: presentMarketingLink(existing)
      },
      { status: 409 }
    );
  }
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE podcast_marketing_links
       SET
         code = ?,
         label = ?,
         canonical_url = ?,
         utm_source = ?,
         utm_medium = ?,
         utm_campaign = ?,
         utm_content = ?,
         referral_code = ?,
         tagged_url = ?,
         revision = revision + 1,
         updated_by_admin_user_id = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND show_id = ? AND updated_at = ?
         AND NOT EXISTS (
           SELECT 1
           FROM podcast_marketing_links AS conflicting_link
           WHERE conflicting_link.show_id = ?
             AND conflicting_link.code = ?
             AND conflicting_link.id != ?
         )`
    ).bind(
      input.code,
      input.label,
      input.canonicalUrl,
      input.utmSource,
      input.utmMedium,
      input.utmCampaign,
      input.utmContent,
      input.referralCode,
      input.taggedUrl,
      actorId,
      existingId,
      showId,
      expectedUpdatedAt,
      showId,
      input.code,
      existingId
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'marketing_link.updated', 'marketing_link', ?, ?
       WHERE changes() = 1`
    ).bind(
      auditId,
      actorId,
      existingId,
      JSON.stringify({
        showId,
        previousRevision: existing.revision,
        code: input.code
      })
    )
  ]);
  if (!results[0].success || results[0].meta.changes !== 1) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "marketing_link_changed" },
      { status: 409 }
    );
  }
  const link = await loadMarketingLink(env.DB, showId, existingId);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    updated: true,
    link: presentMarketingLink(link!)
  });
}

export async function deleteAdminMarketingLink(
  request: Request,
  env: PodcastEnv,
  showIdValue: string,
  linkIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const linkId = validIdentifier(linkIdValue, "linkId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: WRITE_ROLES,
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const existing = await loadMarketingLink(env.DB, showId, linkId);
  if (!existing) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "marketing_link_not_found" },
      { status: 404 }
    );
  }
  const actorId = auth.authorization.identity.id;
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM podcast_marketing_links
       WHERE id = ? AND show_id = ?`
    ).bind(linkId, showId),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, 'marketing_link.deleted', 'marketing_link', ?, ?
       WHERE changes() = 1`
    ).bind(
      `audit_${crypto.randomUUID().replace(/-/g, "")}`,
      actorId,
      linkId,
      JSON.stringify({
        showId,
        code: existing.code,
        revision: existing.revision
      })
    )
  ]);
  if (!results[0].success || results[0].meta.changes !== 1) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "marketing_link_changed" },
      { status: 409 }
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    deleted: true,
    linkId
  });
}

export function normalizeMarketingLinkInput(
  body: Record<string, unknown>,
  canonicalUrlValue: string
): {
  code: string;
  label: string;
  canonicalUrl: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  referralCode: string;
  taggedUrl: string;
} {
  const label = requiredText(body.label, "label", 120);
  const utmSource = optionalText(body.utmSource, "utmSource", 160);
  const utmMedium = optionalText(body.utmMedium, "utmMedium", 160);
  const utmCampaign = optionalText(body.utmCampaign, "utmCampaign", 160);
  const utmContent = optionalText(body.utmContent, "utmContent", 160);
  const referralCode = normalizeMarketingReferralCode(body.referralCode);
  const code = normalizeMarketingReferralCode(
    body.code || referralCode || label
  );
  if (!code) {
    throw new RequestValidationError("code is required");
  }
  let canonicalUrl: URL;
  try {
    canonicalUrl = new URL(canonicalUrlValue);
  } catch {
    throw new RequestValidationError("show canonical URL is invalid");
  }
  if (
    canonicalUrl.protocol !== "https:"
    || canonicalUrl.username
    || canonicalUrl.password
    || canonicalUrl.hash
  ) {
    throw new RequestValidationError("show canonical URL is invalid");
  }
  const taggedUrl = buildTaggedMarketingUrl({
    canonicalUrl: canonicalUrl.toString(),
    source: utmSource,
    medium: utmMedium,
    campaign: utmCampaign,
    content: utmContent,
    ref: referralCode,
    allowedOrigins: [canonicalUrl.origin]
  });
  return {
    code,
    label,
    canonicalUrl: canonicalUrl.toString(),
    utmSource,
    utmMedium,
    utmCampaign,
    utmContent,
    referralCode,
    taggedUrl
  };
}

async function loadShowMarketingTarget(
  db: D1Database,
  showId: string
): Promise<ShowMarketingTarget | null> {
  return db.prepare(
    `SELECT id, canonical_url
     FROM shows
     WHERE id = ? AND status != 'archived'`
  ).bind(showId).first<ShowMarketingTarget>();
}

async function loadMarketingLink(
  db: D1Database,
  showId: string,
  linkId: string
): Promise<MarketingLinkRow | null> {
  return db.prepare(
    `SELECT
       id, show_id, code, label, canonical_url,
       utm_source, utm_medium, utm_campaign, utm_content,
       referral_code, tagged_url, revision, created_at, updated_at
     FROM podcast_marketing_links
     WHERE show_id = ? AND id = ?`
  ).bind(showId, linkId).first<MarketingLinkRow>();
}

function presentMarketingLink(row: MarketingLinkRow): Record<string, unknown> {
  return {
    id: row.id,
    showId: row.show_id,
    code: row.code,
    label: row.label,
    canonicalUrl: row.canonical_url,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    referralCode: row.referral_code,
    taggedUrl: row.tagged_url,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
