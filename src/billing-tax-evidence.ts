import {
  normalizeTaxDestination,
  type TaxDestination
} from "@dustwave/tax-core";
import {
  hmacSha256,
  timingSafeEqual
} from "@dustwave/worker-core/crypto";

import { adminCsvResponse } from "./admin-csv";
import { requireAdmin } from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  resolveSubscriptionTaxQuote,
  type SubscriptionTaxResolution
} from "./tax-quotes";
import {
  RequestValidationError,
  validIdentifier
} from "./validation";

const INVOICE_EVENT_TYPES = new Set([
  "invoice.created",
  "invoice.updated",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible"
]);

type SubscriptionTaxContext = {
  listener_id: string;
  show_id: string;
  show_slug: string;
  price_id: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string;
  destination_hash: string | null;
  tax_rate_version_id: string | null;
  jurisdiction_code: string | null;
  tax_rate_parts_per_million: number | null;
  tax_behavior: "exclusive" | "inclusive" | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  stripe_tax_rate_id: string | null;
};

type TaxEvidenceRow = {
  event_id: string;
  provider_invoice_id: string;
  provider_subscription_id: string;
  show_id: string;
  show_title: string;
  price_id: string | null;
  provider_mode: string;
  invoice_event_type: string;
  invoice_status: string;
  billing_reason: string | null;
  currency: string;
  subtotal_cents: number | null;
  observed_tax_cents: number | null;
  total_cents: number | null;
  amount_paid_cents: number | null;
  period_start: string | null;
  period_end: string | null;
  expected_tax_rate_version_id: string | null;
  expected_jurisdiction_code: string | null;
  expected_rate_parts_per_million: number | null;
  expected_tax_behavior: string | null;
  expected_subtotal_cents: number | null;
  expected_tax_cents: number | null;
  expected_total_cents: number | null;
  observed_tax_rate_ids_json: string;
  reconciliation_status: string;
  created_at: string;
};

const TAX_EVIDENCE_SELECT = `SELECT
  evidence.event_id,
  evidence.provider_invoice_id,
  evidence.provider_subscription_id,
  evidence.show_id,
  shows.title AS show_title,
  evidence.price_id,
  evidence.provider_mode,
  evidence.invoice_event_type,
  evidence.invoice_status,
  evidence.billing_reason,
  evidence.currency,
  evidence.subtotal_cents,
  evidence.observed_tax_cents,
  evidence.total_cents,
  evidence.amount_paid_cents,
  evidence.period_start,
  evidence.period_end,
  evidence.expected_tax_rate_version_id,
  evidence.expected_jurisdiction_code,
  evidence.expected_rate_parts_per_million,
  evidence.expected_tax_behavior,
  evidence.expected_subtotal_cents,
  evidence.expected_tax_cents,
  evidence.expected_total_cents,
  evidence.observed_tax_rate_ids_json,
  evidence.reconciliation_status,
  evidence.created_at
FROM subscription_invoice_tax_evidence evidence
JOIN shows ON shows.id = evidence.show_id`;

export async function projectStripeTaxEvent(
  env: PodcastEnv,
  eventId: string,
  type: string,
  object: Record<string, unknown>
): Promise<boolean> {
  if (INVOICE_EVENT_TYPES.has(type)) {
    return projectInvoiceTaxEvidence(env, eventId, type, object);
  }
  if (type === "customer.updated") {
    return projectCustomerTaxPreview(env, eventId, object);
  }
  return false;
}

export async function listBillingTaxEvidence(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"]
  });
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const showIdValue = url.searchParams.get("showId");
  const showId = showIdValue
    ? validIdentifier(showIdValue, "showId")
    : null;
  const format = url.searchParams.get("format") || "json";
  if (!["json", "csv"].includes(format)) {
    throw new RequestValidationError("format must be json or csv");
  }
  const requestedLimit = Number(url.searchParams.get("limit") || "250");
  if (
    !Number.isSafeInteger(requestedLimit)
    || requestedLimit < 1
    || requestedLimit > 500
  ) {
    throw new RequestValidationError(
      "limit must be an integer from 1 to 500"
    );
  }
  const evidenceSql = `${TAX_EVIDENCE_SELECT}
${showId ? "WHERE evidence.show_id = ?" : ""}
ORDER BY evidence.created_at DESC, evidence.event_id DESC
LIMIT ?`;
  const statement = env.DB.prepare(evidenceSql);
  const rows = await (
    showId
      ? statement.bind(showId, requestedLimit)
      : statement.bind(requestedLimit)
  ).all<TaxEvidenceRow>();
  const evidence = rows.results.map(presentTaxEvidence);
  if (format === "csv") {
    return adminCsvResponse(request, env.ALLOWED_ORIGINS, {
      filename: "podcast-subscription-tax-evidence.csv",
      columns: TAX_EVIDENCE_COLUMNS,
      rows: evidence
    });
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    evidence,
    count: evidence.length,
    limit: requestedLimit,
    truncated: evidence.length === requestedLimit
  });
}

async function projectInvoiceTaxEvidence(
  env: PodcastEnv,
  eventId: string,
  type: string,
  object: Record<string, unknown>
): Promise<boolean> {
  const invoiceId = providerId(object.id, "in");
  const subscriptionId = invoiceSubscriptionId(object);
  if (!invoiceId || !subscriptionId) return false;
  const context = await loadSubscriptionTaxContext(env.DB, subscriptionId);
  if (!context) {
    if (invoiceHasDustWaveMetadata(object)) {
      throw new Error("subscription_tax_context_not_found");
    }
    return false;
  }
  verifyExpectedProviderCustomer(context.provider_customer_id, object.customer);
  const observedRateIds = collectObservedTaxRateIds(object);
  const observedTaxCents = invoiceTaxCents(object);
  const reconciliationStatus = reconcileInvoiceTax(
    context,
    observedRateIds,
    observedTaxCents
  );
  const period = invoicePeriod(object);
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO subscription_invoice_tax_evidence (
         event_id,
         provider_invoice_id,
         provider_subscription_id,
         listener_id,
         show_id,
         price_id,
         provider_mode,
         invoice_event_type,
         invoice_status,
         billing_reason,
         currency,
         subtotal_cents,
         observed_tax_cents,
         total_cents,
         amount_paid_cents,
         period_start,
         period_end,
         destination_hash,
         expected_tax_rate_version_id,
         expected_jurisdiction_code,
         expected_rate_parts_per_million,
         expected_tax_behavior,
         expected_subtotal_cents,
         expected_tax_cents,
         expected_total_cents,
         expected_stripe_tax_rate_id,
         observed_tax_rate_ids_json,
         reconciliation_status
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?
       )`
    )
    .bind(
      eventId,
      invoiceId,
      subscriptionId,
      context.listener_id,
      context.show_id,
      context.price_id,
      stripeMode(env),
      type,
      boundedProviderText(object.status, 32) || "unknown",
      boundedProviderText(object.billing_reason, 64),
      boundedCurrency(object.currency),
      boundedCents(object.subtotal),
      observedTaxCents,
      boundedCents(object.total),
      boundedCents(object.amount_paid),
      period.start,
      period.end,
      context.destination_hash,
      context.tax_rate_version_id,
      context.jurisdiction_code,
      context.tax_rate_parts_per_million,
      context.tax_behavior,
      context.subtotal_cents,
      context.tax_cents,
      context.total_cents,
      context.stripe_tax_rate_id,
      JSON.stringify(observedRateIds),
      reconciliationStatus
    )
    .run();
  return true;
}

async function projectCustomerTaxPreview(
  env: PodcastEnv,
  eventId: string,
  object: Record<string, unknown>
): Promise<boolean> {
  const customerId = providerId(object.id, "cus");
  if (!customerId) return false;
  const subscriptions = await env.DB
    .prepare(
      `SELECT
         source.listener_id,
         source.show_id,
         shows.slug AS show_slug,
         source.price_id,
         source.provider_customer_id,
         source.provider_subscription_id,
         attempt.destination_hash,
         attempt.tax_rate_version_id,
         attempt.jurisdiction_code,
         attempt.tax_rate_parts_per_million
       FROM subscription_entitlement_sources source
       JOIN shows ON shows.id = source.show_id
       LEFT JOIN subscription_checkout_attempts attempt
         ON attempt.id = (
           SELECT latest.id
           FROM subscription_checkout_attempts latest
           WHERE latest.listener_id = source.listener_id
             AND latest.show_id = source.show_id
             AND latest.price_id = source.price_id
             AND latest.status = 'completed'
           ORDER BY latest.created_at DESC, latest.id DESC
           LIMIT 1
         )
       WHERE source.provider = 'stripe'
         AND source.provider_customer_id = ?
         AND source.provider_subscription_id IS NOT NULL
       ORDER BY source.show_id`
    )
    .bind(customerId)
    .all<{
      listener_id: string;
      show_id: string;
      show_slug: string;
      price_id: string | null;
      provider_customer_id: string | null;
      provider_subscription_id: string;
      destination_hash: string | null;
      tax_rate_version_id: string | null;
      jurisdiction_code: string | null;
      tax_rate_parts_per_million: number | null;
    }>();
  if (subscriptions.results.length === 0) return false;

  const normalized = normalizeTaxDestination(object.address);
  for (const subscription of subscriptions.results) {
    let destinationHash: string | null = null;
    let resolution: SubscriptionTaxResolution | null = null;
    let previewStatus:
      | "unchanged"
      | "rate_changed"
      | "destination_invalid"
      | "rate_missing"
      | "configuration_mismatch"
      | "configuration_missing";
    if (!normalized.valid) {
      previewStatus = "destination_invalid";
    } else if (!env.TAX_QUOTE_HASH_SECRET || !subscription.price_id) {
      previewStatus = "configuration_missing";
    } else {
      destinationHash = await hashTaxDestination(
        normalized.destination,
        env.TAX_QUOTE_HASH_SECRET
      );
      resolution = await resolveSubscriptionTaxQuote(
        env,
        subscription.show_slug,
        subscription.price_id,
        normalized.destination
      );
      previewStatus = previewResolutionStatus(
        subscription,
        destinationHash,
        resolution
      );
    }
    const quote = resolution?.ok ? resolution.quote : null;
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO subscription_tax_change_previews (
           event_id,
           provider_subscription_id,
           listener_id,
           show_id,
           price_id,
           provider_mode,
           destination_hash,
           prior_destination_hash,
           prior_tax_rate_version_id,
           resolved_tax_rate_version_id,
           prior_jurisdiction_code,
           resolved_jurisdiction_code,
           prior_rate_parts_per_million,
           resolved_rate_parts_per_million,
           preview_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        eventId,
        subscription.provider_subscription_id,
        subscription.listener_id,
        subscription.show_id,
        subscription.price_id,
        stripeMode(env),
        destinationHash,
        subscription.destination_hash,
        subscription.tax_rate_version_id,
        quote?.taxRate.id ?? null,
        subscription.jurisdiction_code,
        quote?.taxRate.jurisdiction_code.toUpperCase() ?? null,
        subscription.tax_rate_parts_per_million,
        quote?.taxRate.rate_parts_per_million ?? null,
        previewStatus
      )
      .run();
  }
  return true;
}

async function loadSubscriptionTaxContext(
  db: D1Database,
  subscriptionId: string
): Promise<SubscriptionTaxContext | null> {
  return db
    .prepare(
      `SELECT
         source.listener_id,
         source.show_id,
         shows.slug AS show_slug,
         source.price_id,
         source.provider_customer_id,
         source.provider_subscription_id,
         attempt.destination_hash,
         attempt.tax_rate_version_id,
         attempt.jurisdiction_code,
         attempt.tax_rate_parts_per_million,
         attempt.tax_behavior,
         attempt.subtotal_cents,
         attempt.tax_cents,
         attempt.total_cents,
         tax.stripe_tax_rate_id
       FROM subscription_entitlement_sources source
       JOIN shows ON shows.id = source.show_id
       LEFT JOIN subscription_checkout_attempts attempt
         ON attempt.id = (
           SELECT latest.id
           FROM subscription_checkout_attempts latest
           WHERE latest.listener_id = source.listener_id
             AND latest.show_id = source.show_id
             AND latest.price_id = source.price_id
             AND latest.status = 'completed'
           ORDER BY latest.created_at DESC, latest.id DESC
           LIMIT 1
         )
       LEFT JOIN tax_rate_versions tax
         ON tax.id = attempt.tax_rate_version_id
       WHERE source.provider = 'stripe'
         AND source.provider_subscription_id = ?`
    )
    .bind(subscriptionId)
    .first<SubscriptionTaxContext>();
}

function previewResolutionStatus(
  prior: {
    destination_hash: string | null;
    tax_rate_version_id: string | null;
    tax_rate_parts_per_million: number | null;
  },
  destinationHash: string,
  resolution: SubscriptionTaxResolution
):
  | "unchanged"
  | "rate_changed"
  | "rate_missing"
  | "configuration_mismatch" {
  if (!resolution.ok) {
    return resolution.error === "tax_rate_not_approved"
      ? "rate_missing"
      : "configuration_mismatch";
  }
  return (
    prior.destination_hash === destinationHash
    && prior.tax_rate_version_id === resolution.quote.taxRate.id
    && prior.tax_rate_parts_per_million
      === resolution.quote.taxRate.rate_parts_per_million
  ) ? "unchanged" : "rate_changed";
}

function reconcileInvoiceTax(
  context: SubscriptionTaxContext,
  observedRateIds: string[],
  observedTaxCents: number | null
):
  | "matched"
  | "mismatched"
  | "missing_checkout_evidence"
  | "missing_provider_tax_evidence" {
  if (
    !context.tax_rate_version_id
    || !context.stripe_tax_rate_id
    || context.tax_cents === null
  ) {
    return "missing_checkout_evidence";
  }
  if (observedRateIds.length === 0 || observedTaxCents === null) {
    return "missing_provider_tax_evidence";
  }
  return (
    observedRateIds.includes(context.stripe_tax_rate_id)
    && observedTaxCents === context.tax_cents
  ) ? "matched" : "mismatched";
}

function collectObservedTaxRateIds(
  object: Record<string, unknown>
): string[] {
  const ids = new Set<string>();
  collectTaxRateIds(object.default_tax_rates, ids);
  collectTaxRateIds(object.total_tax_amounts, ids);
  collectTaxRateIds(object.total_taxes, ids);
  const lines = recordOrNull(object.lines);
  if (Array.isArray(lines?.data)) {
    for (const line of lines.data) {
      const row = recordOrNull(line);
      collectTaxRateIds(row?.tax_rates, ids);
      collectTaxRateIds(row?.taxes, ids);
    }
  }
  return [...ids].sort();
}

function collectTaxRateIds(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTaxRateIds(item, result);
    return;
  }
  if (typeof value === "string") {
    const id = providerId(value, "txr");
    if (id) result.add(id);
    return;
  }
  const record = recordOrNull(value);
  if (!record) return;
  for (const key of ["id", "tax_rate", "tax_rate_details"]) {
    collectTaxRateIds(record[key], result);
  }
}

function invoiceTaxCents(object: Record<string, unknown>): number | null {
  const candidates = [object.total_tax_amounts, object.total_taxes];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const amounts = candidate.map((entry) =>
      boundedCents(recordOrNull(entry)?.amount)
    );
    if (amounts.some((amount) => amount === null)) continue;
    return amounts.reduce<number>(
      (sum, amount) => sum + (amount ?? 0),
      0
    );
  }
  return boundedCents(object.tax);
}

function invoiceSubscriptionId(
  object: Record<string, unknown>
): string | null {
  const legacy = providerId(object.subscription, "sub");
  if (legacy) return legacy;
  const parent = recordOrNull(object.parent);
  const details = recordOrNull(parent?.subscription_details);
  return providerId(details?.subscription, "sub");
}

function invoiceHasDustWaveMetadata(
  object: Record<string, unknown>
): boolean {
  const parent = recordOrNull(object.parent);
  const parentDetails = recordOrNull(parent?.subscription_details);
  const legacyDetails = recordOrNull(object.subscription_details);
  const metadata = recordOrNull(
    parentDetails?.metadata ?? legacyDetails?.metadata
  );
  return Boolean(
    boundedProviderText(metadata?.dustwave_show_id, 128)
    || boundedProviderText(metadata?.dustwave_checkout_attempt_id, 128)
  );
}

function invoicePeriod(
  object: Record<string, unknown>
): { start: string | null; end: string | null } {
  const start = unixDateTime(object.period_start);
  const end = unixDateTime(object.period_end);
  if (start || end) return { start, end };
  const lines = recordOrNull(object.lines);
  const first = Array.isArray(lines?.data)
    ? recordOrNull(lines.data[0])
    : null;
  const period = recordOrNull(first?.period);
  return {
    start: unixDateTime(period?.start),
    end: unixDateTime(period?.end)
  };
}

async function hashTaxDestination(
  destination: TaxDestination,
  secret: string
): Promise<string> {
  return hmacSha256(
    JSON.stringify({
      country: destination.country,
      state: destination.state,
      postalCode: destination.postalCode,
      city: destination.city,
      line1: destination.line1,
      line2: destination.line2
    }),
    secret,
    "hex"
  );
}

function verifyExpectedProviderCustomer(
  expected: string | null,
  actualValue: unknown
): void {
  const actual = providerId(actualValue, "cus");
  if (expected && (!actual || !timingSafeEqual(expected, actual))) {
    throw new Error("provider_customer_mismatch");
  }
}

function providerId(value: unknown, prefix: string): string | null {
  const text = typeof value === "string" ? value : recordOrNull(value)?.id;
  return typeof text === "string"
    && new RegExp(`^${prefix}_[A-Za-z0-9_]{6,128}$`).test(text)
    ? text
    : null;
}

function boundedCents(value: unknown): number | null {
  const amount = Number(value);
  return Number.isSafeInteger(amount)
    && amount >= 0
    && amount <= 999_999_999
    ? amount
    : null;
}

function boundedCurrency(value: unknown): string {
  const currency = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "UNK";
}

function boundedProviderText(
  value: unknown,
  maximumLength: number
): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximumLength && /^[a-z0-9_.-]+$/i.test(text)
    ? text
    : null;
}

function unixDateTime(value: unknown): string | null {
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0
    ? new Date(seconds * 1_000).toISOString()
    : null;
}

function stripeMode(env: PodcastEnv): "test" | "live" {
  return String(env.STRIPE_MODE) === "live" ? "live" : "test";
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function presentTaxEvidence(row: TaxEvidenceRow): Record<string, unknown> {
  return {
    eventId: row.event_id,
    providerInvoiceId: row.provider_invoice_id,
    providerSubscriptionId: row.provider_subscription_id,
    showId: row.show_id,
    showTitle: row.show_title,
    priceId: row.price_id,
    providerMode: row.provider_mode,
    eventType: row.invoice_event_type,
    invoiceStatus: row.invoice_status,
    billingReason: row.billing_reason,
    currency: row.currency,
    subtotalCents: row.subtotal_cents,
    observedTaxCents: row.observed_tax_cents,
    totalCents: row.total_cents,
    amountPaidCents: row.amount_paid_cents,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    expectedTaxRateVersionId: row.expected_tax_rate_version_id,
    expectedJurisdictionCode: row.expected_jurisdiction_code,
    expectedRatePartsPerMillion: row.expected_rate_parts_per_million,
    expectedTaxBehavior: row.expected_tax_behavior,
    expectedSubtotalCents: row.expected_subtotal_cents,
    expectedTaxCents: row.expected_tax_cents,
    expectedTotalCents: row.expected_total_cents,
    observedTaxRateIds: parseTaxRateIds(row.observed_tax_rate_ids_json),
    reconciliationStatus: row.reconciliation_status,
    recordedAt: row.created_at
  };
}

function parseTaxRateIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

const TAX_EVIDENCE_COLUMNS = [
    "eventId",
    "providerInvoiceId",
    "providerSubscriptionId",
    "showId",
    "showTitle",
    "priceId",
    "providerMode",
    "eventType",
    "invoiceStatus",
    "billingReason",
    "currency",
    "subtotalCents",
    "observedTaxCents",
    "totalCents",
    "amountPaidCents",
    "periodStart",
    "periodEnd",
    "expectedTaxRateVersionId",
    "expectedJurisdictionCode",
    "expectedRatePartsPerMillion",
    "expectedTaxBehavior",
    "expectedSubtotalCents",
    "expectedTaxCents",
    "expectedTotalCents",
    "observedTaxRateIds",
    "reconciliationStatus",
    "recordedAt"
  ];
