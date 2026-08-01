#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadWorkerConfig,
  runJson,
  wrangler
} from "./staging-gate-runtime.mjs";

export function evaluateEpisodeStagingGate(snapshot) {
  const nodes = [];
  const add = (status, id, label, detail) => {
    nodes.push({ status, id, label, detail });
  };
  const episode = snapshot.episode ?? null;
  const master = snapshot.workingMaster ?? null;
  const queryMeta = snapshot.queryMeta ?? [];
  const readOnly = queryMeta.length === 21
    && queryMeta.every((meta) =>
      Number(meta?.changes ?? 0) === 0
      && Number(meta?.rows_written ?? 0) === 0
      && meta?.changed_db !== true
    );
  add(
    readOnly ? "PASS" : "FAIL",
    "read_only",
    "Read-only boundary",
    readOnly
      ? "all remote statements reported zero writes"
      : "a remote statement reported database mutation"
  );

  if (!episode) {
    add("FAIL", "episode", "Episode identity", "episode not found");
  } else {
    const downstreamCount = downstreamWorkCount(snapshot);
    const safeDraft = episode.status === "draft"
      && Number(episode.publication_revision) === 0
      && downstreamCount === 0;
    add(
      safeDraft ? "PASS" : "FAIL",
      "episode",
      "Pre-publication posture",
      safeDraft
        ? "draft revision zero; no downstream publication work"
        : "episode or downstream state is not an isolated launch draft"
    );
  }

  const masterReady = Boolean(
    master?.selected
    && master?.origin_kind
    && master?.qc_status === "succeeded"
    && Number(master?.blocker_count) === 0
  );
  add(
    masterReady ? "PASS" : "BLOCK",
    "working_master",
    "Current working master",
    masterReady
      ? `revision ${master.master_revision}; ${master.origin_kind}`
      : "select a zero-blocker, current-policy working master"
  );

  const readyEnhancements = statusCount(
    snapshot.enhancementDerivatives,
    "ready"
  );
  const enhancedMaster = master?.origin_kind === "enhanced_derivative";
  add(
    enhancedMaster || readyEnhancements === 0 ? "PASS" : "BLOCK",
    "enhancement_decision",
    "Enhancement decision",
    enhancedMaster
      ? "the current master is the approved enhanced derivative"
      : readyEnhancements > 0
        ? "a private ready candidate needs a full listen and promote/reject decision before delivery rendering"
        : "no ready replacement candidate can immediately stale delivery work"
  );

  const approvedDelivery = (snapshot.deliveryAudioJobs ?? []).some((job) =>
    job.status === "approved" && Number(job.current_selected) === 1
  );
  const readyDelivery = statusCount(snapshot.deliveryAudioJobs, "ready");
  const deliverySelected = Number(episode?.delivery_selected) === 1;
  const deliveryReady = approvedDelivery
    && deliverySelected
    && episode?.media_status === "ready";
  add(
    deliveryReady ? "PASS" : readyDelivery > 0 ? "BLOCK" : "WAIT",
    "delivery_audio",
    "Delivery audio and player peaks",
    deliveryReady
      ? "approved normalized audio is selected"
      : readyDelivery > 0
        ? "ready render awaits exact recent Super-admin approval"
        : "queue only after the final working-master decision"
  );

  const sourceReviews = (snapshot.productionReviews ?? []).filter(
    ({ target_type }) => target_type === "source_audio"
  );
  const sourceReviewApproved = sourceReviews.some(
    ({ status }) => status === "approved"
  );
  const openBlockers = Number(snapshot.openReviewBlockers ?? 0);
  add(
    sourceReviewApproved && openBlockers === 0 ? "PASS" : "BLOCK",
    "source_review",
    "Current-audio production review",
    sourceReviewApproved && openBlockers === 0
      ? "approved with zero open blockers"
      : `${openBlockers} open blocker(s); final-master review is not approved`
  );

  const transcriptReady = (snapshot.transcripts ?? []).some((transcript) =>
    transcript.status === "approved"
    && Number(transcript.revision) > 0
    && Number(transcript.approved_revision) === Number(transcript.revision)
    && Number(transcript.speaker_labels_confirmed) === 1
  );
  add(
    transcriptReady ? "PASS" : "DEFER",
    "transcript",
    "Post-launch transcript review",
    transcriptReady
      ? "a current speaker-confirmed revision is approved"
      : "segment captions may launch privately; public transcript approval is deferred"
  );

  const alignmentReady = statusCount(
    snapshot.alignmentRevisions,
    "passed"
  ) > 0;
  add(
    alignmentReady ? "PASS" : "DEFER",
    "alignment",
    "Post-launch word alignment",
    alignmentReady
      ? "a benchmark-bound alignment revision passed"
      : "word-level controls stay disabled until the reviewed H1 benchmark passes"
  );

  const chapters = snapshot.chapters ?? null;
  const chaptersReady = chapters?.status === "approved"
    && Number(chapters.revision) > 0
    && Number(chapters.approved_revision) === Number(chapters.revision)
    && Number(snapshot.chapterCount) > 0;
  add(
    chaptersReady ? "PASS" : "DEFER",
    "chapters",
    "Post-launch chapter review",
    chaptersReady
      ? `${snapshot.chapterCount} approved chapter(s)`
      : "chapters remain optional and unpublished until a revision is approved"
  );

  const foreignKeysClean = Number(snapshot.foreignKeyViolations ?? 0) === 0;
  add(
    foreignKeysClean ? "PASS" : "FAIL",
    "foreign_keys",
    "D1 referential integrity",
    foreignKeysClean
      ? "PRAGMA foreign_key_check returned no rows"
      : `${snapshot.foreignKeyViolations} violation(s) found`
  );

  const failCount = nodes.filter(({ status }) => status === "FAIL").length;
  const blockCount = nodes.filter(({ status }) => status === "BLOCK").length;
  const waitCount = nodes.filter(({ status }) => status === "WAIT").length;
  const deferredCount = nodes.filter(({ status }) => status === "DEFER").length;
  const nextAction = nodes.find(
    ({ status }) => status === "BLOCK" || status === "WAIT"
  ) ?? null;
  return {
    schemaVersion: 1,
    nodes,
    nextAction: nextAction
      ? {
          id: nextAction.id,
          label: nextAction.label,
          detail: nextAction.detail
        }
      : null,
    summary: {
      passCount: nodes.filter(({ status }) => status === "PASS").length,
      failCount,
      blockCount,
      waitCount,
      deferredCount,
      safeToContinue: failCount === 0,
      launchReady: failCount === 0 && blockCount === 0 && waitCount === 0
    }
  };
}

export function loadEpisodeStagingSnapshot(episodeIdValue) {
  const episodeId = requiredEpisodeId(episodeIdValue);
  const config = loadWorkerConfig();
  const staging = config.env?.staging;
  if (!staging || staging.vars?.ENVIRONMENT !== "staging") {
    throw new Error("Exact staging configuration is required.");
  }
  const database = staging.d1_databases?.find(({ binding }) => binding === "DB");
  if (!database?.database_name) {
    throw new Error("Staging D1 binding is missing.");
  }
  const statements = stagingGateStatements(episodeId);
  const response = runJson(wrangler, [
    "d1",
    "execute",
    database.database_name,
    "--env",
    "staging",
    "--remote",
    "--json",
    "--command",
    statements
  ], { failureLabel: "read-only episode command" });
  if (!Array.isArray(response) || response.length !== 21) {
    throw new Error("D1 returned an incomplete staging-gate snapshot.");
  }
  const results = response.map((entry) => entry.results ?? []);
  return {
    episode: results[0][0] ?? null,
    workingMaster: results[1][0] ?? null,
    enhancementDerivatives: results[2],
    deliveryAudioJobs: results[3],
    transcripts: results[4],
    alignmentRevisions: results[5],
    alignmentJobs: results[6],
    chapters: results[7][0] ?? null,
    chapterCount: Number(results[8][0]?.count ?? 0),
    productionReviews: results[9],
    openReviewBlockers: Number(results[10][0]?.count ?? 0),
    clips: results[11],
    adPlans: results[12],
    distributionJobs: results[13],
    directoryPublications: results[14],
    sitePublications: results[15],
    youtubePublications: results[16],
    youtubeAudioRenditions: results[17],
    clipPublications: results[18],
    feedValidation: results[19][0] ?? null,
    foreignKeyViolations: results[20].length,
    queryMeta: response.map((entry) => entry.meta ?? {})
  };
}

function downstreamWorkCount(snapshot) {
  return [
    snapshot.distributionJobs,
    snapshot.directoryPublications,
    snapshot.sitePublications,
    snapshot.youtubePublications,
    snapshot.youtubeAudioRenditions,
    snapshot.clipPublications
  ].reduce(
    (total, rows) =>
      total + (rows ?? []).reduce(
        (count, row) => count + Number(row.count ?? 0),
        0
      ),
    0
  );
}

function statusCount(rows, status) {
  return (rows ?? []).reduce(
    (count, row) =>
      row.status === status ? count + Number(row.count ?? 0) : count,
    0
  );
}

function requiredEpisodeId(value) {
  const episodeId = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(episodeId)) {
    throw new Error("Episode ID must use only letters, numbers, _ or -.");
  }
  return episodeId;
}

function stagingGateStatements(episodeId) {
  return `SELECT
    status, access, media_status, source_language, publication_revision,
    publication_evidence_version,
    CASE WHEN audio_key IS NULL THEN 0 ELSE 1 END AS delivery_selected
  FROM episodes WHERE id = '${episodeId}';
  SELECT
    state.revision AS state_revision,
    CASE WHEN state.current_master_id IS NULL THEN 0 ELSE 1 END AS selected,
    master.revision AS master_revision,
    master.origin_kind,
    qc.status AS qc_status,
    qc.blocker_count
  FROM episode_working_master_states state
  LEFT JOIN episode_working_masters master
    ON master.id = state.current_master_id
  LEFT JOIN audio_qc_runs qc
    ON qc.id = master.quality_control_run_id
  WHERE state.episode_id = '${episodeId}';
  SELECT status, COUNT(*) AS count
  FROM audio_enhancement_derivatives
  WHERE episode_id = '${episodeId}' GROUP BY status;
  SELECT
    job.status,
    COUNT(*) AS count,
    MAX(CASE
      WHEN job.status = 'approved'
        AND job.source_master_id = state.current_master_id
        AND episode.audio_key = job.output_object_key
        AND episode.audio_bytes = job.output_object_bytes
        AND episode.audio_etag = job.output_object_etag
      THEN 1 ELSE 0
    END) AS current_selected
  FROM delivery_audio_jobs job
  JOIN episodes episode ON episode.id = job.episode_id
  JOIN episode_working_master_states state
    ON state.episode_id = episode.id
  WHERE job.episode_id = '${episodeId}' GROUP BY job.status;
  SELECT
    language, status, revision, approved_revision, speaker_labels_confirmed
  FROM transcripts WHERE episode_id = '${episodeId}' ORDER BY language;
  SELECT revision.status, COUNT(*) AS count
  FROM transcript_alignment_revisions revision
  JOIN transcripts transcript ON transcript.id = revision.transcript_id
  WHERE transcript.episode_id = '${episodeId}' GROUP BY revision.status;
  SELECT status, COUNT(*) AS count
  FROM transcript_alignment_jobs
  WHERE episode_id = '${episodeId}' GROUP BY status;
  SELECT status, revision, approved_revision
  FROM episode_chapter_sets WHERE episode_id = '${episodeId}';
  SELECT COUNT(*) AS count
  FROM episode_chapters WHERE episode_id = '${episodeId}';
  SELECT review.target_type, review.status, COUNT(*) AS count
  FROM production_reviews review
  JOIN episode_working_master_states state
    ON state.episode_id = review.episode_id
  JOIN episode_working_masters master
    ON master.id = state.current_master_id
   AND master.episode_id = state.episode_id
   AND master.revision = state.revision
  WHERE review.episode_id = '${episodeId}'
    AND review.target_type = 'source_audio'
    AND review.target_id = state.current_master_id
    AND review.target_revision = state.revision
    AND review.target_digest = master.source_sha256
  GROUP BY review.target_type, review.status;
  SELECT COUNT(*) AS count
  FROM production_review_comments comment
  WHERE comment.blocker = 1 AND comment.resolution_status = 'open'
    AND review_id IN (
      SELECT review.id
      FROM production_reviews review
      JOIN episode_working_master_states state
        ON state.episode_id = review.episode_id
      JOIN episode_working_masters master
        ON master.id = state.current_master_id
       AND master.episode_id = state.episode_id
       AND master.revision = state.revision
      WHERE review.episode_id = '${episodeId}'
        AND review.target_type = 'source_audio'
        AND review.target_id = state.current_master_id
        AND review.target_revision = state.revision
        AND review.target_digest = master.source_sha256
    );
  SELECT status, COUNT(*) AS count
  FROM clips WHERE episode_id = '${episodeId}' GROUP BY status;
  SELECT status, COUNT(*) AS count
  FROM episode_ad_plans WHERE episode_id = '${episodeId}' GROUP BY status;
  SELECT destination, status, COUNT(*) AS count
  FROM distribution_jobs WHERE episode_id = '${episodeId}'
  GROUP BY destination, status;
  SELECT status, COUNT(*) AS count
  FROM episode_publications WHERE episode_id = '${episodeId}' GROUP BY status;
  SELECT status, COUNT(*) AS count
  FROM site_publications WHERE episode_id = '${episodeId}' GROUP BY status;
  SELECT status, COUNT(*) AS count
  FROM episode_youtube_publications
  WHERE episode_id = '${episodeId}' GROUP BY status;
  SELECT status, COUNT(*) AS count
  FROM episode_youtube_audio_renditions
  WHERE episode_id = '${episodeId}' GROUP BY status;
  SELECT status, COUNT(*) AS count
  FROM clip_publications WHERE episode_id = '${episodeId}' GROUP BY status;
  SELECT status, item_count
  FROM show_feed_validations
  WHERE show_id = (
    SELECT show_id FROM episodes WHERE id = '${episodeId}'
  );
  PRAGMA foreign_key_check;`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: npm run gate:episode:staging -- <episode-id> "
      + "[--require-ready] [--json]\n\n"
      + "Reads only content-free staging workflow status and D1 integrity. "
      + "It never returns transcript text, object keys, hashes, review "
      + "comments, email, or admin identity.\n"
    );
    return;
  }
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length !== 1) {
    throw new Error("Exactly one episode ID is required.");
  }
  const report = evaluateEpisodeStagingGate(
    loadEpisodeStagingSnapshot(positionals[0])
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
      + `${report.summary.deferredCount} deferred, `
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
