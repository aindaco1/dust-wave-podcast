import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handlePodcastDeadLetterBatch,
  isPodcastDeadLetterQueue,
  STAGING_PODCAST_DEAD_LETTER_QUEUE,
  STAGING_PODCAST_JOB_QUEUE
} from "../src/queue-dead-letters";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("durable dead-letter incident evidence", () => {
  let sqlite;
  let env;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const filename of readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
    }
    env = {
      DB: sqliteD1(sqlite),
      ENVIRONMENT: "staging"
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it("stores only bounded job evidence and acknowledges after D1 succeeds", async () => {
    const message = queueMessage({
      id: "job_episode_publish_fixture",
      type: "publish-rss",
      showId: "show_fixture",
      episodeId: "episode_fixture",
      publicationRevision: 2,
      requestedAt: "2026-07-31T12:00:00.000Z",
      providerSecret: "must-not-be-persisted",
      mediaUrl: "https://private.example/source.wav"
    }, 4);

    await handlePodcastDeadLetterBatch(deadLetterBatch(message), env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const row = sqlite.prepare(
      `SELECT id, payload_sha256, source_queue, dead_letter_queue,
              classification, job_id, job_type, show_id, episode_id,
              publication_revision, failure_code, status,
              exhausted_after_retries, occurrence_count,
              last_dlq_delivery_attempt
       FROM queue_dead_letter_incidents`
    ).get();
    expect(row).toMatchObject({
      source_queue: STAGING_PODCAST_JOB_QUEUE,
      dead_letter_queue: STAGING_PODCAST_DEAD_LETTER_QUEUE,
      classification: "podcast_job",
      job_id: "job_episode_publish_fixture",
      job_type: "publish-rss",
      show_id: "show_fixture",
      episode_id: "episode_fixture",
      publication_revision: 2,
      failure_code: "queue_delivery_attempts_exhausted",
      status: "open",
      exhausted_after_retries: 3,
      occurrence_count: 1,
      last_dlq_delivery_attempt: 4
    });
    expect(row.id).toBe(`queue_dead_letter_${row.payload_sha256}`);
    expect(row.payload_sha256).toMatch(/^[a-f0-9]{64}$/);

    const columns = sqlite.prepare(
      "PRAGMA table_info(queue_dead_letter_incidents)"
    ).all().map((column) => column.name);
    expect(columns).not.toContain("payload");
    expect(columns).not.toContain("body");
    expect(columns).not.toContain("provider_response");
    expect(JSON.stringify(row)).not.toContain("must-not-be-persisted");
    expect(JSON.stringify(row)).not.toContain("private.example");
  });

  it("coalesces repeat deliveries into one reopened incident", async () => {
    const body = {
      id: "job_repeat_fixture",
      type: "render-clip",
      showId: "show_fixture",
      episodeId: "episode_fixture",
      requestedAt: "2026-07-31T12:00:00.000Z"
    };
    await handlePodcastDeadLetterBatch(
      deadLetterBatch(queueMessage(body, 1)),
      env
    );
    sqlite.exec(`
      UPDATE queue_dead_letter_incidents
      SET status = 'resolved', resolved_at = datetime('now')
    `);
    await handlePodcastDeadLetterBatch(
      deadLetterBatch(queueMessage(body, 5)),
      env
    );

    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count, status, resolved_at, occurrence_count,
              last_dlq_delivery_attempt
       FROM queue_dead_letter_incidents`
    ).get()).toEqual({
      count: 1,
      status: "open",
      resolved_at: null,
      occurrence_count: 2,
      last_dlq_delivery_attempt: 5
    });
  });

  it("reduces malformed messages to a digest without copying untrusted fields", async () => {
    const message = queueMessage({
      type: "made-up-provider-call",
      showId: "show_fixture",
      requestedAt: "not-a-date",
      error: "untrusted terminal provider error"
    }, 1);

    await handlePodcastDeadLetterBatch(deadLetterBatch(message), env);

    expect(sqlite.prepare(
      `SELECT classification, job_id, job_type, show_id, episode_id,
              publication_revision, failure_code
       FROM queue_dead_letter_incidents`
    ).get()).toEqual({
      classification: "malformed",
      job_id: null,
      job_type: null,
      show_id: null,
      episode_id: null,
      publication_revision: null,
      failure_code: "malformed_queue_job"
    });
  });

  it("retries without acknowledging when durable storage is unavailable", async () => {
    const message = queueMessage({
      id: "job_storage_failure_fixture",
      type: "publish-news",
      showId: "show_fixture",
      requestedAt: "2026-07-31T12:00:00.000Z"
    }, 2);
    const unavailableEnv = {
      ...env,
      DB: {
        prepare() {
          throw new Error("D1 unavailable");
        }
      }
    };

    await handlePodcastDeadLetterBatch(
      deadLetterBatch(message),
      unavailableEnv
    );

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });

  it("accepts only the exact isolated staging dead-letter binding", () => {
    expect(isPodcastDeadLetterQueue(
      env,
      STAGING_PODCAST_DEAD_LETTER_QUEUE
    )).toBe(true);
    expect(isPodcastDeadLetterQueue(
      { ...env, ENVIRONMENT: "production" },
      STAGING_PODCAST_DEAD_LETTER_QUEUE
    )).toBe(false);
    expect(isPodcastDeadLetterQueue(env, STAGING_PODCAST_JOB_QUEUE)).toBe(false);
  });
});

function queueMessage(body, attempts) {
  return {
    id: `message-${attempts}`,
    timestamp: new Date("2026-07-31T12:01:00.000Z"),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn()
  };
}

function deadLetterBatch(...messages) {
  return {
    queue: STAGING_PODCAST_DEAD_LETTER_QUEUE,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn()
  };
}

function sqliteD1(sqlite) {
  return {
    prepare(query) {
      let values = [];
      return {
        bind(...input) {
          values = input;
          return this;
        },
        async first() {
          return sqlite.prepare(query).get(...values) ?? null;
        },
        async all() {
          return {
            results: sqlite.prepare(query).all(...values),
            success: true,
            meta: { changes: 0 }
          };
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return {
            success: true,
            meta: { changes: Number(result.changes) }
          };
        }
      };
    }
  };
}
