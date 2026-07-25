import {
  audioQcReportSha256,
  buildAudioQcManifest,
  DEFAULT_AUDIO_QC_POLICY,
  evaluateAudioQcMeasurements
} from "@dustwave/media-core/audio-qc";
import {
  hmacSha256,
  sha256Hex
} from "@dustwave/worker-core/crypto";
import { describe, expect, it } from "vitest";

import {
  completeAudioQcRun,
  getAdminEpisodeAudioQc,
  queueAdminEpisodeAudioQc
} from "../src/audio-qc";
import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import type { PodcastEnv } from "../src/env";
import { handleRequest } from "../src/app";

const sessionSecret = "audio-qc-session-secret";
const processorSecret = "audio-qc-processor-secret";
const sessionToken = "audio-qc-session-token";
const csrfToken = "audio-qc-csrf-token";
const source = {
  id: "upload_audio_qc_fixture",
  show_id: "show_fixture",
  object_key:
    "podcasts/show_fixture/episode_fixture/source_audio/"
    + "upload_audio_qc_fixture-source.wav",
  filename: "source.wav",
  content_type: "audio/wav",
  completed_bytes: 576_078,
  object_etag: "\"audio-qc-etag\""
};

describe("source-audio QC orchestration", () => {
  it("keeps the workbench private without a session", async () => {
    const response = await getAdminEpisodeAudioQc(
      new Request(
        "https://feeds.dustwave.xyz/v1/admin/episodes/episode_fixture/audio-qc"
      ),
      {
        ALLOWED_ORIGINS: "https://dustwave.xyz"
      } as unknown as PodcastEnv,
      "episode_fixture"
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("queues one exact current source and policy snapshot idempotently", async () => {
    const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
    const env = await environment({ batches });
    const request = authenticatedRequest(
      "/v1/admin/episodes/episode_fixture/audio-qc",
      { runId: "qc_fixture" }
    );
    const response = await queueAdminEpisodeAudioQc(
      request,
      env,
      "episode_fixture"
    );
    const payload = await response.json() as {
      run: { id: string; status: string };
      processor: {
        manifestSha256: string;
        workflow: string;
      };
      idempotent: boolean;
    };

    expect(response.status).toBe(202);
    expect(payload.run).toMatchObject({
      id: "qc_fixture",
      status: "queued"
    });
    expect(payload.processor.manifestSha256)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(payload.processor.workflow).toBe("process-audio-qc.yml");
    expect(JSON.stringify(payload)).not.toContain(source.object_key);
    expect(payload.idempotent).toBe(false);
    expect(batches).toHaveLength(1);
    expect(batches[0][0].query).toContain("INSERT OR IGNORE INTO audio_qc_runs");
    expect(batches[0][1].query).toContain("'audio_qc.queued'");
    expect(JSON.parse(String(batches[0][1].values[3]))).toEqual({
      episodeId: "episode_fixture",
      sourceUploadId: source.id,
      sourceBytes: source.completed_bytes,
      sourceMimeType: source.content_type,
      policyRevision: 1,
      processorManifestSha256:
        payload.processor.manifestSha256
    });
  });

  it("rejects a signed callback failure before D1 when its signature is invalid", async () => {
    const env = {
      ENVIRONMENT: "staging",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      MEDIA_PROCESSOR_CALLBACK_SECRET: processorSecret,
      DB: {
        prepare() {
          throw new Error("database must not be read");
        }
      }
    } as unknown as PodcastEnv;
    const response = await completeAudioQcRun(
      new Request(
        "https://feeds.dustwave.xyz/v1/processor/audio-qc/qc_fixture/complete",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-podcast-processor-timestamp": String(
              Math.floor(Date.now() / 1_000)
            ),
            "x-podcast-processor-signature": "invalid"
          },
          body: "{}"
        }
      ),
      env,
      "qc_fixture"
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_processor_signature"
    });
  });

  it("recomputes signed findings and stores bounded success evidence", async () => {
    const run = await runRow();
    const manifest = await manifestForRun(run);
    run.processor_manifest_sha256 = manifest.manifestSha256;
    const measurements = {
      durationMs: 60_000,
      codec: "pcm_s16le",
      container: "wav",
      sampleRateHz: 48_000,
      bitDepth: 16,
      channels: 1,
      channelLayout: "mono",
      averageBitrateBps: 768_000,
      integratedLufs: -24,
      loudnessRangeLu: 3,
      truePeakDbtp: -2,
      samplePeakDbfs: -2.1,
      clippedSamples: 0,
      dcOffset: 0,
      channelImbalanceLu: null,
      silence: {
        leadingMs: 500,
        trailingMs: 500,
        longestInternalMs: null,
        regions: [
          {
            kind: "leading",
            startMs: 0,
            endMs: 500,
            durationMs: 500
          },
          {
            kind: "trailing",
            startMs: 59_500,
            endMs: 60_000,
            durationMs: 500
          }
        ]
      }
    };
    const report = {
      schemaVersion: "audio-qc-report-v1" as const,
      runId: run.id,
      manifestSha256: manifest.manifestSha256,
      processorVersion: "dustwave-audio-qc-1 (ffmpeg version fixture)",
      sourceSha256: "a".repeat(64),
      measurements,
      quality: evaluateAudioQcMeasurements(
        measurements,
        DEFAULT_AUDIO_QC_POLICY
      ),
      resource: {
        wallMs: 1_000,
        maximumRssBytes: 100_000_000,
        ffmpegVersion: "ffmpeg version fixture",
        ffprobeVersion: "ffprobe version fixture"
      }
    };
    const reportSha256 = await audioQcReportSha256(report, manifest);
    const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
    const env = await environment({ batches, run });
    const request = await signedProcessorRequest({
      runId: run.id,
      manifestSha256: manifest.manifestSha256,
      status: "succeeded",
      report,
      reportSha256
    });
    const response = await completeAudioQcRun(
      request,
      env,
      run.id
    );

    expect(response.status).toBe(200);
    expect(batches).toHaveLength(1);
    expect(batches[0][0].query).toContain("status = 'succeeded'");
    expect(batches[0][0].values).toContain(reportSha256);
    expect(batches[0][0].values).toContain(-24);
    expect(batches[0][1].query).toContain("'audio_qc.succeeded'");
    const audit = JSON.parse(String(batches[0][1].values[2]));
    expect(audit).toMatchObject({
      episodeId: "episode_fixture",
      policyRevision: 1,
      reportSha256,
      sourceSha256: "a".repeat(64),
      blockerCount: 0,
      warningCount: 1,
      durationMs: 60_000
    });
    expect(JSON.stringify(audit)).not.toContain(source.object_key);
  });

  it("rejects processor-supplied findings that do not match measurements", async () => {
    const run = await runRow();
    const manifest = await manifestForRun(run);
    run.processor_manifest_sha256 = manifest.manifestSha256;
    const report = {
      schemaVersion: "audio-qc-report-v1",
      runId: run.id,
      manifestSha256: manifest.manifestSha256,
      processorVersion: "dustwave-audio-qc-1",
      sourceSha256: "a".repeat(64),
      measurements: {
        durationMs: 60_000,
        codec: "flac",
        container: "flac",
        sampleRateHz: 48_000,
        bitDepth: 24,
        channels: 1,
        channelLayout: "mono",
        averageBitrateBps: 768_000,
        integratedLufs: -30,
        loudnessRangeLu: 3,
        truePeakDbtp: -2,
        samplePeakDbfs: -2,
        clippedSamples: 0,
        dcOffset: 0,
        channelImbalanceLu: null,
        silence: {
          leadingMs: 0,
          trailingMs: 0,
          longestInternalMs: null,
          regions: []
        }
      },
      quality: {
        targetIntegratedLufs: -19,
        blockerCount: 0,
        warningCount: 0,
        passed: true,
        findings: []
      },
      resource: {
        wallMs: 1,
        maximumRssBytes: 1,
        ffmpegVersion: "ffmpeg fixture",
        ffprobeVersion: "ffprobe fixture"
      }
    };
    const response = await handleRequest(
      await signedProcessorRequest({
        runId: run.id,
        manifestSha256: manifest.manifestSha256,
        status: "succeeded",
        report,
        reportSha256: "b".repeat(64)
      }),
      await environment({ run })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_audio_qc_report"
    });
  });
});

async function environment({
  batches = [],
  run = null
}: {
  batches?: Array<Array<{ query: string; values: unknown[] }>>;
  run?: Awaited<ReturnType<typeof runRow>> | null;
} = {}): Promise<PodcastEnv> {
  const csrfHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  let storedRun: Record<string, unknown> | null = run;
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        query,
        get values() {
          return values;
        },
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_fixture",
              csrf_token_hash: csrfHash
            };
          }
          if (query.includes("JOIN media_uploads upload")) {
            if (query.includes("FROM audio_qc_runs q")) return storedRun;
            return source;
          }
          if (query.includes("FROM episodes") && query.includes("audio_key")) {
            return {
              id: "episode_fixture",
              show_id: "show_fixture",
              duration_seconds: null,
              audio_key: null,
              audio_bytes: null,
              audio_etag: null,
              audio_mime_type: null,
              media_status: "processing"
            };
          }
          if (query.includes("FROM show_audio_qc_policies")) {
            return policyRow();
          }
          if (query.includes("FROM audio_qc_runs") && query.includes("status IN")) {
            return null;
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role: "producer", show_id: "show_fixture" }]
            };
          }
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        }
      };
      return statement;
    },
    async batch(statements: Array<{ query: string; values: unknown[] }>) {
      batches.push(
        statements.map((statement) => ({
          query: statement.query,
          values: [...statement.values]
        }))
      );
      const insert = statements.find(({ query }) =>
        query.includes("INSERT OR IGNORE INTO audio_qc_runs")
      );
      if (insert) {
        storedRun = await runRow({
          id: String(insert.values[0]),
          status: "queued",
          started_at: null,
          processor_manifest_sha256: String(insert.values[9])
        });
      }
      if (
        storedRun
        && statements[0]?.query.includes("status = 'succeeded'")
      ) {
        storedRun = {
          ...storedRun,
          status: "succeeded",
          source_sha256: String(statements[0].values[0]),
          report_json: String(statements[0].values[1]),
          report_sha256: String(statements[0].values[2]),
          blocker_count: Number(statements[0].values[3]),
          warning_count: Number(statements[0].values[4]),
          duration_ms: Number(statements[0].values[5]),
          integrated_lufs: Number(statements[0].values[6]),
          true_peak_dbtp: Number(statements[0].values[7]),
          processor_version: String(statements[0].values[8]),
          completed_at: "2026-07-25 18:00:00"
        };
      }
      return statements.map(() => ({
        success: true,
        meta: { changes: 1 }
      }));
    }
  } as unknown as D1Database;
  return {
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dustwave.xyz",
    FEED_ORIGIN:
      "https://dust-wave-podcast-staging.jogo.workers.dev",
    ALLOWED_ORIGINS: "https://dustwave.xyz",
    MEDIA_BUCKET_NAME: "dustwave-media-staging",
    MEDIA_PROCESSOR_CALLBACK_SECRET: processorSecret,
    ADMIN_SESSION_SECRET: sessionSecret,
    DB: db,
    MEDIA_BUCKET: {
      async head(key: string) {
        if (key !== source.object_key) return null;
        return {
          size: source.completed_bytes,
          httpEtag: source.object_etag,
          httpMetadata: { contentType: source.content_type }
        };
      }
    } as unknown as R2Bucket
  } as unknown as PodcastEnv;
}

function authenticatedRequest(
  path: string,
  body: Record<string, unknown>
): Request {
  return new Request(`https://feeds.dustwave.xyz${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
      origin: "https://dustwave.xyz",
      "x-podcast-csrf": csrfToken
    },
    body: JSON.stringify(body)
  });
}

async function signedProcessorRequest(
  body: Record<string, unknown>
): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await hmacSha256(
    `${timestamp}.${rawBody}`,
    processorSecret,
    "hex"
  );
  return new Request(
    `https://feeds.dustwave.xyz/v1/processor/audio-qc/${body.runId}/complete`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-podcast-processor-timestamp": String(timestamp),
        "x-podcast-processor-signature": signature
      },
      body: rawBody
    }
  );
}

function policyRow() {
  return {
    show_id: "show_fixture",
    revision: 1,
    mono_integrated_lufs: -19,
    stereo_integrated_lufs: -16,
    integrated_lufs_tolerance: 1,
    maximum_true_peak_dbtp: -1,
    maximum_dc_offset: 0.01,
    maximum_channel_imbalance_lu: 2,
    maximum_leading_silence_ms: 2_000,
    maximum_trailing_silence_ms: 3_000,
    maximum_internal_silence_ms: 5_000,
    silence_threshold_db: -50,
    updated_at: "2026-07-25 00:00:00"
  };
}

async function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "qc_fixture",
    episode_id: "episode_fixture",
    show_id: "show_fixture",
    source_upload_id: source.id,
    source_filename: source.filename,
    source_object_key: source.object_key,
    source_object_bytes: source.completed_bytes,
    source_object_etag: source.object_etag,
    source_mime_type: source.content_type,
    policy_revision: 1,
    policy_json: JSON.stringify(DEFAULT_AUDIO_QC_POLICY),
    processor_manifest_sha256: "",
    status: "running",
    source_sha256: null,
    report_json: null,
    report_sha256: null,
    blocker_count: null,
    warning_count: null,
    duration_ms: null,
    integrated_lufs: null,
    true_peak_dbtp: null,
    processor_version: null,
    failure_code: null,
    created_at: "2026-07-25 00:00:00",
    started_at: "2026-07-25 00:00:01",
    completed_at: null,
    ...overrides
  };
}

async function manifestForRun(
  run: Awaited<ReturnType<typeof runRow>>
) {
  return buildAudioQcManifest({
    schemaVersion: "audio-qc-job-v1",
    runId: String(run.id),
    episodeId: String(run.episode_id),
    showId: String(run.show_id),
    source: {
      bucketName: "dustwave-media-staging",
      objectKey: String(run.source_object_key),
      objectBytes: Number(run.source_object_bytes),
      etag: String(run.source_object_etag),
      mimeType: String(run.source_mime_type)
    },
    policy: JSON.parse(String(run.policy_json)),
    callbackUrl:
      "https://dust-wave-podcast-staging.jogo.workers.dev"
      + `/v1/processor/audio-qc/${run.id}/complete`
  });
}
