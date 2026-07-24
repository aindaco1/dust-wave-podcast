import {
  requireAdmin,
  type AdminRole
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  RequestValidationError,
  validIdentifier
} from "./validation";

const READ_ROLES: AdminRole[] = [
  "super_admin",
  "admin",
  "producer",
  "analyst"
];
const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 100;

type ReconciliationRow = {
  id: string;
  name: string;
  campaign_type: string;
  sponsor_name: string | null;
  approval_status: string;
  active: number;
  kill_switch_at: string | null;
  starts_at: string;
  ends_at: string | null;
  impression_cap: number | null;
  qualified_impression_goal: number | null;
  qualified_impressions: number;
  pacing_strategy: string;
  counter_value: number | null;
  qualification_rows: number | null;
  difference: number | null;
  last_qualified_at: string | null;
  created_at: string;
};

export async function getAdminAdQualificationReconciliation(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const url = new URL(request.url);
  const showId = validIdentifier(url.searchParams.get("showId"), "showId");
  const limit = pageSize(url.searchParams.get("limit"));
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue
    ? validIdentifier(cursorValue, "cursor")
    : null;
  const auth = await requireAdmin(request, env, {
    allowedRoles: READ_ROLES,
    showId
  });
  if (!auth.ok) return auth.response;

  const cursorRow = cursor
    ? await env.DB.prepare(
      `SELECT c.id, c.created_at
       FROM ad_campaigns c
       WHERE c.id = ?
         AND EXISTS (
           SELECT 1
           FROM ad_rules target
           WHERE target.campaign_id = c.id
             AND target.active = 1
             AND target.show_id = ?
         )`
    ).bind(cursor, showId).first<{ id: string; created_at: string }>()
    : null;
  if (cursor && !cursorRow) {
    throw new RequestValidationError("cursor is invalid");
  }

  const cursorClause = cursorRow
    ? `AND (
         c.created_at < ?
         OR (c.created_at = ? AND c.id > ?)
       )`
    : "";
  const pageStatement = env.DB.prepare(
    `WITH scoped_campaigns AS (
       SELECT
         c.id, c.name, c.campaign_type, s.name AS sponsor_name,
         c.approval_status, c.active, c.kill_switch_at,
         c.starts_at, c.ends_at, c.impression_cap,
         c.qualified_impression_goal, c.qualified_impressions,
         c.pacing_strategy, c.created_at
       FROM ad_campaigns c
       LEFT JOIN sponsors s ON s.id = c.sponsor_id
       WHERE EXISTS (
         SELECT 1
         FROM ad_rules target
         WHERE target.campaign_id = c.id
           AND target.active = 1
           AND target.show_id = ?
       )
       ${cursorClause}
       ORDER BY c.created_at DESC, c.id
       LIMIT ?
     ),
     qualification_totals AS (
       SELECT
         qualification.campaign_id,
         COUNT(*) AS qualification_rows,
         MAX(qualification.qualified_at) AS last_qualified_at
       FROM ad_impression_qualifications qualification
       JOIN scoped_campaigns scoped
         ON scoped.id = qualification.campaign_id
       GROUP BY qualification.campaign_id
     )
     SELECT
       scoped.*,
       scoped.qualified_impressions AS counter_value,
       COALESCE(qualification_totals.qualification_rows, 0)
         AS qualification_rows,
       scoped.qualified_impressions
         - COALESCE(qualification_totals.qualification_rows, 0)
         AS difference,
       qualification_totals.last_qualified_at
     FROM scoped_campaigns scoped
     LEFT JOIN qualification_totals
       ON qualification_totals.campaign_id = scoped.id
     ORDER BY scoped.created_at DESC, scoped.id`
  );
  const pageQuery = cursorRow
    ? pageStatement.bind(
      showId,
      cursorRow.created_at,
      cursorRow.created_at,
      cursorRow.id,
      limit + 1
    )
    : pageStatement.bind(showId, limit + 1);
  const summaryQuery = env.DB.prepare(
    `WITH scoped_campaigns AS (
       SELECT
         c.id, c.impression_cap, c.qualified_impressions
       FROM ad_campaigns c
       WHERE EXISTS (
         SELECT 1
         FROM ad_rules target
         WHERE target.campaign_id = c.id
           AND target.active = 1
           AND target.show_id = ?
       )
     ),
     qualification_totals AS (
       SELECT
         qualification.campaign_id,
         COUNT(*) AS qualification_rows,
         MAX(qualification.qualified_at) AS last_qualified_at
       FROM ad_impression_qualifications qualification
       JOIN scoped_campaigns scoped
         ON scoped.id = qualification.campaign_id
       GROUP BY qualification.campaign_id
     )
     SELECT
       COUNT(*) AS campaign_count,
       COALESCE(SUM(scoped.qualified_impressions), 0)
         AS counter_value,
       COALESCE(SUM(qualification_totals.qualification_rows), 0)
         AS qualification_rows,
       COALESCE(SUM(
         scoped.qualified_impressions
           - COALESCE(qualification_totals.qualification_rows, 0)
       ), 0)
         AS difference,
       COALESCE(SUM(
         CASE
           WHEN scoped.qualified_impressions
             != COALESCE(qualification_totals.qualification_rows, 0)
           THEN 1
           ELSE 0
         END
       ), 0) AS discrepancy_count,
       COALESCE(SUM(
         CASE
           WHEN scoped.impression_cap IS NOT NULL
             AND scoped.qualified_impressions >= scoped.impression_cap
           THEN 1
           ELSE 0
         END
       ), 0) AS campaigns_at_cap,
       MAX(qualification_totals.last_qualified_at) AS last_qualified_at
     FROM scoped_campaigns scoped
     LEFT JOIN qualification_totals
       ON qualification_totals.campaign_id = scoped.id`
  ).bind(showId);
  const [pageResult, summary] = await Promise.all([
    pageQuery.all<ReconciliationRow>(),
    summaryQuery.first<Record<string, unknown>>()
  ]);
  const pageRows = pageResult.results;
  const hasMore = pageRows.length > limit;
  const rows = pageRows.slice(0, limit);

  return privateJson(request, env.ALLOWED_ORIGINS, {
    showId,
    methodology: {
      version: "trusted-download-v1",
      qualification:
        "One immutable campaign qualification per completed decision slot after the snapshotted creative byte threshold is observed by a signed trusted callback.",
      counters: "D1 trigger-maintained and reconciled against durable rows."
    },
    summary: presentSummary(summary),
    campaigns: rows.map(presentReconciliation),
    pagination: {
      limit,
      nextCursor: hasMore ? rows.at(-1)?.id ?? null : null
    }
  });
}

function pageSize(value: string | null): number {
  if (value === null || value === "") return DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > MAXIMUM_PAGE_SIZE
  ) {
    throw new RequestValidationError(
      `limit must be between 1 and ${MAXIMUM_PAGE_SIZE}`
    );
  }
  return parsed;
}

function presentSummary(
  row: Record<string, unknown> | null
): Record<string, unknown> {
  return {
    campaignCount: Number(row?.campaign_count ?? 0),
    counterValue: Number(row?.counter_value ?? 0),
    qualificationRows: Number(row?.qualification_rows ?? 0),
    difference: Number(row?.difference ?? 0),
    discrepancyCount: Number(row?.discrepancy_count ?? 0),
    campaignsAtCap: Number(row?.campaigns_at_cap ?? 0),
    lastQualifiedAt: row?.last_qualified_at ?? null
  };
}

function presentReconciliation(row: ReconciliationRow): Record<string, unknown> {
  const counterValue = Number(
    row.counter_value ?? row.qualified_impressions ?? 0
  );
  const qualificationRows = Number(row.qualification_rows ?? 0);
  const difference = Number(row.difference ?? counterValue - qualificationRows);
  return {
    id: row.id,
    name: row.name,
    campaignType: row.campaign_type,
    sponsorName: row.sponsor_name,
    approvalStatus: row.approval_status,
    active: row.active === 1,
    killSwitchAt: row.kill_switch_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    impressionCap: row.impression_cap,
    qualifiedImpressionGoal: row.qualified_impression_goal,
    qualifiedImpressions: counterValue,
    qualificationRows,
    difference,
    reconciled: difference === 0,
    pacingStrategy: row.pacing_strategy,
    lastQualifiedAt: row.last_qualified_at
  };
}
