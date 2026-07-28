import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "@dustwave/worker-core/crypto";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import { processRssImportExecutionItem } from "../src/rss-import-executions";
import { parsePodcastRssImportPreview } from "../src/rss-import-preview";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const siteOrigin = "https://dust-wave-website-staging.pages.dev";
const apiOrigin = "https://dust-wave-podcast-staging.jogo.workers.dev";
const sessionSecret = "rss_import_execution_session_secret";
const sessionToken = "rss_import_execution_session";
const csrfToken = "rss_import_execution_csrf";
const urlSecret = "rss_import_url_secret_at_least_32_characters";
const feedUrl =
  "https://podcast.example.org/feed.xml?token=private-feed-token";
const audioUrl =
  "https://cdn.example.org/audio/uno.mp3?token=private-audio-token";
const audio = new TextEncoder().encode("ID3-private-import-fixture");

let harnesses = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const harness of harnesses) harness.database.close();
  harnesses = [];
});

describe("RSS import executions", () => {
  it("streams one reviewed source into private R2 and a draft without publishing", async () => {
    installDigestStream();
    const harness = await createHarness();
    const plan = await createReviewedPlan(harness);
    const provider = vi.fn(async (input) => {
      const url = String(input);
      if (url === feedUrl) return feedResponse(validPodcastFeed());
      if (url === audioUrl) {
        return new Response(audio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "content-length": String(audio.byteLength)
          }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", provider);
    const executionRequestBody = {
      executionId: "rss_execution_fixture",
      feedUrl,
      expectedFeedSha256: plan.feedSha256,
      expectedSelectionSha256: plan.selectionSha256,
      executionConfirmed: true,
      items: [{
        sourceIdentitySha256:
          plan.items[0].sourceIdentitySha256,
        targetSlug: "episodio-importado",
        sourceLanguage: "es"
      }]
    };

    const queued = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/execution`,
        executionRequestBody
      ),
      harness.env
    );
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({
      execution: {
        id: "rss_execution_fixture",
        status: "queued",
        expectedItemCount: 1,
        copiedItemCount: 0,
        draftItemCount: 0,
        sourceUrlRetained: true,
        items: [{
          targetSlug: "episodio-importado",
          status: "queued"
        }]
      },
      idempotent: false,
      publicationMutationPerformed: false,
      redirectMutationPerformed: false,
      providerContactPerformed: false
    });
    expect(harness.queueMessages).toHaveLength(1);
    expect(JSON.stringify(harness.queueMessages)).not.toContain(
      "private-feed-token"
    );
    expect(JSON.stringify(harness.queueMessages)).not.toContain(
      "private-audio-token"
    );
    expect(harness.persistedExecutionText()).not.toContain(
      "private-feed-token"
    );
    expect(harness.persistedExecutionText()).not.toContain(
      "private-audio-token"
    );
    expect(harness.episodeCount()).toBe(0);
    expect(harness.puts).toBe(0);

    const exactRetry = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/execution`,
        executionRequestBody
      ),
      harness.env
    );
    expect(exactRetry.status).toBe(200);
    expect(await exactRetry.json()).toMatchObject({
      execution: { id: "rss_execution_fixture", status: "queued" },
      idempotent: true
    });
    expect(harness.queueMessages).toHaveLength(1);

    const job = harness.queueMessages[0];
    await processRssImportExecutionItem(harness.env, job);

    expect(harness.puts).toBe(1);
    expect(harness.deletes).toBe(0);
    expect(harness.storedBytes()).toEqual(audio);
    expect(harness.storedMetadata()).toMatchObject({
      kind: "rss_import_source_audio",
      executionId: "rss_execution_fixture",
      planId: plan.id,
      sourceIdentitySha256: plan.items[0].sourceIdentitySha256
    });
    const episode = harness.database.prepare(
      `SELECT
         id, show_id, slug, title, summary, status, access, public_at,
         audio_key, source_audio_key, media_status, source_language
       FROM episodes
       WHERE slug = 'episodio-importado'`
    ).get();
    expect(episode).toMatchObject({
      slug: "episodio-importado",
      title: "Episodio uno",
      summary: "Una introducción bilingüe.",
      status: "draft",
      access: "public",
      public_at: "2026-07-26T12:00:00.000Z",
      audio_key: null,
      media_status: "processing",
      source_language: "es"
    });
    expect(episode.source_audio_key).toContain(
      "/source_audio/rss-import-rss_execution_fixture.mp3"
    );
    const upload = harness.database.prepare(
      `SELECT
         kind, status, content_type, expected_bytes, completed_bytes,
         object_etag
       FROM media_uploads
       WHERE episode_id = ?`
    ).get(episode.id);
    expect(upload).toMatchObject({
      kind: "source_audio",
      status: "completed",
      content_type: "audio/mpeg",
      expected_bytes: audio.byteLength,
      completed_bytes: audio.byteLength,
      object_etag: '"rss-import-etag"'
    });
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM distribution_jobs"
    ).get().count).toBe(0);
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM site_publications"
    ).get().count).toBe(0);
    const execution = harness.database.prepare(
      `SELECT
         status, copied_item_count, draft_item_count, failed_item_count,
         feed_url_ciphertext
       FROM rss_import_executions
       WHERE id = 'rss_execution_fixture'`
    ).get();
    expect(execution).toMatchObject({
      status: "succeeded",
      copied_item_count: 1,
      draft_item_count: 1,
      failed_item_count: 0,
      feed_url_ciphertext:
        "not_retained:rss_import_execution_complete:v1"
    });
    const item = harness.database.prepare(
      `SELECT
         status, copied_bytes, copied_sha256, copied_mime_type,
         episode_id, last_error_code
       FROM rss_import_execution_items
       WHERE execution_id = 'rss_execution_fixture'`
    ).get();
    expect(item).toMatchObject({
      status: "succeeded",
      copied_bytes: audio.byteLength,
      copied_sha256: createHash("sha256").update(audio).digest("hex"),
      copied_mime_type: "audio/mpeg",
      episode_id: episode.id,
      last_error_code: null
    });
    expect(harness.persistedExecutionText()).not.toContain(
      "private-feed-token"
    );
    expect(harness.persistedExecutionText()).not.toContain(
      "private-audio-token"
    );

    const fetchesAfterSuccess = provider.mock.calls.length;
    await processRssImportExecutionItem(harness.env, job);
    expect(provider).toHaveBeenCalledTimes(fetchesAfterSuccess);
    expect(harness.puts).toBe(1);
    expect(harness.episodeCount()).toBe(1);

    const listed = await handleRequest(
      adminGet(`/v1/admin/rss-import/plans/${plan.id}/execution`),
      harness.env
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      execution: {
        status: "succeeded",
        copiedItemCount: 1,
        draftItemCount: 1,
        sourceUrlRetained: false
      },
      publicationMutationPerformed: false
    });
    const reconciliationPreview = await handleRequest(
      adminGet(
        `/v1/admin/rss-import/plans/${plan.id}/reconciliation`
      ),
      harness.env
    );
    expect(reconciliationPreview.status).toBe(200);
    const reconciliationState = await reconciliationPreview.json();
    expect(reconciliationState).toMatchObject({
      reconciliationAvailable: true,
      executionId: "rss_execution_fixture",
      readiness: {
        itemCount: 1,
        copiedBytes: audio.byteLength,
        copyReady: true,
        prePublicationReady: true,
        readyForApproval: true,
        blockers: [],
        items: [{
          targetSlug: "episodio-importado",
          copyReady: true,
          privateObjectVerified: true,
          draftIdentityVerified: true,
          sourceUploadVerified: true,
          blockers: []
        }]
      },
      approval: null,
      oldHostRedirectChecklist: {
        activationAvailable: false,
        ready: false,
        checks: {
          ownerReconciliationApproved: false,
          importedEpisodesPublic: false,
          canonicalFeedRevalidated: false,
          directoryCertificationReady: false,
          ownerRedirectAttested: false
        }
      },
      r2MutationPerformed: false,
      episodeMutationPerformed: false,
      publicationMutationPerformed: false,
      redirectMutationPerformed: false,
      providerContactPerformed: false
    });
    const reconciliationRequestBody = {
      reconciliationId: "rss_reconciliation_fixture",
      expectedEvidenceSha256:
        reconciliationState.readiness.evidenceSha256,
      reconciliationConfirmed: true
    };
    const reconciliationApproval = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/reconciliation`,
        reconciliationRequestBody
      ),
      harness.env
    );
    expect(reconciliationApproval.status).toBe(201);
    expect(await reconciliationApproval.json()).toMatchObject({
      approval: {
        id: "rss_reconciliation_fixture",
        fresh: true
      },
      readiness: { readyForApproval: false },
      idempotent: false,
      redirectMutationPerformed: false
    });
    const reconciliationRetry = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/reconciliation`,
        reconciliationRequestBody
      ),
      harness.env
    );
    expect(reconciliationRetry.status).toBe(200);
    expect(await reconciliationRetry.json()).toMatchObject({
      approval: { id: "rss_reconciliation_fixture", fresh: true },
      idempotent: true
    });
    const wrongFeedAttestation = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/redirect-attestation`,
        {
          attestationId: "rss_redirect_attestation_wrong_feed",
          feedUrl: "https://podcast.example.org/other.xml",
          expectedReconciliationEvidenceSha256:
            reconciliationState.readiness.evidenceSha256,
          redirectMethod: "provider_managed_redirect",
          ownerControlConfirmed: true,
          permanenceAcknowledged: true,
          noActivationConfirmed: true
        }
      ),
      harness.env
    );
    expect(wrongFeedAttestation.status).toBe(409);
    expect(await wrongFeedAttestation.json()).toEqual({
      error: "rss_import_redirect_attestation_changed"
    });
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM rss_import_redirect_attestations"
    ).get().count).toBe(0);
    const redirectAttestationBody = {
      attestationId: "rss_redirect_attestation_fixture",
      feedUrl,
      expectedReconciliationEvidenceSha256:
        reconciliationState.readiness.evidenceSha256,
      redirectMethod: "provider_managed_redirect",
      ownerControlConfirmed: true,
      permanenceAcknowledged: true,
      noActivationConfirmed: true
    };
    const redirectAttestation = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/redirect-attestation`,
        redirectAttestationBody
      ),
      harness.env
    );
    expect(redirectAttestation.status).toBe(201);
    const redirectAttestationState = await redirectAttestation.json();
    expect(redirectAttestationState).toMatchObject({
      idempotent: false,
      redirectAttestationMutationPerformed: true,
      redirectMutationPerformed: false,
      providerContactPerformed: false,
      oldHostRedirectChecklist: {
        activationAvailable: false,
        ready: false,
        attestationAvailable: true,
        attestation: {
          id: "rss_redirect_attestation_fixture",
          redirectMethod: "provider_managed_redirect",
          fresh: true
        },
        checks: {
          ownerRedirectAttested: true
        }
      }
    });
    expect(
      redirectAttestationState.oldHostRedirectChecklist.blockers
    ).toContain("rss_import_redirect_activation_unavailable");
    expect(
      redirectAttestationState.oldHostRedirectChecklist.blockers
    ).not.toContain("rss_import_old_host_attestation_required");
    const redirectAttestationRetry = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/redirect-attestation`,
        redirectAttestationBody
      ),
      harness.env
    );
    expect(redirectAttestationRetry.status).toBe(200);
    expect(await redirectAttestationRetry.json()).toMatchObject({
      idempotent: true,
      redirectAttestationMutationPerformed: false,
      oldHostRedirectChecklist: {
        attestation: {
          id: "rss_redirect_attestation_fixture",
          fresh: true
        }
      }
    });
    const conflictingAttestation = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/redirect-attestation`,
        {
          ...redirectAttestationBody,
          attestationId: "rss_redirect_attestation_conflict"
        }
      ),
      harness.env
    );
    expect(conflictingAttestation.status).toBe(409);
    expect(await conflictingAttestation.json()).toEqual({
      error: "rss_import_redirect_attestation_conflict"
    });
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM rss_import_redirect_attestations"
    ).get().count).toBe(1);
    expect(() => harness.database.prepare(
      `UPDATE rss_import_redirect_attestations
       SET redirect_method = 'self_managed_http_301'
       WHERE id = 'rss_redirect_attestation_fixture'`
    ).run()).toThrow("rss_import_redirect_attestation_immutable");
    expect(() => harness.database.prepare(
      `UPDATE rss_import_execution_items
       SET copied_bytes = copied_bytes + 1
       WHERE execution_id = 'rss_execution_fixture'`
    ).run()).toThrow("rss_import_execution_reconciled");
    expect(redirectAttestationState.cutoverReadiness).toMatchObject({
      activationAvailable: false,
      evidenceReady: false,
      readyForPacket: false,
      importedEpisodeCount: 1,
      publicEpisodeCount: 0,
      requiredDestinationCount: 10,
      packet: null
    });
    expect(
      redirectAttestationState.cutoverReadiness.blockers
    ).toEqual(expect.arrayContaining([
      "rss_import_cutover_episode_not_public",
      "rss_import_cutover_rss_not_published",
      "rss_import_cutover_news_not_published",
      "rss_import_cutover_feed_not_current",
      "rss_import_cutover_directory_certification_required",
      "rss_import_cutover_directory_reobservation_required"
    ]));
    const blockedCutover = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/cutover-packet`,
        {
          packetId: "rss_cutover_blocked",
          expectedEvidenceSha256:
            redirectAttestationState.cutoverReadiness.evidenceSha256,
          ownerReviewConfirmed: true,
          noActivationConfirmed: true
        }
      ),
      harness.env
    );
    expect(blockedCutover.status).toBe(409);
    expect(await blockedCutover.json()).toEqual({
      error: "rss_import_cutover_not_ready"
    });
    makeCutoverReady(harness.database, episode.id);
    harness.database.prepare(
      `UPDATE show_feed_validations
       SET validator_version = 'dustwave-rss-launch-v1'
       WHERE show_id = ?`
    ).run(episode.show_id);
    const staleValidatorPreview = await handleRequest(
      adminGet(
        `/v1/admin/rss-import/plans/${plan.id}/reconciliation`
      ),
      harness.env
    );
    expect(staleValidatorPreview.status).toBe(200);
    expect(
      (await staleValidatorPreview.json()).cutoverReadiness
    ).toMatchObject({
      evidenceReady: false,
      readyForPacket: false,
      blockers: expect.arrayContaining([
        "rss_import_cutover_feed_not_current"
      ])
    });
    harness.database.prepare(
      `UPDATE show_feed_validations
       SET validator_version = 'dustwave-rss-launch-v2'
       WHERE show_id = ?`
    ).run(episode.show_id);
    const cutoverPreview = await handleRequest(
      adminGet(
        `/v1/admin/rss-import/plans/${plan.id}/reconciliation`
      ),
      harness.env
    );
    expect(cutoverPreview.status).toBe(200);
    const cutoverState = await cutoverPreview.json();
    expect(cutoverState.cutoverReadiness).toMatchObject({
      activationAvailable: false,
      evidenceReady: true,
      readyForPacket: true,
      importedEpisodeCount: 1,
      publicEpisodeCount: 1,
      feedItemCount: 1,
      expectedFeedItemCount: 1,
      certifiedDestinationCount: 10,
      reobservedDestinationCount: 10,
      requiredDestinationCount: 10,
      blockers: [],
      packet: null,
      items: [{
        episodeId: episode.id,
        publicationRevision: 1,
        public: true,
        rssPublished: true,
        newsPublished: true,
        blockers: []
      }]
    });
    const cutoverRequestBody = {
      packetId: "rss_cutover_fixture",
      expectedEvidenceSha256:
        cutoverState.cutoverReadiness.evidenceSha256,
      ownerReviewConfirmed: true,
      noActivationConfirmed: true
    };
    const cutoverCreated = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/cutover-packet`,
        cutoverRequestBody
      ),
      harness.env
    );
    expect(cutoverCreated.status).toBe(201);
    expect(await cutoverCreated.json()).toMatchObject({
      idempotent: false,
      cutoverPacketMutationPerformed: true,
      r2MutationPerformed: false,
      episodeMutationPerformed: false,
      publicationMutationPerformed: false,
      redirectMutationPerformed: false,
      providerContactPerformed: false,
      cutoverReadiness: {
        evidenceReady: true,
        readyForPacket: false,
        packet: {
          id: "rss_cutover_fixture",
          fresh: true,
          importedEpisodeCount: 1,
          reobservedDestinationCount: 10
        }
      }
    });
    const cutoverRetry = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/cutover-packet`,
        cutoverRequestBody
      ),
      harness.env
    );
    expect(cutoverRetry.status).toBe(200);
    expect(await cutoverRetry.json()).toMatchObject({
      idempotent: true,
      cutoverPacketMutationPerformed: false,
      cutoverReadiness: {
        packet: { id: "rss_cutover_fixture", fresh: true }
      }
    });
    const cutoverConflict = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/cutover-packet`,
        {
          ...cutoverRequestBody,
          packetId: "rss_cutover_conflict"
        }
      ),
      harness.env
    );
    expect(cutoverConflict.status).toBe(409);
    expect(await cutoverConflict.json()).toEqual({
      error: "rss_import_cutover_packet_conflict"
    });
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM rss_import_cutover_packets"
    ).get().count).toBe(1);
    expect(() => harness.database.prepare(
      `UPDATE rss_import_cutover_packets
       SET certified_destination_count = 11
       WHERE id = 'rss_cutover_fixture'`
    ).run()).toThrow("rss_import_cutover_packet_immutable");
    const canceled = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/cancel`,
        {
          expectedSelectionSha256: plan.selectionSha256,
          reason: "Execution already created"
        }
      ),
      harness.env
    );
    expect(canceled.status).toBe(409);
    expect(await canceled.json()).toEqual({
      error: "rss_import_plan_has_execution"
    });
  });

  it("fails closed on changed audio metadata and creates no draft", async () => {
    installDigestStream();
    const harness = await createHarness();
    const plan = await createReviewedPlan(harness);
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input) === feedUrl) {
        return feedResponse(validPodcastFeed());
      }
      return new Response(audio, {
        status: 200,
        headers: {
          "content-type": "audio/ogg",
          "content-length": String(audio.byteLength)
        }
      });
    }));
    const queued = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/execution`,
        {
          executionId: "rss_execution_mime_failure",
          feedUrl,
          expectedFeedSha256: plan.feedSha256,
          expectedSelectionSha256: plan.selectionSha256,
          executionConfirmed: true,
          items: [{
            sourceIdentitySha256:
              plan.items[0].sourceIdentitySha256,
            targetSlug: "episodio-fallido",
            sourceLanguage: "es"
          }]
        }
      ),
      harness.env
    );
    expect(queued.status).toBe(202);
    await expect(
      processRssImportExecutionItem(
        harness.env,
        harness.queueMessages[0]
      )
    ).rejects.toThrow("rss_import_audio_content_type_changed");
    expect(harness.episodeCount()).toBe(0);
    expect(harness.puts).toBe(0);
    expect(harness.database.prepare(
      `SELECT status, last_error_code
       FROM rss_import_execution_items
       WHERE execution_id = 'rss_execution_mime_failure'`
    ).get()).toEqual({
      status: "failed",
      last_error_code: "rss_import_audio_content_type_changed"
    });
  });

  it("removes an overlong streamed object and creates no draft", async () => {
    installDigestStream();
    const harness = await createHarness();
    const plan = await createReviewedPlan(harness);
    const oversized = new Uint8Array(audio.byteLength + 1);
    oversized.set(audio);
    oversized[oversized.length - 1] = 1;
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input) === feedUrl) {
        return feedResponse(validPodcastFeed());
      }
      return new Response(oversized, {
        status: 200,
        headers: { "content-type": "audio/mpeg" }
      });
    }));
    const queued = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/execution`,
        {
          executionId: "rss_execution_size_failure",
          feedUrl,
          expectedFeedSha256: plan.feedSha256,
          expectedSelectionSha256: plan.selectionSha256,
          executionConfirmed: true,
          items: [{
            sourceIdentitySha256:
              plan.items[0].sourceIdentitySha256,
            targetSlug: "episodio-size-failure",
            sourceLanguage: "es"
          }]
        }
      ),
      harness.env
    );
    expect(queued.status).toBe(202);
    await expect(
      processRssImportExecutionItem(
        harness.env,
        harness.queueMessages[0]
      )
    ).rejects.toThrow("rss_import_audio_size_mismatch");
    expect(harness.deletes).toBe(1);
    expect(harness.storedBytes()).toBeUndefined();
    expect(harness.episodeCount()).toBe(0);
    expect(harness.database.prepare(
      `SELECT status, last_error_code
       FROM rss_import_execution_items
       WHERE execution_id = 'rss_execution_size_failure'`
    ).get()).toEqual({
      status: "failed",
      last_error_code: "rss_import_audio_size_mismatch"
    });
  });

  it("does not create an execution if review is canceled during reconciliation", async () => {
    const harness = await createHarness();
    const plan = await createReviewedPlan(harness);
    let canceled = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!canceled) {
        harness.database.prepare(
          `UPDATE rss_import_plans
           SET
             status = 'canceled',
             canceled_by_admin_user_id = 'rss_execution_admin',
             cancellation_reason_sha256 = ?,
             canceled_at = datetime('now'),
             updated_at = datetime('now')
           WHERE id = ?`
        ).run("c".repeat(64), plan.id);
        canceled = true;
      }
      return feedResponse(validPodcastFeed());
    }));
    const response = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/execution`,
        {
          executionId: "rss_execution_canceled_race",
          feedUrl,
          expectedFeedSha256: plan.feedSha256,
          expectedSelectionSha256: plan.selectionSha256,
          executionConfirmed: true,
          items: [{
            sourceIdentitySha256:
              plan.items[0].sourceIdentitySha256,
            targetSlug: "episodio-canceled-race",
            sourceLanguage: "es"
          }]
        }
      ),
      harness.env
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "rss_import_plan_not_reviewed"
    });
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM rss_import_executions"
    ).get().count).toBe(0);
    expect(harness.queueMessages).toHaveLength(0);
    expect(harness.episodeCount()).toBe(0);
    expect(harness.puts).toBe(0);
  });

  it("blocks reconciliation when private R2 evidence changed", async () => {
    installDigestStream();
    const harness = await createHarness();
    const plan = await createReviewedPlan(harness);
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input) === feedUrl) return feedResponse(validPodcastFeed());
      return new Response(audio, {
        status: 200,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": String(audio.byteLength)
        }
      });
    }));
    const queued = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/execution`,
        {
          executionId: "rss_execution_tampered_object",
          feedUrl,
          expectedFeedSha256: plan.feedSha256,
          expectedSelectionSha256: plan.selectionSha256,
          executionConfirmed: true,
          items: [{
            sourceIdentitySha256:
              plan.items[0].sourceIdentitySha256,
            targetSlug: "episodio-tampered-object",
            sourceLanguage: "es"
          }]
        }
      ),
      harness.env
    );
    expect(queued.status).toBe(202);
    await processRssImportExecutionItem(
      harness.env,
      harness.queueMessages[0]
    );
    harness.tamperStoredMetadata();
    const preview = await handleRequest(
      adminGet(
        `/v1/admin/rss-import/plans/${plan.id}/reconciliation`
      ),
      harness.env
    );
    expect(preview.status).toBe(200);
    const state = await preview.json();
    expect(state.readiness).toMatchObject({
      copyReady: false,
      prePublicationReady: false,
      readyForApproval: false
    });
    expect(state.readiness.blockers).toContain(
      "rss_import_private_object_mismatch"
    );
    const approval = await handleRequest(
      adminRequest(
        `/v1/admin/rss-import/plans/${plan.id}/reconciliation`,
        {
          reconciliationId: "rss_reconciliation_tampered",
          expectedEvidenceSha256: state.readiness.evidenceSha256,
          reconciliationConfirmed: true
        }
      ),
      harness.env
    );
    expect(approval.status).toBe(409);
    expect(await approval.json()).toEqual({
      error: "rss_import_reconciliation_not_ready"
    });
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM rss_import_reconciliations"
    ).get().count).toBe(0);
  });

  it("keeps production-disabled execution closed before D1, Queue, or R2", async () => {
    let touched = 0;
    const closed = await handleRequest(
      adminRequest(
        "/v1/admin/rss-import/plans/plan_fixture/execution",
        {}
      ),
      {
        ENVIRONMENT: "production",
        RSS_IMPORT_EXECUTION_MODE: "disabled",
        ALLOWED_ORIGINS: siteOrigin,
        DB: {
          prepare() {
            touched += 1;
            throw new Error("D1 must stay closed");
          }
        },
        JOBS: {
          async send() {
            touched += 1;
          }
        },
        MEDIA_BUCKET: {
          async put() {
            touched += 1;
          }
        }
      }
    );
    expect(closed.status).toBe(404);
    expect(await closed.json()).toEqual({
      error: "rss_import_execution_unavailable"
    });
    const reconciliationClosed = await handleRequest(
      adminRequest(
        "/v1/admin/rss-import/plans/plan_fixture/reconciliation",
        {}
      ),
      {
        ENVIRONMENT: "production",
        RSS_IMPORT_EXECUTION_MODE: "disabled",
        ALLOWED_ORIGINS: siteOrigin,
        DB: {
          prepare() {
            touched += 1;
            throw new Error("D1 must stay closed");
          }
        },
        MEDIA_BUCKET: {
          async head() {
            touched += 1;
          }
        }
      }
    );
    expect(reconciliationClosed.status).toBe(404);
    expect(await reconciliationClosed.json()).toEqual({
      error: "rss_import_reconciliation_unavailable"
    });
    const attestationClosed = await handleRequest(
      adminRequest(
        "/v1/admin/rss-import/plans/plan_fixture/redirect-attestation",
        {}
      ),
      {
        ENVIRONMENT: "production",
        RSS_IMPORT_EXECUTION_MODE: "disabled",
        ALLOWED_ORIGINS: siteOrigin,
        DB: {
          prepare() {
            touched += 1;
            throw new Error("D1 must stay closed");
          }
        },
        MEDIA_BUCKET: {
          async head() {
            touched += 1;
          }
        }
      }
    );
    expect(attestationClosed.status).toBe(404);
    expect(await attestationClosed.json()).toEqual({
      error: "rss_import_reconciliation_unavailable"
    });
    const cutoverClosed = await handleRequest(
      adminRequest(
        "/v1/admin/rss-import/plans/plan_fixture/cutover-packet",
        {}
      ),
      {
        ENVIRONMENT: "production",
        RSS_IMPORT_EXECUTION_MODE: "disabled",
        ALLOWED_ORIGINS: siteOrigin,
        DB: {
          prepare() {
            touched += 1;
            throw new Error("D1 must stay closed");
          }
        },
        MEDIA_BUCKET: {
          async head() {
            touched += 1;
          }
        }
      }
    );
    expect(cutoverClosed.status).toBe(404);
    expect(await cutoverClosed.json()).toEqual({
      error: "rss_import_reconciliation_unavailable"
    });
    expect(touched).toBe(0);
  });
});

async function createReviewedPlan(harness) {
  const preview = await parsePodcastRssImportPreview(
    validPodcastFeed(),
    feedUrl
  );
  vi.stubGlobal("fetch", vi.fn(async () =>
    feedResponse(validPodcastFeed())
  ));
  const created = await handleRequest(
    adminRequest(
      "/v1/admin/shows/show_opera_en_la_selva/rss-import/plans",
      {
        planId: "rss_plan_for_execution",
        feedUrl,
        ownershipConfirmed: true,
        expectedFeedSha256: preview.feedSha256,
        selectedSourceIdentitySha256: [
          preview.episodes[0].sourceIdentitySha256
        ]
      }
    ),
    harness.env
  );
  expect(created.status).toBe(200);
  const plan = (await created.json()).plan;
  const reviewed = await handleRequest(
    adminRequest(
      `/v1/admin/rss-import/plans/${plan.id}/review`,
      {
        feedUrl,
        ownershipConfirmed: true,
        expectedFeedSha256: plan.feedSha256,
        expectedSelectionSha256: plan.selectionSha256,
        reviewConfirmed: true
      }
    ),
    harness.env
  );
  expect(reviewed.status).toBe(200);
  return (await reviewed.json()).plan;
}

function makeCutoverReady(database, episodeId) {
  database.prepare(
    `UPDATE episodes
     SET
       status = 'published',
       public_at = '2026-07-28T08:00:00.000Z',
       audio_key = 'podcasts/opera/episodes/imported/delivery.mp3',
       audio_mime_type = 'audio/mpeg',
       audio_bytes = 2048,
       audio_etag = '"delivery-etag"',
       audio_filename = 'episodio-importado.mp3',
       media_status = 'ready',
       publication_revision = 1,
       updated_at = '2026-07-28T09:00:00.000Z'
     WHERE id = ?`
  ).run(episodeId);
  for (const destination of ["rss", "news"]) {
    database.prepare(
      `INSERT INTO distribution_jobs (
         id, episode_id, destination, status, scheduled_at,
         started_at, completed_at, idempotency_key,
         publication_revision
       ) VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, 1)`
    ).run(
      `cutover_job_${destination}`,
      episodeId,
      destination,
      "2026-07-28T09:30:00.000Z",
      "2026-07-28T09:31:00.000Z",
      "2026-07-28T10:00:00.000Z",
      `cutover:${destination}:${episodeId}:1`
    );
  }
  const episode = database.prepare(
    "SELECT show_id, canonical_url FROM episodes WHERE id = ?"
  ).get(episodeId);
  database.prepare(
    `INSERT INTO site_publications (
       id, show_id, episode_id, publication_revision,
       canonical_url, status, idempotency_key, updated_at
     ) VALUES (
       'cutover_site_publication', ?, ?, 1, ?,
       'succeeded', ?, '2026-07-28T10:00:00.000Z'
     )`
  ).run(
    episode.show_id,
    episodeId,
    episode.canonical_url,
    `news:${episodeId}:1`
  );
  const show = database.prepare(
    "SELECT rss_slug FROM shows WHERE id = ?"
  ).get(episode.show_id);
  database.prepare(
    `INSERT INTO show_feed_validations (
       show_id, status, feed_url, validator_version,
       feed_sha256, item_count, checked_at, validated_at
     ) VALUES (
       ?, 'valid', ?, 'dustwave-rss-launch-v2',
       ?, 1, '2026-07-28T12:00:00.000Z',
       '2026-07-28T12:00:00.000Z'
     )`
  ).run(
    episode.show_id,
    `${apiOrigin}/${show.rss_slug}/rss.xml`,
    "f".repeat(64)
  );
  const destinations = database.prepare(
    `SELECT destination_id
     FROM show_distribution_destinations
     WHERE show_id = ?
     ORDER BY destination_id
     LIMIT 10`
  ).all(episode.show_id);
  for (const [index, destination] of destinations.entries()) {
    database.prepare(
      `UPDATE show_distribution_destinations
       SET
         enabled = 1,
         owner_setup_status = 'verified',
         owner_verified_at = '2026-07-28T11:00:00.000Z',
         updated_at = '2026-07-28T11:00:00.000Z'
       WHERE show_id = ? AND destination_id = ?`
    ).run(episode.show_id, destination.destination_id);
    database.prepare(
      `INSERT INTO distribution_observation_events (
         id, show_id, episode_id, destination_id,
         publication_revision, status, failure_detail,
         evidence_source, recorded_at
       ) VALUES (
         ?, ?, ?, ?, 1, 'failed', 'Controlled recovery fixture',
         'manual_review', '2026-07-28T11:30:00.000Z'
       )`
    ).run(
      `cutover_failed_${index}`,
      episode.show_id,
      episodeId,
      destination.destination_id
    );
    database.prepare(
      `INSERT INTO distribution_observation_events (
         id, show_id, episode_id, destination_id,
         publication_revision, status, evidence_url,
         evidence_source, recorded_at
       ) VALUES (
         ?, ?, ?, ?, 1, 'observed', ?,
         'manual_review', '2026-07-28T13:00:00.000Z'
       )`
    ).run(
      `cutover_observed_${index}`,
      episode.show_id,
      episodeId,
      destination.destination_id,
      `https://directory.example.org/${destination.destination_id}`
    );
  }
}

async function createHarness() {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const sessionTokenHash = await sha256Hex(
    `${sessionSecret}:${sessionToken}`
  );
  const csrfTokenHash = await sha256Hex(
    `${sessionSecret}:${csrfToken}`
  );
  database.prepare(`
    INSERT INTO admin_users (
      id, email_lookup_hash, status, activated_at, last_authenticated_at
    ) VALUES (
      'rss_execution_admin',
      ?,
      'active',
      datetime('now'),
      datetime('now')
    )
  `).run("d".repeat(64));
  database.prepare(`
    INSERT INTO admin_user_roles (
      id, admin_user_id, role, show_id
    ) VALUES (
      'rss_execution_role',
      'rss_execution_admin',
      'super_admin',
      NULL
    )
  `).run();
  database.prepare(`
    INSERT INTO admin_sessions (
      token_hash, admin_user_id, csrf_token_hash, expires_at
    ) VALUES (?, 'rss_execution_admin', ?, datetime('now', '+1 hour'))
  `).run(sessionTokenHash, csrfTokenHash);

  const queueMessages = [];
  let puts = 0;
  let deletes = 0;
  let stored = null;
  const bucket = {
    async put(key, body, options) {
      puts += 1;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      stored = { key, bytes, options };
      return storedObject(stored);
    },
    async head(key) {
      return stored?.key === key ? storedObject(stored) : null;
    },
    async delete(key) {
      deletes += 1;
      if (stored?.key === key) stored = null;
    }
  };
  const harness = {
    database,
    queueMessages,
    get puts() {
      return puts;
    },
    get deletes() {
      return deletes;
    },
    storedBytes() {
      return stored?.bytes;
    },
    storedMetadata() {
      return stored?.options.customMetadata;
    },
    tamperStoredMetadata() {
      if (stored) {
        stored.options.customMetadata = {
          ...stored.options.customMetadata,
          executionId: "rss_execution_tampered"
        };
      }
    },
    episodeCount() {
      return Number(database.prepare(
        `SELECT COUNT(*) AS count
         FROM episodes
         WHERE id != 'episode_fixture_that_does_not_exist'`
      ).get().count);
    },
    persistedExecutionText() {
      return JSON.stringify({
        executions: database.prepare(
          "SELECT * FROM rss_import_executions"
        ).all(),
        items: database.prepare(
          "SELECT * FROM rss_import_execution_items"
        ).all(),
        audits: database.prepare(
          `SELECT action, target_type, target_id, metadata_json
           FROM admin_audit_events`
        ).all()
      });
    },
    env: {
      ENVIRONMENT: "staging",
      RSS_IMPORT_EXECUTION_MODE: "staging_copy",
      RSS_IMPORT_URL_SECRET: urlSecret,
      SITE_ORIGIN: siteOrigin,
      FEED_ORIGIN: apiOrigin,
      ALLOWED_ORIGINS: `${siteOrigin},http://localhost:8080`,
      ADMIN_SESSION_SECRET: sessionSecret,
      MEDIA_KEY_PREFIX: "podcasts/",
      MEDIA_BUCKET_NAME: "dustwave-media-staging",
      DB: d1Database(database),
      MEDIA_BUCKET: bucket,
      JOBS: {
        async send(message) {
          queueMessages.push(message);
        }
      }
    }
  };
  harnesses.push(harness);
  return harness;
}

function storedObject(stored) {
  return {
    key: stored.key,
    version: "rss-import-fixture",
    size: stored.bytes.byteLength,
    etag: "rss-import-etag",
    httpEtag: '"rss-import-etag"',
    uploaded: new Date(),
    httpMetadata: stored.options.httpMetadata,
    customMetadata: stored.options.customMetadata,
    range: undefined,
    checksums: {
      toJSON() {
        return {};
      }
    },
    writeHttpMetadata() {}
  };
}

function installDigestStream() {
  const nativeCrypto = globalThis.crypto;
  class TestDigestStream extends WritableStream {
    constructor(algorithm) {
      const chunks = [];
      let resolveDigest;
      let rejectDigest;
      const digest = new Promise((resolve, reject) => {
        resolveDigest = resolve;
        rejectDigest = reject;
      });
      super({
        write(chunk) {
          chunks.push(
            chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
          );
        },
        async close() {
          try {
            const bytes = Buffer.concat(
              chunks.map((chunk) =>
                Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              )
            );
            resolveDigest(
              await nativeCrypto.subtle.digest(algorithm, bytes)
            );
          } catch (error) {
            rejectDigest(error);
          }
        },
        abort(error) {
          rejectDigest(error);
        }
      });
      this.digest = digest;
    }
  }
  vi.stubGlobal("crypto", {
    subtle: nativeCrypto.subtle,
    getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
    randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto),
    DigestStream: TestDigestStream
  });
}

function adminRequest(path, body) {
  return new Request(`${apiOrigin}${path}`, {
    method: "POST",
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
      "content-type": "application/json",
      origin: siteOrigin,
      "x-podcast-csrf": csrfToken
    },
    body: JSON.stringify(body)
  });
}

function adminGet(path) {
  return new Request(`${apiOrigin}${path}`, {
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
      origin: siteOrigin
    }
  });
}

function feedResponse(feed) {
  return new Response(feed, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8"
    }
  });
}

function validPodcastFeed() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Ópera en la Selva</title>
    <description>Historias desde la selva.</description>
    <language>es-MX</language>
    <item>
      <title>Episodio uno</title>
      <guid isPermaLink="false">opera-episode-one</guid>
      <description>Una introducción bilingüe.</description>
      <link>https://podcast.example.org/episodes/uno</link>
      <pubDate>Sun, 26 Jul 2026 12:00:00 GMT</pubDate>
      <itunes:duration>12:34</itunes:duration>
      <itunes:explicit>no</itunes:explicit>
      <enclosure url="${audioUrl}" length="${audio.byteLength}" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;
}

function d1Database(database) {
  const prepare = (query) => {
    let values = [];
    const statement = {
      bind(...bound) {
        values = bound;
        return statement;
      },
      async first() {
        return database.prepare(query).get(...values) ?? null;
      },
      async all() {
        return {
          success: true,
          results: database.prepare(query).all(...values),
          meta: {}
        };
      },
      async run() {
        return statement.executeRun();
      },
      executeRun() {
        const result = database.prepare(query).run(...values);
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) }
        };
      }
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) =>
          statement.executeRun()
        );
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function applyMigrations(database) {
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
}
