import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scheduleAdminActionNotifications,
  type AdminActionKind
} from "../src/admin-action-notifications";
import type { PodcastEnv } from "../src/env";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin action notification automation", () => {
  it("preserves the existing master-review email and digest", async () => {
    const fixture = actionFixture();
    const fetchMock = successfulResend();

    await scheduleAdminActionNotifications(fixture.env);
    await scheduleAdminActionNotifications(fixture.env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.notification?.status).toBe("sent");
    expect(fixture.notification?.attempt_count).toBe(1);
    const request = fetchMock.mock.calls[0][1]!;
    const payload = JSON.parse(String(request.body));
    expect(payload.to).toEqual(["admin@example.com"]);
    expect(payload.subject).toContain("Podcast master ready for review");
    expect(payload.subject).toContain("Máster del podcast");
    expect(payload.text).toContain("show=show_fixture");
    expect(payload.text).toContain("episode=episode_fixture");
    expect(payload.text).toContain("step=media&target=working_master");
    expect(payload.text).toContain("#magic-link=");
    expect(JSON.stringify(payload)).not.toContain("private/source.wav");
    expect(JSON.stringify(payload)).not.toContain("8".repeat(64));
    expect(request.headers).toMatchObject({
      "idempotency-key": expect.stringMatching(
        /^podcast-admin-action\/[a-f0-9]{64}$/
      )
    });
    expect(fixture.boundValues.flat()).not.toContain("admin@example.com");
    const loginUrl = payload.text.match(/https:\/\/[^\s]+/)?.[0];
    const usableToken = loginUrl
      ? new URL(loginUrl).hash.replace("#magic-link=", "")
      : "";
    expect(usableToken).not.toBe("");
    expect(fixture.boundValues.flat()).not.toContain(usableToken);
  });

  it.each([
    {
      kind: "delivery_audio_approval" as const,
      subject: "Podcast audio ready for review",
      deepLink: "step=media&target=delivery_audio"
    },
    {
      kind: "transcript_review" as const,
      subject: "Podcast transcript ready for review",
      deepLink: "step=transcript&target=transcript_review"
    }
  ])("sends one bilingual $kind link", async ({
    kind,
    subject,
    deepLink
  }) => {
    const fixture = actionFixture({ kind });
    const fetchMock = successfulResend();

    await scheduleAdminActionNotifications(fixture.env);
    await scheduleAdminActionNotifications(fixture.env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.notification?.action_kind).toBe(kind);
    expect(fixture.notification?.status).toBe("sent");
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.subject).toContain(subject);
    expect(payload.text).toContain(deepLink);
    expect(payload.text).toContain("#magic-link=");
    expect(JSON.stringify(payload)).not.toContain("private/");
  });

  it("retries a provider rejection three times with an identical request", async () => {
    const fixture = actionFixture({ kind: "delivery_audio_approval" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ message: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      })
    );

    await scheduleAdminActionNotifications(fixture.env);
    await scheduleAdminActionNotifications(fixture.env);
    await scheduleAdminActionNotifications(fixture.env);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fixture.notification?.status).toBe("failed");
    expect(fixture.notification?.attempt_count).toBe(3);
    expect(fixture.notification?.failure_code).toBe("provider_rejected");
    expect(new Set(fetchMock.mock.calls.map((call) =>
      String(call[1]?.body)
    )).size).toBe(1);
    expect(new Set(fetchMock.mock.calls.map((call) =>
      String((call[1]?.headers as Record<string, string>)["idempotency-key"])
    )).size).toBe(1);
  });

  it("resolves obsolete decisions without issuing a token or sending mail", async () => {
    const fixture = actionFixture({
      kind: "transcript_review",
      ready: false,
      withNotification: true
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await scheduleAdminActionNotifications(fixture.env);

    expect(fixture.notification?.status).toBe("resolved");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixture.queries.some((query) =>
      query.includes("INSERT INTO admin_login_tokens")
    )).toBe(false);
  });
});

function successfulResend() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ id: "resend_fixture" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
}

function actionFixture({
  kind = "working_master_decision",
  ready = true,
  withNotification = false
}: {
  kind?: AdminActionKind;
  ready?: boolean;
  withNotification?: boolean;
} = {}) {
  const evidence = actionEvidence(kind);
  const queries: string[] = [];
  const boundValues: unknown[][] = [];
  let notification: {
    id: string;
    action_kind: AdminActionKind;
    target_id: string;
    action_digest: string;
    status: string;
    attempt_count: number;
    failure_code: string | null;
    lease_id: string | null;
  } | null = withNotification ? {
    id: "admin_action_existing",
    action_kind: kind,
    target_id: evidence.target_id,
    action_digest: "b".repeat(64),
    status: "pending",
    attempt_count: 0,
    failure_code: null,
    lease_id: null
  } : null;
  const db = {
    prepare(query: string) {
      queries.push(query);
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          boundValues.push(bound);
          return this;
        },
        async all() {
          if (query.includes("ORDER BY evidence.action_ready_at")) {
            return {
              results: ready && queryActionKind(query) === kind
                ? [{ ...evidence }]
                : []
            };
          }
          if (query.includes("FROM admin_action_notifications")) {
            return {
              results: notification?.status === "pending"
                ? [{
                  id: notification.id,
                  action_kind: notification.action_kind,
                  target_id: notification.target_id,
                  action_digest: notification.action_digest,
                  attempt_count: notification.attempt_count
                }]
                : []
            };
          }
          if (query.includes("FROM admin_user_roles")) {
            return { results: [{ role: "super_admin", show_id: null }] };
          }
          return { results: [] };
        },
        async first() {
          if (query.includes("WHERE evidence.target_id = ?")) {
            return ready && queryActionKind(query) === kind
              ? { ...evidence }
              : null;
          }
          if (query.includes("FROM admin_users")) {
            return { id: "admin_fixture" };
          }
          return null;
        },
        async run() {
          if (query.includes("INSERT OR IGNORE INTO admin_action_notifications")) {
            if (!notification) {
              notification = {
                id: String(values[0]),
                action_kind: String(values[2]) as AdminActionKind,
                target_id: String(values[3]),
                action_digest: String(values[4]),
                status: "pending",
                attempt_count: 0,
                failure_code: null,
                lease_id: null
              };
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (
            query.includes("UPDATE admin_action_notifications")
            && query.includes("NOT EXISTS")
          ) {
            if (
              !ready
              && notification
              && notification.action_kind === values[0]
            ) notification.status = "resolved";
            return { success: true, meta: { changes: ready ? 0 : 1 } };
          }
          if (
            query.includes("UPDATE admin_action_notifications")
            && query.includes("attempt_count = attempt_count + 1")
          ) {
            if (
              !notification
              || notification.status !== "pending"
              || notification.action_kind !== values[2]
            ) return { success: true, meta: { changes: 0 } };
            notification.status = "sending";
            notification.attempt_count += 1;
            notification.lease_id = String(values[0]);
            return { success: true, meta: { changes: 1 } };
          }
          if (
            query.includes("UPDATE admin_action_notifications")
            && query.includes("WHERE id = ? AND status = 'sending'")
          ) {
            if (
              !notification
              || notification.status !== "sending"
              || notification.lease_id !== values[7]
            ) return { success: true, meta: { changes: 0 } };
            notification.status = String(values[0]);
            notification.failure_code = values[3]
              ? String(values[3])
              : null;
            notification.lease_id = null;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  } as unknown as D1Database;
  const env = {
    DB: db,
    ENVIRONMENT: "staging",
    SITE_ORIGIN: "https://dust-wave-website-staging.pages.dev",
    ADMIN_ACTION_NOTIFICATION_MODE: "live",
    PODCAST_ACTION_EMAIL: "admin@example.com",
    PODCAST_EMAIL_FROM: "Dust Wave Podcasts <podcasts@dustwave.xyz>",
    ADMIN_EMAIL_LOOKUP_PEPPER: "lookup_fixture",
    ADMIN_SESSION_SECRET: "session_fixture",
    RESEND_API_KEY: "resend_fixture"
  } as unknown as PodcastEnv;
  return {
    boundValues,
    env,
    get notification() {
      return notification;
    },
    queries
  };
}

function actionEvidence(kind: AdminActionKind) {
  const base = {
    episode_id: "episode_fixture",
    show_id: "show_fixture",
    action_ready_at: "2026-08-01T00:00:00Z"
  };
  if (kind === "delivery_audio_approval") {
    return {
      ...base,
      target_id: "delivery_fixture",
      source_master_id: "master_fixture",
      output_sha256: "8".repeat(64),
      peaks_sha256: "9".repeat(64),
      processor_manifest_sha256: "a".repeat(64),
      processor_report_sha256: "b".repeat(64)
    };
  }
  if (kind === "transcript_review") {
    return {
      ...base,
      target_id: "transcript_fixture",
      source_master_id: "master_fixture",
      language: "es",
      transcript_revision: 1,
      transcript_sha256: "c".repeat(64),
      input_fingerprint: "d".repeat(64)
    };
  }
  return {
    ...base,
    target_id: "derivative_fixture",
    source_master_id: "master_fixture",
    output_sha256: "8".repeat(64),
    processor_report_sha256: "9".repeat(64),
    quality_control_report_sha256: "a".repeat(64),
    quality_control_policy_revision: 1,
    working_master_revision: 1
  };
}

function queryActionKind(query: string): AdminActionKind | null {
  if (query.includes("FROM delivery_audio_jobs job")) {
    return "delivery_audio_approval";
  }
  if (query.includes("FROM transcripts transcript")) {
    return "transcript_review";
  }
  if (query.includes("FROM audio_enhancement_derivatives")) {
    return "working_master_decision";
  }
  return null;
}
