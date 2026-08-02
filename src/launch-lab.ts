import launchLabFixture from "../config/launch-lab-fixture.json";

import type { PodcastEnv } from "./env";
import {
  ensureLaunchLabRun,
  isLaunchLabProvider,
  recordLaunchLabObservations,
  seedLaunchLabScenarios,
  presentLaunchLabRun
} from "./launch-lab-ledger";
import { runLaunchLabResendMatrix } from "./launch-lab-resend";
import { runLaunchLabStripeReadiness } from "./launch-lab-stripe";
import { readSignedJsonBody } from "./signed-callback";

const TIMESTAMP_HEADER = "x-podcast-launch-lab-timestamp";
const SIGNATURE_HEADER = "x-podcast-launch-lab-signature";
const MAXIMUM_REQUEST_BYTES = 16_000;
const COLLISION_QUERY = [
  "SELECT id, slug, rss_slug, test_fixture",
  "FROM shows",
  "WHERE id = ? OR slug = ? OR rss_slug = ?",
  "LIMIT 1"
].join("\n");
const RECONCILE_QUERY = [
  "INSERT INTO shows (",
  "  id, slug, title, description, description_en, language, status,",
  "  canonical_url, rss_slug, premium_enabled, early_access_days,",
  "  free_mini_episode_enabled, author_name, category, explicit,",
  "  test_fixture, updated_at",
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))",
  "ON CONFLICT(id) DO UPDATE SET",
  "  title = excluded.title,",
  "  description = excluded.description,",
  "  description_en = excluded.description_en,",
  "  language = excluded.language,",
  "  status = excluded.status,",
  "  canonical_url = excluded.canonical_url,",
  "  premium_enabled = excluded.premium_enabled,",
  "  early_access_days = excluded.early_access_days,",
  "  free_mini_episode_enabled = excluded.free_mini_episode_enabled,",
  "  author_name = excluded.author_name,",
  "  category = excluded.category,",
  "  explicit = excluded.explicit,",
  "  updated_at = datetime('now')",
  "WHERE shows.test_fixture = 1",
  "RETURNING id, test_fixture"
].join("\n");

type FixtureCollisionRow = {
  id: string;
  slug: string;
  rss_slug: string;
  test_fixture: number;
};

export async function manageLaunchLab(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  if (
    env.ENVIRONMENT !== "staging"
    || !env.LAUNCH_LAB_CALLBACK_SECRET
  ) {
    return launchLabNotFound();
  }
  const signed = await readSignedJsonBody(request, {
    secret: env.LAUNCH_LAB_CALLBACK_SECRET,
    timestampHeader: TIMESTAMP_HEADER,
    signatureHeader: SIGNATURE_HEADER,
    maximumBytes: MAXIMUM_REQUEST_BYTES,
    bodyName: "Launch Lab request",
    invalidBodyCode: "invalid_launch_lab_request"
  });
  if (!signed.ok) return launchLabNotFound();
  if (signed.body.schemaVersion !== "dust-wave-launch-lab-request-v1") {
    return launchLabJson({ error: "invalid_launch_lab_action" }, 400);
  }
  const runId = String(signed.body.runId ?? "").trim();
  const sourceCommit = String(signed.body.sourceCommit ?? "").trim();
  if (
    !/^[A-Za-z0-9_-]{16,64}$/.test(runId)
    || !/^[a-f0-9]{40}$/.test(sourceCommit)
  ) {
    return launchLabJson({ error: "invalid_launch_lab_identity" }, 400);
  }

  const action = String(signed.body.action ?? "");
  if (action === "status") {
    const run = await presentLaunchLabRun(env.DB, runId);
    if (!run || run.sourceCommit !== sourceCommit) {
      return launchLabJson({ error: "launch_lab_run_not_found" }, 404);
    }
    return launchLabJson(run);
  }
  if (action === "run_resend_matrix") {
    const fixtureReady = await loadExactFixture(env.DB);
    if (!fixtureReady) {
      return launchLabJson({ error: "launch_lab_fixture_missing" }, 409);
    }
    if (!await ensureLaunchLabRun(env.DB, {
      runId,
      showId: launchLabFixture.show.id,
      sourceCommit
    })) {
      return launchLabJson({ error: "launch_lab_run_collision" }, 409);
    }
    await seedLaunchLabScenarios(env.DB, runId);
    return launchLabJson(
      await runLaunchLabResendMatrix(env, runId)
    );
  }
  if (action === "run_stripe_readiness") {
    const fixtureReady = await loadExactFixture(env.DB);
    if (!fixtureReady) {
      return launchLabJson({ error: "launch_lab_fixture_missing" }, 409);
    }
    if (!await ensureLaunchLabRun(env.DB, {
      runId,
      showId: launchLabFixture.show.id,
      sourceCommit
    })) {
      return launchLabJson({ error: "launch_lab_run_collision" }, 409);
    }
    await seedLaunchLabScenarios(env.DB, runId);
    await runLaunchLabStripeReadiness(env, runId);
    const run = await presentLaunchLabRun(env.DB, runId);
    if (!run) return launchLabJson({ error: "launch_lab_run_not_found" }, 404);
    return launchLabJson(run);
  }
  if (action === "record_observations") {
    const fixtureReady = await loadExactFixture(env.DB);
    if (!fixtureReady) {
      return launchLabJson({ error: "launch_lab_fixture_missing" }, 409);
    }
    if (!await ensureLaunchLabRun(env.DB, {
      runId,
      showId: launchLabFixture.show.id,
      sourceCommit
    })) {
      return launchLabJson({ error: "launch_lab_run_collision" }, 409);
    }
    const rawObservations = signed.body.observations;
    if (!Array.isArray(rawObservations)) {
      return launchLabJson({ error: "invalid_launch_lab_observations" }, 400);
    }
    const observations = rawObservations.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const provider = String(record.provider ?? "");
      const scenario = String(record.scenario ?? "");
      const observedStatus = String(record.observedStatus ?? "");
      const failureCode = record.failureCode === null
        || record.failureCode === undefined
        ? null
        : String(record.failureCode);
      return isLaunchLabProvider(provider)
        && /^[a-z0-9_]{1,80}$/.test(scenario)
        ? [{ provider, scenario, observedStatus, failureCode }]
        : [];
    });
    if (observations.length !== rawObservations.length) {
      return launchLabJson({ error: "invalid_launch_lab_observations" }, 400);
    }
    await seedLaunchLabScenarios(env.DB, runId);
    try {
      await recordLaunchLabObservations(env.DB, runId, observations);
    } catch (error) {
      if (error instanceof Error && (
        error.message.includes("not allowlisted")
        || error.message.includes("count is invalid")
        || error.message.includes("must be unique")
      )) {
        return launchLabJson({ error: "invalid_launch_lab_observations" }, 400);
      }
      throw error;
    }
    const run = await presentLaunchLabRun(env.DB, runId);
    if (!run) return launchLabJson({ error: "launch_lab_run_not_found" }, 404);
    return launchLabJson(run);
  }
  if (action !== "reconcile") {
    return launchLabJson({ error: "invalid_launch_lab_action" }, 400);
  }

  const fixture = launchLabFixture.show;
  const collision = await env.DB.prepare(COLLISION_QUERY)
    .bind(fixture.id, fixture.slug, fixture.rssSlug)
    .first<FixtureCollisionRow>();
  if (
    collision
    && (
      collision.id !== fixture.id
      || collision.slug !== fixture.slug
      || collision.rss_slug !== fixture.rssSlug
      || collision.test_fixture !== 1
    )
  ) {
    return launchLabJson({ error: "launch_lab_fixture_collision" }, 409);
  }

  const canonicalUrl = env.SITE_ORIGIN.replace(/\/$/, "")
    + "/podcasts/" + fixture.slug + "/";
  const reconciled = await env.DB.prepare(RECONCILE_QUERY).bind(
    fixture.id,
    fixture.slug,
    fixture.title,
    fixture.description,
    fixture.descriptionEn,
    fixture.language,
    fixture.status,
    canonicalUrl,
    fixture.rssSlug,
    fixture.premiumEnabled ? 1 : 0,
    fixture.earlyAccessDays,
    fixture.freeMiniEpisodeEnabled ? 1 : 0,
    fixture.authorName,
    fixture.category,
    fixture.explicit ? 1 : 0
  ).first<{ id: string; test_fixture: number }>();
  if (reconciled?.id !== fixture.id || reconciled.test_fixture !== 1) {
    return launchLabJson({ error: "launch_lab_reconciliation_failed" }, 503);
  }
  if (!await ensureLaunchLabRun(env.DB, {
    runId,
    showId: fixture.id,
    sourceCommit
  })) {
    return launchLabJson({ error: "launch_lab_run_collision" }, 409);
  }
  await seedLaunchLabScenarios(env.DB, runId);

  return launchLabJson({
    schemaVersion: "dust-wave-launch-lab-response-v1",
    runId,
    sourceCommit,
    showId: fixture.id,
    testFixture: true,
    publiclyDiscoverable: false,
    launchEligible: false,
    billable: false,
    rssDirectoryBlocked: true
  });
}

async function loadExactFixture(db: D1Database): Promise<boolean> {
  const fixture = launchLabFixture.show;
  const row = await db.prepare(COLLISION_QUERY)
    .bind(fixture.id, fixture.slug, fixture.rssSlug)
    .first<FixtureCollisionRow>();
  return Boolean(
    row
    && row.id === fixture.id
    && row.slug === fixture.slug
    && row.rss_slug === fixture.rssSlug
    && row.test_fixture === 1
  );
}

function launchLabNotFound(): Response {
  return launchLabJson({ error: "not_found" }, 404);
}

function launchLabJson(
  body: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}
