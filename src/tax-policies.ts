import { sha256Hex } from "@dustwave/worker-core/crypto";
import taxPolicyCandidates from "../config/tax-policy-candidates.json";

import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import { prepareAdminAuditAfterSingleChange } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  createPodcastStripeClient,
  logStripeBoundaryError,
  stripeErrorStatus,
  validStripeId
} from "./stripe-client";
import {
  positiveInteger,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validDateTime,
  validIdentifier
} from "./validation";

type TaxPolicyInput = {
  jurisdictionCode: string;
  ratePartsPerMillion: number;
  inclusive: boolean;
  providerName: string;
  sourceReference: string;
  effectiveAt: string;
  expiresAt: string | null;
  displayName: string;
};

type StoredTaxPolicy = {
  id: string;
  jurisdiction_code: string;
  rate_parts_per_million: number;
  inclusive: number;
  stripe_tax_rate_id: string | null;
  provider_name: string;
  source_reference: string;
  effective_at: string;
  expires_at: string | null;
  provider_mode: "test" | "live";
  status: "approved";
  approved_by_admin_user_id: string;
  assigned: number;
};

type TaxPolicyCandidate = TaxPolicyInput & {
  applicableMode: "test" | "live";
};

export async function getAdminShowTaxPolicy(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    showId
  });
  if (!auth.ok) return auth.response;
  const mode = expectedStripeMode(env);
  const show = await env.DB.prepare(
    `SELECT id, premium_enabled, billing_mode
     FROM shows
     WHERE id = ? AND status != 'archived'`
  ).bind(showId).first<{
    id: string;
    premium_enabled: number;
    billing_mode: string;
  }>();
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  const policies = await env.DB.prepare(
    `SELECT
       t.id, t.jurisdiction_code, t.rate_parts_per_million, t.inclusive,
       t.stripe_tax_rate_id, t.provider_name, t.source_reference,
       t.effective_at, t.expires_at, t.provider_mode, t.status,
       t.approved_by_admin_user_id, 1 AS assigned
     FROM show_tax_rate_assignments a
     JOIN tax_rate_versions t ON t.id = a.tax_rate_version_id
     WHERE a.show_id = ?
       AND t.status = 'approved'
       AND t.provider_mode = ?
     ORDER BY t.jurisdiction_code, t.effective_at DESC
     LIMIT 50`
  ).bind(showId, mode).all<StoredTaxPolicy>();
  const candidate = configuredCandidate(showId, mode);
  return privateJson(request, env.ALLOWED_ORIGINS, {
    showId,
    providerMode: mode,
    showReady: show.premium_enabled === 1 && show.billing_mode === mode,
    policies: policies.results.map(presentTaxPolicy),
    candidate: candidate
      ? {
          ...candidate,
          confirmation: taxPolicyConfirmation(showId, candidate)
        }
      : null
  });
}

export async function configureAdminShowTaxPolicy(
  request: Request,
  env: PodcastEnv,
  showIdValue: string
): Promise<Response> {
  const showId = validIdentifier(showIdValue, "showId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true,
    showId
  });
  if (!auth.ok) return auth.response;
  const recent = await requireRecentAdminAuthentication(
    request,
    env,
    auth.authorization.identity.id
  );
  if (recent) return recent;
  if (!env.STRIPE_SECRET_KEY) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "stripe_not_configured" },
      { status: 503 }
    );
  }

  const body = await readJsonObject(request, 8_192);
  const input = validateTaxPolicyInput(body);
  const confirmation = requiredText(
    body.confirmation,
    "confirmation",
    240
  );
  const expectedConfirmation = taxPolicyConfirmation(showId, input);
  if (confirmation !== expectedConfirmation) {
    throw new RequestValidationError(
      `Type ${expectedConfirmation} to confirm`,
      "tax_policy_confirmation_required"
    );
  }
  const mode = expectedStripeMode(env);
  const show = await env.DB.prepare(
    `SELECT id, premium_enabled, billing_mode
     FROM shows
     WHERE id = ? AND status != 'archived'`
  ).bind(showId).first<{
    id: string;
    premium_enabled: number;
    billing_mode: string;
  }>();
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  if (show.premium_enabled !== 1 || show.billing_mode !== mode) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_billing_not_ready" },
      { status: 409 }
    );
  }

  const digest = await sha256Hex(JSON.stringify({
    schemaVersion: "dustwave-podcast-tax-policy-v1",
    showId,
    mode,
    ...input
  }));
  const policyId = `tax_${digest.slice(0, 40)}`;
  let stored = await loadStoredTaxPolicy(env.DB, showId, policyId);
  const existed = Boolean(stored);
  if (stored && !storedTaxPolicyMatches(stored, input, mode)) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "tax_policy_conflict" },
      { status: 409 }
    );
  }

  let providerTaxRateId = stored?.stripe_tax_rate_id ?? "";
  try {
    const stripe = createPodcastStripeClient(env);
    const provider = stored
      ? await stripe.taxRates.retrieve(
        validStripeId(providerTaxRateId, "txr")
      )
      : await stripe.taxRates.create(
        stripeTaxRateInput(showId, policyId, input),
        { idempotencyKey: `podcast-tax-policy-${digest}` }
      );
    providerTaxRateId = validateProviderTaxRate(
      provider,
      policyId,
      showId,
      input,
      mode
    );
  } catch (error) {
    logStripeBoundaryError("tax_policy_provider_failed", error);
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "tax_policy_provider_unavailable" },
      { status: stripeErrorStatus(error) }
    );
  }

  if (!stored) {
    const adminId = auth.authorization.identity.id;
    const insert = env.DB.prepare(
      `INSERT OR IGNORE INTO tax_rate_versions (
         id, jurisdiction_code, rate_basis_points, inclusive,
         stripe_tax_rate_id, provider_name, source_reference, effective_at,
         expires_at, status, approved_by_admin_user_id, approved_at,
         rate_parts_per_million, provider_mode
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'), ?, ?)`
    ).bind(
      policyId,
      input.jurisdictionCode,
      Math.round(input.ratePartsPerMillion / 100),
      input.inclusive ? 1 : 0,
      providerTaxRateId,
      input.providerName,
      input.sourceReference,
      input.effectiveAt,
      input.expiresAt,
      adminId,
      input.ratePartsPerMillion,
      mode
    );
    await env.DB.batch([
      insert,
      prepareAdminAuditAfterSingleChange(env.DB, {
        adminUserId: adminId,
        action: "show.tax_policy.approve",
        targetType: "show",
        targetId: showId,
        metadata: {
          policyId,
          jurisdictionCode: input.jurisdictionCode,
          ratePartsPerMillion: input.ratePartsPerMillion,
          inclusive: input.inclusive,
          providerName: input.providerName,
          providerMode: mode,
          effectiveAt: input.effectiveAt,
          expiresAt: input.expiresAt
        }
      }),
      env.DB.prepare(
        `UPDATE tax_rate_versions
         SET status = 'retired'
         WHERE id != ?
           AND jurisdiction_code = ?
           AND provider_mode = ?
           AND status = 'approved'
           AND id IN (
             SELECT tax_rate_version_id
             FROM show_tax_rate_assignments
             WHERE show_id = ?
           )`
      ).bind(policyId, input.jurisdictionCode, mode, showId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO show_tax_rate_assignments (
           show_id, tax_rate_version_id, assigned_by_admin_user_id
         ) VALUES (?, ?, ?)`
      ).bind(showId, policyId, adminId)
    ]);
    stored = await loadStoredTaxPolicy(env.DB, showId, policyId);
  }
  if (
    !stored
    || !storedTaxPolicyMatches(stored, input, mode)
    || stored.stripe_tax_rate_id !== providerTaxRateId
    || stored.assigned !== 1
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "tax_policy_commit_failed" },
      { status: 503 }
    );
  }
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      policy: presentTaxPolicy(stored),
      idempotent: existed
    },
    { status: existed ? 200 : 201 }
  );
}

export function validateTaxPolicyInput(
  body: Record<string, unknown>
): TaxPolicyInput {
  const jurisdictionCode = requiredText(
    body.jurisdictionCode,
    "jurisdictionCode",
    48
  ).toUpperCase();
  if (!/^[A-Z]{2}(?:-[A-Z0-9]{2,12}){0,2}$/.test(jurisdictionCode)) {
    throw new RequestValidationError("jurisdictionCode is invalid");
  }
  const ratePartsPerMillion = positiveInteger(
    body.ratePartsPerMillion,
    "ratePartsPerMillion",
    1_000_000
  );
  if (typeof body.inclusive !== "boolean") {
    throw new RequestValidationError("inclusive must be a boolean");
  }
  const providerName = safePolicyText(
    body.providerName,
    "providerName",
    80
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(providerName)) {
    throw new RequestValidationError("providerName is invalid");
  }
  const sourceReference = safePolicyText(
    body.sourceReference,
    "sourceReference",
    300
  );
  const effectiveAt = validDateTime(body.effectiveAt, "effectiveAt");
  if (!effectiveAt) {
    throw new RequestValidationError("effectiveAt is required");
  }
  const expiresAt = validDateTime(body.expiresAt, "expiresAt");
  if (expiresAt && expiresAt <= effectiveAt) {
    throw new RequestValidationError("expiresAt must follow effectiveAt");
  }
  const displayName = safePolicyText(body.displayName, "displayName", 50);
  return {
    jurisdictionCode,
    ratePartsPerMillion,
    inclusive: body.inclusive,
    providerName,
    sourceReference,
    effectiveAt,
    expiresAt,
    displayName
  };
}

export function taxPolicyConfirmation(
  showId: string,
  input: TaxPolicyInput
): string {
  return `APPROVE_TAX_POLICY ${showId} ${
    input.jurisdictionCode
  } ${input.ratePartsPerMillion}`;
}

function stripeTaxRateInput(
  showId: string,
  policyId: string,
  input: TaxPolicyInput
): Record<string, unknown> {
  const [country, state] = input.jurisdictionCode.split("-");
  return {
    display_name: input.displayName,
    description: "Dust Wave podcast subscription tax policy",
    percentage: stripePercentage(input.ratePartsPerMillion),
    inclusive: input.inclusive,
    country,
    ...(state ? { state } : {}),
    metadata: {
      platform: "dust_wave_podcast",
      show_id: showId,
      policy_id: policyId
    }
  };
}

export function stripePercentage(ratePartsPerMillion: number): string {
  const whole = Math.floor(ratePartsPerMillion / 10_000);
  const fraction = String(ratePartsPerMillion % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function validateProviderTaxRate(
  value: Record<string, unknown>,
  policyId: string,
  showId: string,
  input: TaxPolicyInput,
  mode: "test" | "live"
): string {
  const metadata = value.metadata && typeof value.metadata === "object"
    ? value.metadata as Record<string, unknown>
    : {};
  const [, state] = input.jurisdictionCode.split("-");
  if (
    value.object !== "tax_rate"
    || value.livemode !== (mode === "live")
    || value.active !== true
    || Math.round(Number(value.percentage) * 10_000)
      !== input.ratePartsPerMillion
    || value.inclusive !== input.inclusive
    || String(value.country ?? "").toUpperCase()
      !== input.jurisdictionCode.slice(0, 2)
    || String(value.state ?? "").toUpperCase() !== (state ?? "")
    || metadata.platform !== "dust_wave_podcast"
    || metadata.show_id !== showId
    || metadata.policy_id !== policyId
  ) {
    throw new Error("Invalid Stripe Tax Rate response");
  }
  return validStripeId(value.id, "txr");
}

async function loadStoredTaxPolicy(
  db: D1Database,
  showId: string,
  policyId: string
): Promise<StoredTaxPolicy | null> {
  return db.prepare(
    `SELECT
       t.id, t.jurisdiction_code, t.rate_parts_per_million, t.inclusive,
       t.stripe_tax_rate_id, t.provider_name, t.source_reference,
       t.effective_at, t.expires_at, t.provider_mode, t.status,
       t.approved_by_admin_user_id,
       CASE WHEN a.show_id IS NULL THEN 0 ELSE 1 END AS assigned
     FROM tax_rate_versions t
     LEFT JOIN show_tax_rate_assignments a
       ON a.tax_rate_version_id = t.id AND a.show_id = ?
     WHERE t.id = ?`
  ).bind(showId, policyId).first<StoredTaxPolicy>();
}

function storedTaxPolicyMatches(
  stored: StoredTaxPolicy,
  input: TaxPolicyInput,
  mode: "test" | "live"
): boolean {
  return stored.jurisdiction_code === input.jurisdictionCode
    && stored.rate_parts_per_million === input.ratePartsPerMillion
    && stored.inclusive === (input.inclusive ? 1 : 0)
    && stored.provider_name === input.providerName
    && stored.source_reference === input.sourceReference
    && new Date(stored.effective_at).toISOString() === input.effectiveAt
    && (stored.expires_at
      ? new Date(stored.expires_at).toISOString()
      : null) === input.expiresAt
    && stored.provider_mode === mode
    && stored.status === "approved"
    && Boolean(stored.approved_by_admin_user_id);
}

function presentTaxPolicy(stored: StoredTaxPolicy) {
  return {
    id: stored.id,
    jurisdictionCode: stored.jurisdiction_code,
    ratePartsPerMillion: stored.rate_parts_per_million,
    inclusive: stored.inclusive === 1,
    providerName: stored.provider_name,
    sourceReference: stored.source_reference,
    effectiveAt: stored.effective_at,
    expiresAt: stored.expires_at,
    providerMode: stored.provider_mode,
    status: stored.status,
    assigned: stored.assigned === 1,
    providerReady: Boolean(stored.stripe_tax_rate_id)
  };
}

function safePolicyText(
  value: unknown,
  field: string,
  maximumLength: number
): string {
  const text = requiredText(value, field, maximumLength);
  if (/[\u0000-\u001F\u007F]/u.test(text)) {
    throw new RequestValidationError(`${field} contains control characters`);
  }
  return text;
}

function expectedStripeMode(env: PodcastEnv): "test" | "live" {
  return String(env.STRIPE_MODE) === "live" ? "live" : "test";
}

function configuredCandidate(
  showId: string,
  mode: "test" | "live"
): TaxPolicyCandidate | null {
  const shows = taxPolicyCandidates.shows as Record<string, unknown>;
  const raw = shows[showId];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidateRecord = raw as Record<string, unknown>;
  const applicableMode = candidateRecord.applicableMode;
  if (applicableMode !== "test" && applicableMode !== "live") return null;
  if (applicableMode !== mode) return null;
  return {
    ...validateTaxPolicyInput(candidateRecord),
    applicableMode
  };
}
