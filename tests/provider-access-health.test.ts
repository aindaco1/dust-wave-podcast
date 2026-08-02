import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import { scheduleYouTubeProviderAccessCheck } from
  "../src/provider-access-health";
import { YouTubeProviderError } from "../src/youtube-provider";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled provider access health", () => {
  it("records exact YouTube channel access once and skips a fresh result", async () => {
    const state = providerHealthDb();
    const verify = vi.fn(async () => ({ channelId: "channel_fixture" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const env = configuredEnv(state.db);
    await expect(scheduleYouTubeProviderAccessCheck(env, verify))
      .resolves.toBe(1);
    await expect(scheduleYouTubeProviderAccessCheck(env, verify))
      .resolves.toBe(0);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(state.row).toMatchObject({
      provider: "youtube",
      account_reference: "channel_fixture",
      status: "ready",
      failure_code: null,
      consecutive_failures: 0,
      lease_token: null
    });
  });

  it("stores only a bounded failure code and recovers on the next due check", async () => {
    const state = providerHealthDb();
    const verify = vi.fn()
      .mockRejectedValueOnce(new YouTubeProviderError("youtube_oauth_failed"))
      .mockResolvedValueOnce({ channelId: "channel_fixture" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const env = configuredEnv(state.db);

    await expect(scheduleYouTubeProviderAccessCheck(env, verify))
      .resolves.toBe(1);
    expect(state.row).toMatchObject({
      status: "failed",
      failure_code: "youtube_oauth_failed",
      consecutive_failures: 1,
      last_success_at: null
    });

    if (!state.row) throw new Error("provider health row missing");
    state.row.next_check_at = "2000-01-01 00:00:00";
    await expect(scheduleYouTubeProviderAccessCheck(env, verify))
      .resolves.toBe(1);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(state.row).toMatchObject({
      status: "ready",
      failure_code: null,
      consecutive_failures: 0
    });
  });

  it("does not duplicate a check while another bounded lease is active", async () => {
    const state = providerHealthDb({
      provider: "youtube",
      account_reference: null,
      status: "pending",
      failure_code: null,
      checked_at: null,
      last_success_at: null,
      next_check_at: "2000-01-01 00:00:00",
      consecutive_failures: 0,
      lease_token: "a".repeat(32),
      lease_expires_at: "2099-01-01 00:00:00"
    });
    const verify = vi.fn();

    await expect(scheduleYouTubeProviderAccessCheck(
      configuredEnv(state.db),
      verify
    )).resolves.toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not inspect D1 when the provider is not fully configured", async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error("D1 must not be read");
        }
      }
    } as unknown as PodcastEnv;

    await expect(scheduleYouTubeProviderAccessCheck(env, vi.fn()))
      .resolves.toBe(0);
  });
});

type ProviderHealthRow = {
  provider: string;
  account_reference: string | null;
  status: "pending" | "ready" | "failed";
  failure_code: string | null;
  checked_at: string | null;
  last_success_at: string | null;
  next_check_at: string;
  consecutive_failures: number;
  lease_token: string | null;
  lease_expires_at: string | null;
};

function configuredEnv(db: D1Database): PodcastEnv {
  return {
    DB: db,
    YOUTUBE_CLIENT_ID: "client_fixture",
    YOUTUBE_CLIENT_SECRET: "secret_fixture",
    YOUTUBE_REFRESH_TOKEN: "refresh_fixture",
    YOUTUBE_CHANNEL_ID: "channel_fixture"
  } as unknown as PodcastEnv;
}

function providerHealthDb(
  initial: ProviderHealthRow | null = null
): { db: D1Database; row: ProviderHealthRow | null } {
  const state: { db: D1Database; row: ProviderHealthRow | null } = {
    db: null as unknown as D1Database,
    row: initial
  };
  state.db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async run() {
          if (query.includes("INSERT OR IGNORE")) {
            state.row ??= pendingRow(String(values[0]));
          } else if (query.includes("lease_expires_at = datetime")) {
            const now = Date.now();
            const leaseExpired = !state.row?.lease_expires_at
              || Date.parse(`${state.row.lease_expires_at}Z`) <= now;
            const due = state.row
              && Date.parse(`${state.row.next_check_at}Z`) <= now;
            if (state.row && due && leaseExpired) {
              state.row.lease_token = String(values[0]);
              state.row.lease_expires_at = "2099-01-01 00:00:00";
            }
          } else if (query.includes("status = 'ready'")) {
            const row = state.row;
            if (row && row.lease_token === values[2]) {
              row.account_reference = String(values[0]);
              row.status = "ready";
              row.failure_code = null;
              row.checked_at = "2026-08-02 00:00:00";
              row.last_success_at = "2026-08-02 00:00:00";
              row.next_check_at = "2099-01-01 00:00:00";
              row.consecutive_failures = 0;
              row.lease_token = null;
              row.lease_expires_at = null;
            }
          } else if (query.includes("status = 'failed'")) {
            const row = state.row;
            if (row && row.lease_token === values[2]) {
              row.status = "failed";
              row.failure_code = String(values[0]);
              row.checked_at = "2026-08-02 00:00:00";
              row.next_check_at = "2099-01-01 00:00:00";
              row.consecutive_failures += 1;
              row.lease_token = null;
              row.lease_expires_at = null;
            }
          }
          return { success: true };
        },
        async first<T>() {
          return state.row as T | null;
        }
      };
      return statement;
    }
  } as unknown as D1Database;
  return state;
}

function pendingRow(provider: string): ProviderHealthRow {
  return {
    provider,
    account_reference: null,
    status: "pending",
    failure_code: null,
    checked_at: null,
    last_success_at: null,
    next_check_at: "2000-01-01 00:00:00",
    consecutive_failures: 0,
    lease_token: null,
    lease_expires_at: null
  };
}
