import { sha256Hex } from "@dustwave/worker-core/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";
import {
  stripePercentage,
  taxPolicyConfirmation,
  validateTaxPolicyInput
} from "../src/tax-policies";

const SHOW_ID = "show_opera_en_la_selva";
const POLICY_BODY = {
  jurisdictionCode: "US-NM-87120",
  ratePartsPerMillion: 76_250,
  inclusive: false,
  providerName: "nm_grt",
  sourceReference: "dust-wave-store@fixture:_config.yml",
  effectiveAt: "2026-08-01T00:00:00.000Z",
  expiresAt: null,
  displayName: "NM GRT"
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("show tax policy configuration", () => {
  it("normalizes exact policy inputs and formats Stripe percentages", () => {
    const policy = validateTaxPolicyInput({
      ...POLICY_BODY,
      jurisdictionCode: "us-nm-87120",
      effectiveAt: "2026-08-01T00:00:00Z"
    });
    expect(policy).toEqual(POLICY_BODY);
    expect(stripePercentage(76_250)).toBe("7.625");
    expect(stripePercentage(100_000)).toBe("10");
    expect(taxPolicyConfirmation(SHOW_ID, policy)).toBe(
      `APPROVE_TAX_POLICY ${SHOW_ID} US-NM-87120 76250`
    );
  });

  it("rejects ambiguous or unsafe policy inputs", () => {
    expect(() => validateTaxPolicyInput({
      ...POLICY_BODY,
      jurisdictionCode: "New Mexico"
    })).toThrow(/jurisdictionCode is invalid/u);
    expect(() => validateTaxPolicyInput({
      ...POLICY_BODY,
      ratePartsPerMillion: 1_000_001
    })).toThrow(/positive integer/u);
    expect(() => validateTaxPolicyInput({
      ...POLICY_BODY,
      inclusive: "false"
    })).toThrow(/must be a boolean/u);
    expect(() => validateTaxPolicyInput({
      ...POLICY_BODY,
      sourceReference: "unsafe\nreference"
    })).toThrow(/control characters/u);
    expect(() => validateTaxPolicyInput({
      ...POLICY_BODY,
      expiresAt: POLICY_BODY.effectiveAt
    })).toThrow(/must follow effectiveAt/u);
  });

  it("creates, verifies, assigns, audits, and safely replays one policy", async () => {
    const fixture = await taxPolicyFixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stripeRequests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      stripeRequests.push({ url, init });
      if (init?.method === "POST") {
        const form = new URLSearchParams(String(init.body));
        expect(url).toBe("https://api.stripe.com/v1/tax_rates");
        expect(init.headers).toMatchObject({
          Authorization: "Bearer sk_test_fixture"
        });
        expect(
          (init.headers as Record<string, string>)["Idempotency-Key"]
        ).toMatch(/^podcast-tax-policy-[a-f0-9]{64}$/u);
        expect(form.get("percentage")).toBe("7.625");
        expect(form.get("inclusive")).toBe("false");
        expect(form.get("country")).toBe("US");
        expect(form.get("state")).toBe("NM");
        expect(form.get("metadata[platform]")).toBe("dust_wave_podcast");
        expect(form.get("metadata[show_id]")).toBe(SHOW_ID);
        const policyId = String(form.get("metadata[policy_id]"));
        return stripeTaxRateResponse(policyId);
      }
      expect(url).toBe(
        "https://api.stripe.com/v1/tax_rates/txr_fixture_policy"
      );
      return stripeTaxRateResponse(fixture.policy?.id ?? "");
    });

    const created = await handleRequest(
      fixture.request({
        ...POLICY_BODY,
        confirmation:
          `APPROVE_TAX_POLICY ${SHOW_ID} US-NM-87120 76250`
      }),
      fixture.env
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      idempotent: false,
      policy: {
        jurisdictionCode: "US-NM-87120",
        ratePartsPerMillion: 76_250,
        inclusive: false,
        providerName: "nm_grt",
        providerMode: "test",
        status: "approved",
        assigned: true,
        providerReady: true
      }
    });
    expect(fixture.policy?.stripe_tax_rate_id).toBe("txr_fixture_policy");
    expect(fixture.assigned).toBe(true);
    expect(fixture.taxWrites).toEqual([
      "approve",
      "audit",
      "retire_previous",
      "assign"
    ]);

    const replayed = await handleRequest(
      fixture.request({
        ...POLICY_BODY,
        confirmation:
          `APPROVE_TAX_POLICY ${SHOW_ID} US-NM-87120 76250`
      }),
      fixture.env
    );
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ idempotent: true });
    expect(fixture.taxWrites).toHaveLength(4);
    expect(stripeRequests).toHaveLength(2);

    const read = await handleRequest(
      fixture.request(undefined, "GET"),
      fixture.env
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      showId: SHOW_ID,
      providerMode: "test",
      showReady: true,
      policies: [{
        jurisdictionCode: "US-NM-87120",
        providerReady: true,
        assigned: true
      }],
      candidate: {
        applicableMode: "test",
        jurisdictionCode: "US-NM-87120",
        ratePartsPerMillion: 76_250,
        inclusive: false,
        providerName: "nm_grt",
        effectiveAt: "2026-08-02T00:00:00.000Z",
        expiresAt: null,
        displayName: "NM GRT",
        sourceReference: expect.stringContaining(
          "github:aindaco1/store@f4b95a2"
        ),
        confirmation:
          `APPROVE_TAX_POLICY ${SHOW_ID} US-NM-87120 76250`
      }
    });
  });

  it("requires recent super-admin authentication before provider access", async () => {
    const fixture = await taxPolicyFixture({ recentAuthentication: false });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await handleRequest(
      fixture.request({
        ...POLICY_BODY,
        confirmation:
          `APPROVE_TAX_POLICY ${SHOW_ID} US-NM-87120 76250`
      }),
      fixture.env
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "recent_authentication_required"
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fixture.taxWrites).toEqual([]);
  });

  it("fails closed without a D1 tax mutation when Stripe attestation differs", async () => {
    const fixture = await taxPolicyFixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => stripeTaxRateResponse(
      "tax_wrong_policy",
      { percentage: 8 }
    ));
    const response = await handleRequest(
      fixture.request({
        ...POLICY_BODY,
        confirmation:
          `APPROVE_TAX_POLICY ${SHOW_ID} US-NM-87120 76250`
      }),
      fixture.env
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "tax_policy_provider_unavailable"
    });
    expect(fixture.taxWrites).toEqual([]);
    expect(fixture.policy).toBeNull();
  });
});

function stripeTaxRateResponse(
  policyId: string,
  overrides: Record<string, unknown> = {}
): Response {
  return new Response(JSON.stringify({
    id: "txr_fixture_policy",
    object: "tax_rate",
    livemode: false,
    active: true,
    percentage: 7.625,
    inclusive: false,
    country: "US",
    state: "NM",
    metadata: {
      platform: "dust_wave_podcast",
      show_id: SHOW_ID,
      policy_id: policyId
    },
    ...overrides
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "request-id": "req_fixture"
    }
  });
}

type StoredFixturePolicy = {
  id: string;
  jurisdiction_code: string;
  rate_parts_per_million: number;
  inclusive: number;
  stripe_tax_rate_id: string;
  provider_name: string;
  source_reference: string;
  effective_at: string;
  expires_at: string | null;
  provider_mode: "test";
  status: "approved";
  approved_by_admin_user_id: string;
};

async function taxPolicyFixture({
  recentAuthentication = true
}: {
  recentAuthentication?: boolean;
} = {}) {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  let policy: StoredFixturePolicy | null = null;
  let assigned = false;
  const taxWrites: string[] = [];
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        query,
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_actor",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("SELECT 1 AS recent")) {
            return recentAuthentication ? { recent: 1 } : null;
          }
          if (query.includes("SELECT id, premium_enabled, billing_mode")) {
            return {
              id: SHOW_ID,
              premium_enabled: 1,
              billing_mode: "test"
            };
          }
          if (query.includes("FROM tax_rate_versions t")) {
            return policy && values[1] === policy.id
              ? { ...policy, assigned: assigned ? 1 : 0 }
              : null;
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role: "super_admin", show_id: null }]
            };
          }
          if (query.includes("FROM show_tax_rate_assignments a")) {
            return {
              results: policy && assigned
                ? [{ ...policy, assigned: 1 }]
                : []
            };
          }
          return { results: [] };
        },
        async run() {
          if (query.includes("INSERT OR IGNORE INTO tax_rate_versions")) {
            taxWrites.push("approve");
            policy = {
              id: String(values[0]),
              jurisdiction_code: String(values[1]),
              rate_parts_per_million: Number(values[10]),
              inclusive: Number(values[3]),
              stripe_tax_rate_id: String(values[4]),
              provider_name: String(values[5]),
              source_reference: String(values[6]),
              effective_at: String(values[7]),
              expires_at: values[8] === null ? null : String(values[8]),
              provider_mode: "test",
              status: "approved",
              approved_by_admin_user_id: String(values[9])
            };
          } else if (query.includes("INSERT INTO admin_audit_events")) {
            taxWrites.push("audit");
          } else if (query.includes("UPDATE tax_rate_versions")) {
            taxWrites.push("retire_previous");
          } else if (query.includes("INSERT OR IGNORE INTO show_tax_rate_assignments")) {
            taxWrites.push("assign");
            assigned = true;
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  } as unknown as D1Database;
  return {
    env: {
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: sessionSecret,
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_fixture",
      SUBSCRIPTION_CHECKOUT_ENABLED: "false"
    } as unknown as PodcastEnv,
    get policy() {
      return policy;
    },
    get assigned() {
      return assigned;
    },
    taxWrites,
    request(
      body?: Record<string, unknown>,
      method: "GET" | "PUT" = "PUT"
    ) {
      return new Request(
        `https://feeds.dustwave.xyz/v1/admin/shows/${SHOW_ID}/tax-policy`,
        {
          method,
          headers: {
            cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
            origin: "https://dustwave.xyz",
            ...(method === "PUT"
              ? {
                  "content-type": "application/json",
                  "x-podcast-csrf": csrfToken
                }
              : {})
          },
          ...(body ? { body: JSON.stringify(body) } : {})
        }
      );
    }
  };
}
