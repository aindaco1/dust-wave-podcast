#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  evaluateEpisodeStagingGate,
  loadEpisodeStagingSnapshot
} from "./check-episode-staging-gate.mjs";
import {
  evaluateStripeStagingReadiness,
  loadStripeStagingSnapshot
} from "./check-stripe-staging-readiness.mjs";
import {
  loadWorkerConfig,
  repositoryRoot,
  runJson,
  wrangler
} from "./staging-gate-runtime.mjs";

const feedValidationSourcePath = path.resolve(
  repositoryRoot,
  "src/feed-validation.ts"
);
const requiredDestinations = 10;
const dynamicAdPilotRequirements = Object.freeze([
  Object.freeze({ field: "approvedPlans", label: "approved episode ad plan" }),
  Object.freeze({ field: "selectedDecisions", label: "selected ad decision" }),
  Object.freeze({
    field: "directQualifications",
    label: "qualified direct-sponsor download"
  })
]);

const stagingPosture = Object.freeze({
  AD_DECISION_MODE: "staging_validate",
  ANNOUNCEMENT_DELIVERY_MODE: "dry_run",
  CLIP_PUBLICATION_MODE: "staging_preview",
  DISTRIBUTION_OBSERVATION_MODE: "staging_probe",
  GITHUB_PUBLISH_MODE: "dry_run",
  PUBLICATION_GATE_MODE: "shadow",
  RSS_IMPORT_EXECUTION_MODE: "staging_copy",
  STRIPE_MODE: "test",
  SUBSCRIPTION_CHECKOUT_ENABLED: "false",
  POOL_REDEMPTION_ENABLED: "false",
  CHECKOUT_TURNSTILE_REQUIRED: "true",
  ADMIN_TURNSTILE_REQUIRED: "false",
  LISTENER_TURNSTILE_REQUIRED: "true",
  YOUTUBE_PUBLISH_MODE: "dry_run"
});

const productionPosture = Object.freeze({
  AD_DECISION_MODE: "disabled",
  ANNOUNCEMENT_DELIVERY_MODE: "disabled",
  CLIP_PUBLICATION_MODE: "disabled",
  DISTRIBUTION_OBSERVATION_MODE: "disabled",
  GITHUB_PUBLISH_MODE: "dry_run",
  PUBLICATION_GATE_MODE: "legacy",
  RSS_IMPORT_EXECUTION_MODE: "disabled",
  STRIPE_MODE: "test",
  SUBSCRIPTION_CHECKOUT_ENABLED: "false",
  POOL_REDEMPTION_ENABLED: "false",
  CHECKOUT_TURNSTILE_REQUIRED: "true",
  ADMIN_TURNSTILE_REQUIRED: "true",
  LISTENER_TURNSTILE_REQUIRED: "true",
  SHOW_NOTES_AI_ENABLED: "false",
  CHAPTER_DRAFT_AI_ENABLED: "false",
  CLIP_DRAFT_AI_ENABLED: "false",
  YOUTUBE_PUBLISH_MODE: "dry_run"
});

export function evaluateLaunchStagingReadiness(snapshot) {
  const nodes = [];
  const add = (status, id, label, detail) => {
    nodes.push({ status, id, label, detail });
  };

  add(
    snapshot.remoteReadOnly === true ? "PASS" : "FAIL",
    "read_only",
    "Read-only Cloudflare boundary",
    snapshot.remoteReadOnly === true
      ? "every launch-state statement reported zero writes"
      : "a launch-state statement reported or could not prove zero writes"
  );

  add(
    Number(snapshot.show?.test_fixture) === 0 ? "PASS" : "FAIL",
    "fixture_exclusion",
    "Launch Lab exclusion",
    Number(snapshot.show?.test_fixture) === 0
      ? "the selected launch show is not a staging fixture"
      : "a Launch Lab fixture can never satisfy launch readiness"
  );

  addPostureNode(
    add,
    "staging_posture",
    "Staging provider posture",
    snapshot.stagingVars,
    stagingPosture
  );
  addPostureNode(
    add,
    "production_posture",
    "Production provider posture",
    snapshot.productionVars,
    productionPosture
  );

  const requiredSecrets = new Set(snapshot.requiredSecrets ?? []);
  const installedSecrets = new Set(snapshot.installedSecrets ?? []);
  const missingSecrets = [...requiredSecrets]
    .filter((name) => !installedSecrets.has(name))
    .sort();
  add(
    missingSecrets.length === 0 && requiredSecrets.size > 0 ? "PASS" : "FAIL",
    "staging_secrets",
    "Staging secret-name posture",
    missingSecrets.length === 0 && requiredSecrets.size > 0
      ? `${requiredSecrets.size} required secret name(s) are installed`
      : missingSecrets.length > 0
        ? `missing required name(s): ${missingSecrets.join(", ")}`
        : "the staging required-secret registry is empty"
  );

  const show = snapshot.show ?? null;
  const showReady = Boolean(
    show
    && Number(show.premium_enabled) === 1
    && String(show.youtube_channel_url ?? "").startsWith("https://")
    && String(show.rss_slug ?? "").length > 0
  );
  add(
    showReady ? "PASS" : "BLOCK",
    "show",
    "Launch show configuration",
    showReady
      ? "premium, RSS, and YouTube show settings are present"
      : "finish the launch show's premium, RSS, and YouTube settings"
  );

  addNestedGate(
    add,
    "episode",
    "Episode production gate",
    snapshot.episodeReport,
    "blockCount",
    "waitCount"
  );
  addNestedGate(
    add,
    "stripe",
    "Stripe test-mode gate",
    snapshot.stripeReport,
    "blockerCount"
  );

  const distribution = snapshot.distribution ?? {};
  const certified = boundedCount(distribution.certified);
  const distributionReady = distribution.feedCurrent === true
    && certified >= requiredDestinations;
  add(
    distributionReady ? "PASS" : "BLOCK",
    "distribution",
    "10+ platform certification",
    distributionReady
      ? `${certified} destination(s) have current feed, owner, ingestion, and recovery evidence`
      : `${certified}/${requiredDestinations} destination(s) certified; current feed validation, owner setup, ingestion, and recovery are all required`
  );

  const youtube = snapshot.youtube ?? {};
  add(
    youtube.channelAccessReady === true ? "PASS" : "BLOCK",
    "youtube_access",
    "YouTube channel access",
    youtube.channelAccessReady === true
      ? "a refresh grant reached the exact configured channel within 24 hours"
      : "refresh and verify the exact configured channel; credentials, channel mismatch, or evidence freshness require attention"
  );
  const youtubeReady = boundedCount(youtube.uploadedUnlisted) > 0
    && boundedCount(youtube.unresolved) === 0;
  add(
    youtubeReady ? "PASS" : "BLOCK",
    "youtube",
    "Controlled YouTube test record",
    youtubeReady
      ? "at least one unlisted staging publication completed with no unresolved upload"
      : "complete and inspect one tightly controlled unlisted staging publication; reconcile any ambiguous upload"
  );

  const resend = snapshot.resend ?? {};
  const resendReady = boundedCount(resend.delivered) > 0
    && boundedCount(resend.suppressed) > 0
    && boundedCount(resend.failed) === 0;
  add(
    resendReady ? "PASS" : "BLOCK",
    "resend",
    "Controlled Resend test record",
    resendReady
      ? "matched delivery and suppression evidence exist with no failed delivery"
      : "complete one consented staging send, matched delivery transition, and suppression exercise"
  );

  const dynamicAds = snapshot.dynamicAds ?? {};
  const virtualAudioReady = snapshot.virtualAudioEvidence?.passed === true;
  const missingDynamicAdEvidence = dynamicAdPilotRequirements
    .filter(({ field }) => boundedCount(dynamicAds[field]) === 0)
    .map(({ label }) => label);
  const dynamicAdReady = virtualAudioReady
    && missingDynamicAdEvidence.length === 0;
  add(
    dynamicAdReady ? "PASS" : "BLOCK",
    "dynamic_ads",
    "Dynamic-ad durable pilot record",
    dynamicAdReady
      ? "current synthetic load plus approved plan, selected decision, and direct completion evidence exist"
      : dynamicAdBlockDetail(virtualAudioReady, missingDynamicAdEvidence)
  );

  add(
    boundedCount(snapshot.foreignKeyViolations) === 0 ? "PASS" : "FAIL",
    "foreign_keys",
    "D1 referential integrity",
    boundedCount(snapshot.foreignKeyViolations) === 0
      ? "PRAGMA foreign_key_check returned no rows"
      : `${boundedCount(snapshot.foreignKeyViolations)} violation(s) found`
  );

  const failCount = countStatus(nodes, "FAIL");
  const blockCount = countStatus(nodes, "BLOCK");
  const waitCount = countStatus(nodes, "WAIT");
  return {
    schemaVersion: 1,
    nodes,
    nextAction: presentNextAction(nodes),
    summary: {
      passCount: countStatus(nodes, "PASS"),
      failCount,
      blockCount,
      waitCount,
      safe: failCount === 0,
      launchReady:
        failCount === 0 && blockCount === 0 && waitCount === 0
    }
  };
}

export function loadLaunchStagingSnapshot(
  episodeIdValue,
  virtualAudioEvidencePath = null
) {
  const episodeId = requiredIdentifier(episodeIdValue, "Episode");
  const config = loadWorkerConfig();
  const staging = config.env?.staging;
  const production = config.env?.production;
  if (
    staging?.vars?.ENVIRONMENT !== "staging"
    || production?.vars?.ENVIRONMENT !== "production"
  ) {
    throw new Error("Exact staging and production configurations are required.");
  }
  const database = staging.d1_databases?.find(({ binding }) => binding === "DB");
  if (!database?.database_name) {
    throw new Error("Staging D1 binding is missing.");
  }
  const validatorVersion = publicFeedValidatorVersion(
    readFileSync(feedValidationSourcePath, "utf8")
  );
  const escapedEpisodeId = sqlLiteral(episodeId);
  const escapedValidatorVersion = sqlLiteral(validatorVersion);
  const response = runLaunchJson(wrangler, [
    "d1",
    "execute",
    database.database_name,
    "--env",
    "staging",
    "--remote",
    "--json",
    "--command",
    launchStateStatements(escapedEpisodeId, escapedValidatorVersion)
  ]);
  if (!Array.isArray(response) || response.length !== 7) {
    throw new Error("D1 returned an incomplete launch-state snapshot.");
  }
  const results = response.map((entry) => entry.results ?? []);
  const installedSecrets = runLaunchJson(wrangler, [
    "secret",
    "list",
    "--env",
    "staging"
  ]).map(({ name }) => name);

  return {
    stagingVars: staging.vars ?? {},
    productionVars: production.vars ?? {},
    requiredSecrets: staging.secrets?.required ?? [],
    installedSecrets,
    show: results[0][0] ?? null,
    distribution: presentDistribution(results[1][0]),
    youtube: presentYoutube(results[2][0]),
    resend: presentResend(results[3][0]),
    dynamicAds: presentDynamicAds(results[4][0]),
    virtualAudioEvidence: virtualAudioEvidencePath
      ? loadVirtualAudioEvidence(virtualAudioEvidencePath)
      : presentStoredVirtualAudioEvidence(results[5][0]),
    foreignKeyViolations: results[6].length,
    remoteReadOnly: response.every((entry) =>
      Number(entry.meta?.changes ?? 0) === 0
      && Number(entry.meta?.rows_written ?? 0) === 0
      && entry.meta?.changed_db !== true
    ),
    episodeReport: evaluateEpisodeStagingGate(
      loadEpisodeStagingSnapshot(episodeId)
    ),
    stripeReport: evaluateStripeStagingReadiness(
      loadStripeStagingSnapshot()
    )
  };
}

export function publicFeedValidatorVersion(source) {
  const match = String(source).match(
    /export const PUBLIC_FEED_VALIDATOR_VERSION\s*=\s*"([^"]+)"/
  );
  const version = match?.[1] ?? "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version)) {
    throw new Error("The public feed validator version could not be resolved.");
  }
  return version;
}

export function evaluateVirtualAudioEvidence(evidence, sourceCurrent) {
  const generatedAt = Date.parse(String(evidence?.generatedAt ?? ""));
  const maximumAgeMs = 7 * 24 * 60 * 60 * 1000;
  const ageMs = Date.now() - generatedAt;
  const fresh = Number.isFinite(generatedAt)
    && ageMs >= 0
    && ageMs <= maximumAgeMs;
  return {
    passed: evidence?.schemaVersion
      === "dust-wave-virtual-audio-staging-gate-v1"
      && evidence?.scope?.syntheticProtocolEmulation === true
      && evidence?.scope?.signedCapability === true
      && boundedCount(evidence?.scope?.pairs) >= 5_000
      && boundedCount(evidence?.scope?.totalMeasuredRequests) >= 10_000
      && evidence?.result?.passed === true
      && evidence?.result?.cleanupComplete === true
      && evidence?.result?.diagnosticLeaseRemoved === true
      && evidence?.result?.uploadedObjectsRemoved === true
      && evidence?.result?.failureCode === null
      && fresh
      && sourceCurrent === true
  };
}

function addPostureNode(add, id, label, actual, expected) {
  const mismatches = Object.entries(expected)
    .filter(([name, value]) => String(actual?.[name] ?? "") !== value)
    .map(([name]) => name)
    .sort();
  add(
    mismatches.length === 0 ? "PASS" : "FAIL",
    id,
    label,
    mismatches.length === 0
      ? `${Object.keys(expected).length} fail-closed mode(s) match`
      : `unsafe or unexpected mode(s): ${mismatches.join(", ")}`
  );
}

function addNestedGate(
  add,
  id,
  label,
  report,
  blockerField,
  waitField = null
) {
  const summary = report?.summary;
  const failCount = boundedCount(summary?.failCount);
  const blockCount = boundedCount(summary?.[blockerField]);
  const waitCount = waitField ? boundedCount(summary?.[waitField]) : 0;
  const deferredCount = boundedCount(summary?.deferredCount);
  const status = failCount > 0
    ? "FAIL"
    : blockCount > 0
      ? "BLOCK"
      : waitCount > 0
        ? "WAIT"
        : "PASS";
  const nestedNext = report?.nextAction
    ?? report?.results?.find(({ status: resultStatus }) =>
      resultStatus === "FAIL"
      || resultStatus === "BLOCK"
      || resultStatus === "WAIT"
    )
    ?? null;
  const counts = `${boundedCount(summary?.passCount)} pass, `
    + `${blockCount} block, ${waitCount} wait, `
    + `${deferredCount} deferred, ${failCount} fail`;
  add(
    status,
    id,
    label,
    nestedNext
      ? `${counts}; next: ${nestedNext.label} - ${nestedNext.detail}`
      : counts
  );
}

function launchStateStatements(episodeId, validatorVersion) {
  const showId = `(SELECT show_id FROM episodes WHERE id = '${episodeId}')`;
  return `
    SELECT
      show.id, show.status, show.premium_enabled, show.rss_slug,
      show.test_fixture,
      show.youtube_channel_url
    FROM shows show
    WHERE show.id = ${showId};
    WITH scoped AS (
      SELECT
        destination.id,
        COALESCE(setup.enabled, destination.enabled) AS enabled,
        COALESCE(
          setup.owner_setup_status,
          destination.owner_setup_status
        ) AS owner_setup_status,
        EXISTS (
          SELECT 1 FROM distribution_observation_events observed
          WHERE observed.show_id = ${showId}
            AND observed.destination_id = destination.id
            AND observed.status = 'observed'
        ) AS ingestion_observed,
        EXISTS (
          SELECT 1 FROM distribution_observation_events failed
          WHERE failed.show_id = ${showId}
            AND failed.destination_id = destination.id
            AND failed.status = 'failed'
            AND EXISTS (
              SELECT 1 FROM distribution_observation_events recovered
              WHERE recovered.show_id = failed.show_id
                AND recovered.destination_id = failed.destination_id
                AND recovered.status = 'observed'
                AND recovered.sequence > failed.sequence
            )
        ) AS failure_recovery_verified
      FROM distribution_destinations destination
      LEFT JOIN show_distribution_destinations setup
        ON setup.destination_id = destination.id
       AND setup.show_id = ${showId}
    ),
    feed AS (
      SELECT EXISTS (
        SELECT 1 FROM show_feed_validations validation
        WHERE validation.show_id = ${showId}
          AND validation.status = 'valid'
          AND validation.validator_version = '${validatorVersion}'
      ) AS current
    )
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN scoped.enabled = 1 THEN 1 ELSE 0 END), 0)
        AS enabled,
      COALESCE(SUM(CASE
        WHEN scoped.enabled = 1
          AND scoped.owner_setup_status IN ('verified', 'not_required')
        THEN 1 ELSE 0 END), 0) AS owner_ready,
      COALESCE(SUM(CASE
        WHEN scoped.enabled = 1 AND scoped.ingestion_observed = 1
        THEN 1 ELSE 0 END), 0) AS observed,
      COALESCE(SUM(CASE
        WHEN scoped.enabled = 1 AND scoped.failure_recovery_verified = 1
        THEN 1 ELSE 0 END), 0) AS recovered,
      COALESCE(SUM(CASE
        WHEN scoped.enabled = 1
          AND scoped.owner_setup_status IN ('verified', 'not_required')
          AND scoped.ingestion_observed = 1
          AND scoped.failure_recovery_verified = 1
          AND feed.current = 1
        THEN 1 ELSE 0 END), 0) AS certified,
      feed.current AS feed_current
    FROM scoped CROSS JOIN feed;
    SELECT
      COALESCE(SUM(CASE
        WHEN status = 'uploaded' AND privacy_status = 'unlisted'
        THEN 1 ELSE 0 END), 0) AS uploaded_unlisted,
      COALESCE(SUM(CASE
        WHEN status IN ('uploading', 'reconciliation_required')
        THEN 1 ELSE 0 END), 0) AS unresolved,
      EXISTS (
        SELECT 1 FROM provider_access_health health
        WHERE health.provider = 'youtube'
          AND health.status = 'ready'
          AND health.account_reference IS NOT NULL
          AND health.last_success_at >= datetime('now', '-24 hours')
      ) AS channel_access_ready
    FROM episode_youtube_publications
    WHERE show_id = ${showId};
    SELECT
      COALESCE(SUM(CASE
        WHEN delivery.status = 'delivered' THEN 1 ELSE 0 END), 0)
        AS delivered,
      COALESCE(SUM(CASE
        WHEN delivery.status = 'suppressed' THEN 1 ELSE 0 END), 0)
        AS suppressed,
      COALESCE(SUM(CASE
        WHEN delivery.status = 'failed' THEN 1 ELSE 0 END), 0)
        AS failed
    FROM podcast_announcement_deliveries delivery
    JOIN podcast_announcements announcement
      ON announcement.id = delivery.announcement_id
    WHERE announcement.show_id = ${showId}
      AND announcement.delivery_mode = 'live';
    SELECT
      (
        SELECT COUNT(*) FROM episode_ad_plans plan
        JOIN episodes episode ON episode.id = plan.episode_id
        WHERE episode.show_id = ${showId}
          AND plan.status = 'approved'
      ) AS approved_plans,
      (
        SELECT COUNT(*) FROM ad_decisions decision
        WHERE decision.show_id = ${showId}
          AND decision.status = 'selected'
      ) AS selected_decisions,
      (
        SELECT COUNT(*) FROM ad_impression_qualifications qualification
        JOIN ad_decisions decision
          ON decision.id = qualification.decision_id
        JOIN ad_campaigns campaign
          ON campaign.id = qualification.campaign_id
        WHERE decision.show_id = ${showId}
          AND campaign.campaign_type = 'direct'
          AND qualification.qualification_reason = 'download_complete'
      ) AS direct_qualifications;
    SELECT
      source_commit, generated_at, paired_requests,
      total_measured_requests, protocol_passed, load_passed,
      cleanup_complete, diagnostic_lease_removed,
      uploaded_objects_removed, failure_code
    FROM virtual_audio_gate_runs
    ORDER BY generated_at DESC, created_at DESC
    LIMIT 1;
    PRAGMA foreign_key_check;`;
}

function presentDistribution(row) {
  return {
    total: boundedCount(row?.total),
    enabled: boundedCount(row?.enabled),
    ownerReady: boundedCount(row?.owner_ready),
    observed: boundedCount(row?.observed),
    recovered: boundedCount(row?.recovered),
    certified: boundedCount(row?.certified),
    feedCurrent: Number(row?.feed_current) === 1
  };
}

function presentYoutube(row) {
  return {
    uploadedUnlisted: boundedCount(row?.uploaded_unlisted),
    unresolved: boundedCount(row?.unresolved),
    channelAccessReady: Number(row?.channel_access_ready) === 1
  };
}

function presentResend(row) {
  return {
    delivered: boundedCount(row?.delivered),
    suppressed: boundedCount(row?.suppressed),
    failed: boundedCount(row?.failed)
  };
}

function presentDynamicAds(row) {
  return {
    approvedPlans: boundedCount(row?.approved_plans),
    selectedDecisions: boundedCount(row?.selected_decisions),
    directQualifications: boundedCount(row?.direct_qualifications)
  };
}

export function presentStoredVirtualAudioEvidence(
  row,
  sourceCurrent = null
) {
  if (!row) return null;
  const sourceCommit = String(row.source_commit ?? "");
  return evaluateVirtualAudioEvidence({
    schemaVersion: "dust-wave-virtual-audio-staging-gate-v1",
    generatedAt: row.generated_at,
    sourceCommit,
    scope: {
      syntheticProtocolEmulation: true,
      signedCapability: true,
      pairs: row.paired_requests,
      totalMeasuredRequests: row.total_measured_requests
    },
    result: {
      passed:
        Number(row.protocol_passed) === 1
        && Number(row.load_passed) === 1,
      cleanupComplete: Number(row.cleanup_complete) === 1,
      diagnosticLeaseRemoved: Number(row.diagnostic_lease_removed) === 1,
      uploadedObjectsRemoved: Number(row.uploaded_objects_removed) === 1,
      failureCode: row.failure_code ?? null
    }
  }, typeof sourceCurrent === "boolean"
    ? sourceCurrent
    : /^[a-f0-9]{40}$/.test(sourceCommit)
      && gitSourceIsCurrent(sourceCommit));
}

function dynamicAdBlockDetail(virtualAudioReady, missingEvidence) {
  const requirements = [];
  if (!virtualAudioReady) {
    requirements.push("run the current signed synthetic protocol/load gate");
  }
  if (missingEvidence.length > 0) {
    requirements.push(`missing durable evidence: ${missingEvidence.join(", ")}`);
  }
  return requirements.join("; ");
}

function loadVirtualAudioEvidence(filename) {
  if (!path.isAbsolute(filename)) {
    throw new Error("Virtual-audio evidence must use an absolute path.");
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    throw new Error("Virtual-audio evidence could not be read as JSON.");
  }
  const sourceCommit = String(evidence?.sourceCommit ?? "");
  const sourceCurrent = /^[a-f0-9]{40}$/.test(sourceCommit)
    && gitSourceIsCurrent(sourceCommit);
  return evaluateVirtualAudioEvidence(evidence, sourceCurrent);
}

function gitSourceIsCurrent(sourceCommit) {
  const selectedPaths = [
    "src",
    "shared/dust-wave-platform",
    "config/virtual-audio-synthetic-fixture.json",
    "scripts/run-virtual-audio-staging-gate.mjs",
    "scripts/run-virtual-audio-protocol-matrix.mjs",
    "scripts/run-virtual-audio-load-gate.mjs",
    ".github/workflows/virtual-audio-staging-gate.yml",
    "wrangler.jsonc"
  ];
  const result = spawnSync(
    "git",
    ["diff", "--quiet", sourceCommit, "--", ...selectedPaths],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000
    }
  );
  return result.status === 0;
}

function presentNextAction(nodes) {
  const node = ["FAIL", "BLOCK", "WAIT"]
    .map((status) => nodes.find((candidate) => candidate.status === status))
    .find(Boolean);
  return node
    ? { id: node.id, label: node.label, detail: node.detail }
    : null;
}

function countStatus(nodes, status) {
  return nodes.filter((node) => node.status === status).length;
}

function boundedCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function requiredIdentifier(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_]{8,160}$/.test(text)) {
    throw new Error(`${label} identifier is invalid.`);
  }
  return text;
}

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function runLaunchJson(command, args) {
  return runJson(command, args, {
    failureLabel: "read-only launch command",
    timeoutMs: 45_000
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: npm run gate:launch:staging -- <episode-id> "
      + "[--virtual-audio-evidence=/absolute/staging-gate.json] "
      + "[--require-ready] [--json]\n\n"
      + "Composes the existing episode and Stripe gates with read-only "
      + "Cloudflare mode, secret-name, distribution, YouTube, Resend, "
      + "dynamic-ad, and integrity checks. It never returns content, object "
      + "identity, provider IDs, credentials, recipient identity, or URLs.\n"
    );
    return;
  }
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length !== 1) {
    throw new Error("Exactly one episode ID is required.");
  }
  const virtualAudioEvidenceArgument = args.find((arg) =>
    arg.startsWith("--virtual-audio-evidence=")
  );
  const virtualAudioEvidencePath = virtualAudioEvidenceArgument
    ? virtualAudioEvidenceArgument.slice(
        "--virtual-audio-evidence=".length
      )
    : null;
  const report = evaluateLaunchStagingReadiness(
    loadLaunchStagingSnapshot(positionals[0], virtualAudioEvidencePath)
  );
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const node of report.nodes) {
      process.stdout.write(
        `${node.status.padEnd(5)} ${node.label} - ${node.detail}\n`
      );
    }
    process.stdout.write(
      `\nSummary: ${report.summary.passCount} pass, `
      + `${report.summary.blockCount} block, `
      + `${report.summary.waitCount} wait, `
      + `${report.summary.failCount} fail\n`
    );
    if (report.nextAction) {
      process.stdout.write(
        `Next: ${report.nextAction.label} - ${report.nextAction.detail}\n`
      );
    }
  }
  if (
    report.summary.failCount > 0
    || (args.includes("--require-ready") && !report.summary.launchReady)
  ) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  await main();
}
