import launchLabFixture from "../config/launch-lab-fixture.json";

import { requireAdmin } from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { presentLaunchLabRun } from "./launch-lab-ledger";

const RECENT_RUNS_QUERY = [
  "SELECT id",
  "FROM launch_lab_runs",
  "WHERE show_id = ?",
  "ORDER BY started_at DESC, id DESC",
  "LIMIT 5"
].join("\n");
const FIXTURE_QUERY = [
  "SELECT COUNT(*) AS fixture_count",
  "FROM shows",
  "WHERE id = ? AND slug = ? AND rss_slug = ? AND test_fixture = 1"
].join("\n");

export async function getAdminLaunchLab(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  if (env.ENVIRONMENT !== "staging") {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      error: "not_found"
    }, { status: 404 });
  }
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"]
  });
  if (!auth.ok) return auth.response;

  const fixture = launchLabFixture.show;
  const fixtureRow = await env.DB.prepare(FIXTURE_QUERY).bind(
    fixture.id,
    fixture.slug,
    fixture.rssSlug
  ).first<{ fixture_count: number }>();
  const runRows = (await env.DB.prepare(RECENT_RUNS_QUERY)
    .bind(fixture.id)
    .all<{ id: string }>()).results;
  const runs = (await Promise.all(runRows.map(({ id }) =>
    presentLaunchLabRun(env.DB, id)
  ))).filter((run): run is Record<string, unknown> => Boolean(run));

  return privateJson(request, env.ALLOWED_ORIGINS, {
    schemaVersion: "dust-wave-launch-lab-admin-v1",
    available: true,
    fixture: {
      exists: Number(fixtureRow?.fixture_count ?? 0) === 1,
      testFixture: true,
      publiclyDiscoverable: false,
      billable: false,
      launchGateEligible: false
    },
    latest: runs[0] ?? null,
    runs
  });
}
