import { adminCsvResponse } from "./admin-csv";
import { requireAdmin } from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  boundedPageSize,
  RequestValidationError,
  validIdentifier
} from "./validation";

const SUBSCRIPTION_STATUSES = new Set([
  "pending",
  "active",
  "past_due",
  "paused",
  "canceled",
  "expired"
]);
const PROVIDERS = new Set(["stripe", "pool", "manual"]);
const SOURCE_QUERY_PAGE_SIZE = 200;

type SubscriberRow = {
  id: string;
  listener_id: string;
  show_id: string;
  show_title: string;
  price_id: string | null;
  billing_period: string | null;
  status: string;
  current_period_end: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
  has_private_feed: number;
  announcements_enabled: number;
  notification_language: string | null;
};

type SourceRow = {
  listener_id: string;
  show_id: string;
  provider: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  status: string;
  current_period_end: string | null;
  canceled_at: string | null;
  updated_at: string;
};

type SubscriberRecord = ReturnType<typeof presentSubscriber>;

export async function listAdminSubscribers(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const url = new URL(request.url);
  const showIdValue = url.searchParams.get("showId");
  const showId = showIdValue
    ? validIdentifier(showIdValue, "showId")
    : null;
  const status = optionalFilter(
    url.searchParams.get("status"),
    SUBSCRIPTION_STATUSES,
    "status"
  );
  const provider = optionalFilter(
    url.searchParams.get("provider"),
    PROVIDERS,
    "provider"
  );
  const format = String(url.searchParams.get("format") || "json");
  if (!["json", "csv"].includes(format)) {
    throw new RequestValidationError("format must be json or csv");
  }
  const limit = boundedPageSize(
    url.searchParams.get("limit"),
    format === "csv" ? 500 : 50,
    format === "csv" ? 500 : 100
  );
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue
    ? validIdentifier(cursorValue, "cursor")
    : null;
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"]
  });
  if (!auth.ok) return auth.response;

  const cursorRow = cursor
    ? await loadCursor(env.DB, cursor, showId)
    : null;
  if (cursor && !cursorRow) {
    throw new RequestValidationError("cursor is invalid");
  }
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (showId) {
    clauses.push("subscription.show_id = ?");
    bindings.push(showId);
  }
  if (status) {
    clauses.push("subscription.status = ?");
    bindings.push(status);
  }
  if (provider) {
    clauses.push(
      `EXISTS (
         SELECT 1
         FROM subscription_entitlement_sources filtered_source
         WHERE filtered_source.listener_id = subscription.listener_id
           AND filtered_source.show_id = subscription.show_id
           AND filtered_source.provider = ?
       )`
    );
    bindings.push(provider);
  }
  if (cursorRow) {
    clauses.push(
      `(subscription.updated_at < ?
        OR (
          subscription.updated_at = ?
          AND subscription.id < ?
        ))`
    );
    bindings.push(
      cursorRow.updated_at,
      cursorRow.updated_at,
      cursorRow.id
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const page = await env.DB.prepare(
    `${subscriberSelect()}
     ${where}
     ORDER BY subscription.updated_at DESC, subscription.id DESC
     LIMIT ?`
  ).bind(...bindings, limit + 1).all<SubscriberRow>();
  const hasMore = page.results.length > limit;
  const rows = page.results.slice(0, limit);
  const [sources, summary, providerSummary] = await Promise.all([
    loadSources(env.DB, rows),
    loadSummary(env.DB, showId),
    loadProviderSummary(env.DB, showId)
  ]);
  const sourcesBySubscription = groupSources(sources);
  const subscribers = rows.map((row) =>
    presentSubscriber(
      row,
      sourcesBySubscription.get(subscriptionSourceKey(row)) || []
    )
  );
  if (format === "csv") {
    return subscriberCsvResponse(
      request,
      env.ALLOWED_ORIGINS,
      subscribers
    );
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    subscribers,
    summary: presentSummary(summary, providerSummary),
    filters: {
      showId,
      status: status || "all",
      provider: provider || "all"
    },
    privacy: {
      version: "subscriber-admin-minimized-v1",
      includesEmail: false,
      includesAddress: false,
      providerReferences: "super_admin_only"
    },
    pagination: {
      limit,
      nextCursor: hasMore ? rows.at(-1)?.id ?? null : null
    }
  });
}

function subscriberSelect(): string {
  return `SELECT
    subscription.id,
    subscription.listener_id,
    subscription.show_id,
    show.title AS show_title,
    subscription.price_id,
    price.billing_period,
    subscription.status,
    subscription.current_period_end,
    subscription.canceled_at,
    subscription.created_at,
    subscription.updated_at,
    EXISTS (
      SELECT 1
      FROM private_feed_tokens feed
      WHERE feed.listener_id = subscription.listener_id
        AND feed.show_id = subscription.show_id
        AND feed.revoked_at IS NULL
    ) AS has_private_feed,
    COALESCE(preference.announcements_enabled, 0)
      AS announcements_enabled,
    preference.language AS notification_language
  FROM subscriptions subscription
  JOIN shows show ON show.id = subscription.show_id
  LEFT JOIN show_prices price ON price.id = subscription.price_id
  LEFT JOIN show_notification_preferences preference
    ON preference.listener_id = subscription.listener_id
   AND preference.show_id = subscription.show_id`;
}

async function loadCursor(
  db: D1Database,
  cursor: string,
  showId: string | null
): Promise<{ id: string; updated_at: string } | null> {
  const query = `SELECT id, updated_at
    FROM subscriptions
    WHERE id = ?${showId ? " AND show_id = ?" : ""}`;
  return showId
    ? db.prepare(query).bind(cursor, showId).first()
    : db.prepare(query).bind(cursor).first();
}

async function loadSources(
  db: D1Database,
  rows: SubscriberRow[]
): Promise<SourceRow[]> {
  if (!rows.length) return [];
  const sources: SourceRow[] = [];
  for (
    let offset = 0;
    offset < rows.length;
    offset += SOURCE_QUERY_PAGE_SIZE
  ) {
    const page = rows.slice(offset, offset + SOURCE_QUERY_PAGE_SIZE);
    const pairs = page.map(() => "(listener_id = ? AND show_id = ?)");
    const bindings = page.flatMap((row) => [
      row.listener_id,
      row.show_id
    ]);
    const result = await db.prepare(
      `SELECT
         listener_id, show_id, provider, provider_customer_id,
         provider_subscription_id, status, current_period_end,
         canceled_at, updated_at
       FROM subscription_entitlement_sources
       WHERE ${pairs.join(" OR ")}
       ORDER BY provider, updated_at DESC`
    ).bind(...bindings).all<SourceRow>();
    sources.push(...result.results);
  }
  return sources;
}

async function loadSummary(
  db: D1Database,
  showId: string | null
): Promise<Record<string, unknown> | null> {
  const where = showId ? "WHERE show_id = ?" : "";
  const statement = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'past_due' THEN 1 ELSE 0 END) AS past_due,
       SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
       SUM(CASE WHEN status IN ('canceled', 'expired') THEN 1 ELSE 0 END)
         AS ended,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
     FROM subscriptions
     ${where}`
  );
  return showId ? statement.bind(showId).first() : statement.first();
}

async function loadProviderSummary(
  db: D1Database,
  showId: string | null
): Promise<Array<{ provider: string; total: number; active: number }>> {
  const where = showId ? "WHERE show_id = ?" : "";
  const statement = db.prepare(
    `SELECT
       provider,
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
     FROM subscription_entitlement_sources
     ${where}
     GROUP BY provider
     ORDER BY provider`
  );
  const result = showId
    ? await statement.bind(showId).all<{
      provider: string;
      total: number;
      active: number;
    }>()
    : await statement.all<{
      provider: string;
      total: number;
      active: number;
    }>();
  return result.results;
}

function groupSources(rows: SourceRow[]): Map<string, SourceRow[]> {
  const grouped = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const key = subscriptionSourceKey(row);
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  return grouped;
}

function subscriptionSourceKey(
  row: { listener_id: string; show_id: string }
): string {
  return `${row.listener_id}\u0000${row.show_id}`;
}

function presentSubscriber(row: SubscriberRow, sources: SourceRow[]) {
  return {
    subscriptionId: row.id,
    listenerId: row.listener_id,
    showId: row.show_id,
    showTitle: row.show_title,
    priceId: row.price_id,
    billingPeriod: row.billing_period,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    canceledAt: row.canceled_at,
    hasPrivateFeed: row.has_private_feed === 1,
    announcementsEnabled: row.announcements_enabled === 1,
    notificationLanguage: row.notification_language,
    sources: sources.map((source) => ({
      provider: source.provider,
      status: source.status,
      currentPeriodEnd: source.current_period_end,
      canceledAt: source.canceled_at,
      providerCustomerId: source.provider_customer_id,
      providerSubscriptionId: source.provider_subscription_id,
      updatedAt: source.updated_at
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function presentSummary(
  row: Record<string, unknown> | null,
  providers: Array<{ provider: string; total: number; active: number }>
): Record<string, unknown> {
  return {
    total: Number(row?.total || 0),
    active: Number(row?.active || 0),
    pastDue: Number(row?.past_due || 0),
    paused: Number(row?.paused || 0),
    ended: Number(row?.ended || 0),
    pending: Number(row?.pending || 0),
    providers: providers.map((provider) => ({
      provider: provider.provider,
      total: Number(provider.total || 0),
      active: Number(provider.active || 0)
    }))
  };
}

function subscriberCsvResponse(
  request: Request,
  allowedOrigins: string,
  rows: SubscriberRecord[]
): Response {
  const flattened = rows.map((row) => ({
    subscriptionId: row.subscriptionId,
    listenerId: row.listenerId,
    showId: row.showId,
    showTitle: row.showTitle,
    priceId: row.priceId,
    billingPeriod: row.billingPeriod,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd,
    hasPrivateFeed: row.hasPrivateFeed,
    announcementsEnabled: row.announcementsEnabled,
    notificationLanguage: row.notificationLanguage,
    sources: row.sources.map((source) =>
      `${source.provider}:${source.status}`
    ),
    providerCustomerIds: row.sources.map((source) =>
      source.providerCustomerId
    ).filter(Boolean),
    providerSubscriptionIds: row.sources.map((source) =>
      source.providerSubscriptionId
    ).filter(Boolean),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
  return adminCsvResponse(request, allowedOrigins, {
    filename: "podcast-subscribers.csv",
    columns: [
      "subscriptionId",
      "listenerId",
      "showId",
      "showTitle",
      "priceId",
      "billingPeriod",
      "status",
      "currentPeriodEnd",
      "hasPrivateFeed",
      "announcementsEnabled",
      "notificationLanguage",
      "sources",
      "providerCustomerIds",
      "providerSubscriptionIds",
      "createdAt",
      "updatedAt"
    ],
    rows: flattened
  });
}

function optionalFilter(
  value: string | null,
  allowed: Set<string>,
  field: string
): string | null {
  if (!value || value === "all") return null;
  const normalized = value.trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new RequestValidationError(`${field} is invalid`);
  }
  return normalized;
}
