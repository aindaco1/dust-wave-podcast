import {
  requireAdmin,
  requireRecentAdminAuthentication
} from "./admin-auth";
import { prepareAdminAuditAfterChanges } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  isTruthy,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const MINIMUM_PRICE_CENTS = 100;
const MAXIMUM_PRICE_CENTS = 1_000_000;
const PRICE_PERIODS = ["month", "year"] as const;

export const PREMIUM_PRICE_UPDATE_SQL = `UPDATE show_prices
SET
  stripe_price_id = CASE
    WHEN billing_period = 'month' AND amount_cents != ? THEN NULL
    WHEN billing_period = 'year' AND amount_cents != ? THEN NULL
    ELSE stripe_price_id
  END,
  amount_cents = CASE
    WHEN billing_period = 'month' THEN ?
    WHEN billing_period = 'year' THEN ?
    ELSE amount_cents
  END
WHERE
  show_id = ?
  AND active = 1
  AND currency = 'USD'
  AND billing_period IN ('month', 'year')
  AND (
    SELECT COUNT(*)
    FROM show_prices current
    WHERE
      current.show_id = ?
      AND current.active = 1
      AND current.currency = 'USD'
      AND (
        (
          current.id = ?
          AND current.billing_period = 'month'
          AND current.amount_cents = ?
        )
        OR (
          current.id = ?
          AND current.billing_period = 'year'
          AND current.amount_cents = ?
        )
      )
  ) = 2`;

type PricePeriod = typeof PRICE_PERIODS[number];

type ShowBillingRow = {
  id: string;
  billing_mode: string;
};

type PremiumPriceRow = {
  id: string;
  billing_period: PricePeriod;
  amount_cents: number;
  currency: string;
  stripe_price_id: string | null;
  provider_mode: string;
  active: number;
};

type BillingHistoryRow = {
  subscription_count: number;
  checkout_attempt_count: number;
};

type PremiumPriceContext = {
  show: ShowBillingRow;
  monthly: PremiumPriceRow;
  annual: PremiumPriceRow;
  expectedProviderMode: "test" | "live";
  subscriptionCount: number;
  checkoutAttemptCount: number;
  blockers: string[];
};

export async function getAdminShowPremiumPrices(
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
  const context = await loadPremiumPriceContext(request, env, showId);
  if (context instanceof Response) return context;
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    presentPremiumPriceContext(env, context)
  );
}

export async function configureAdminShowPremiumPrices(
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

  const body = await readJsonObject(request, 5_000);
  const monthlyCents = validPriceCents(body.monthlyCents, "monthlyCents");
  const annualCents = validPriceCents(body.annualCents, "annualCents");
  validatePremiumPricePair(monthlyCents, annualCents);
  const expectedMonthlyCents = validPriceCents(
    body.expectedMonthlyCents,
    "expectedMonthlyCents"
  );
  const expectedAnnualCents = validPriceCents(
    body.expectedAnnualCents,
    "expectedAnnualCents"
  );
  const confirmation = requiredText(
    body.confirmation,
    "confirmation",
    140
  );
  if (confirmation !== `CONFIGURE_SHOW_PRICES ${showId}`) {
    throw new RequestValidationError(
      `Type CONFIGURE_SHOW_PRICES ${showId} to confirm`,
      "show_price_configuration_confirmation_required"
    );
  }

  const context = await loadPremiumPriceContext(request, env, showId);
  if (context instanceof Response) return context;
  if (
    context.monthly.amount_cents !== expectedMonthlyCents
    || context.annual.amount_cents !== expectedAnnualCents
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "show_price_configuration_conflict",
        ...presentPremiumPriceContext(env, context)
      },
      { status: 409 }
    );
  }

  const changedPeriods = [
    ...(monthlyCents === context.monthly.amount_cents ? [] : ["month"]),
    ...(annualCents === context.annual.amount_cents ? [] : ["year"])
  ];
  if (changedPeriods.length === 0) {
    return privateJson(request, env.ALLOWED_ORIGINS, {
      updated: false,
      idempotent: true,
      providerProvisioningRequired: !providerReady(context),
      ...presentPremiumPriceContext(env, context)
    });
  }
  if (context.blockers.length > 0) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      {
        error: "show_price_configuration_locked",
        blockers: context.blockers
      },
      { status: 409 }
    );
  }

  const update = env.DB.prepare(PREMIUM_PRICE_UPDATE_SQL).bind(
    monthlyCents,
    annualCents,
    monthlyCents,
    annualCents,
    showId,
    showId,
    context.monthly.id,
    expectedMonthlyCents,
    context.annual.id,
    expectedAnnualCents
  );
  const results = await env.DB.batch([
    update,
    prepareAdminAuditAfterChanges(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "show.premium_prices.configure",
      targetType: "show",
      targetId: showId,
      metadata: {
        currency: "USD",
        changedPeriods,
        previousMonthlyCents: expectedMonthlyCents,
        previousAnnualCents: expectedAnnualCents,
        monthlyCents,
        annualCents,
        providerLinksCleared: changedPeriods
      }
    }, 2)
  ]);
  if (
    Number(results[0]?.meta?.changes ?? 0) !== 2
    || Number(results[1]?.meta?.changes ?? 0) !== 1
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_price_configuration_conflict" },
      { status: 409 }
    );
  }

  const updated = await loadPremiumPriceContext(request, env, showId);
  if (updated instanceof Response) return updated;
  return privateJson(request, env.ALLOWED_ORIGINS, {
    updated: true,
    idempotent: false,
    providerProvisioningRequired: true,
    ...presentPremiumPriceContext(env, updated)
  });
}

export function validatePremiumPricePair(
  monthlyCents: number,
  annualCents: number
): void {
  if (annualCents < monthlyCents) {
    throw new RequestValidationError(
      "annualCents must be at least monthlyCents",
      "show_price_annual_below_monthly"
    );
  }
  if (annualCents >= monthlyCents * 12) {
    throw new RequestValidationError(
      "annualCents must include a discount relative to twelve monthly payments",
      "show_price_annual_discount_required"
    );
  }
}

async function loadPremiumPriceContext(
  request: Request,
  env: PodcastEnv,
  showId: string
): Promise<PremiumPriceContext | Response> {
  const [show, prices, history] = await Promise.all([
    env.DB.prepare(
      `SELECT id, billing_mode
       FROM shows
       WHERE id = ?`
    ).bind(showId).first<ShowBillingRow>(),
    env.DB.prepare(
      `SELECT
         id, billing_period, amount_cents, currency,
         stripe_price_id, provider_mode, active
       FROM show_prices
       WHERE show_id = ?
       ORDER BY billing_period`
    ).bind(showId).all<PremiumPriceRow>(),
    env.DB.prepare(
      `SELECT
         (
           SELECT COUNT(*)
           FROM subscriptions
           WHERE show_id = ?
         ) AS subscription_count,
         (
           SELECT COUNT(*)
           FROM subscription_checkout_attempts
           WHERE show_id = ?
         ) AS checkout_attempt_count`
    ).bind(showId, showId).first<BillingHistoryRow>()
  ]);
  if (!show) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_not_found" },
      { status: 404 }
    );
  }
  const activeUsd = prices.results.filter((price) =>
    price.active === 1 && price.currency.toUpperCase() === "USD"
  );
  const monthly = activeUsd.find(({ billing_period }) =>
    billing_period === "month"
  );
  const annual = activeUsd.find(({ billing_period }) =>
    billing_period === "year"
  );
  if (!monthly || !annual || activeUsd.length !== 2) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "show_price_configuration_invalid" },
      { status: 409 }
    );
  }
  const expectedProviderMode = String(env.STRIPE_MODE) === "live"
    ? "live"
    : "test";
  const subscriptionCount = Number(history?.subscription_count ?? 0);
  const checkoutAttemptCount = Number(history?.checkout_attempt_count ?? 0);
  const blockers = [
    ...(isTruthy(env.SUBSCRIPTION_CHECKOUT_ENABLED)
      ? ["subscription_checkout_enabled"]
      : []),
    ...(subscriptionCount > 0 || checkoutAttemptCount > 0
      ? ["billing_history_exists"]
      : []),
    ...(
      monthly.provider_mode !== expectedProviderMode
      || annual.provider_mode !== expectedProviderMode
        ? ["price_provider_mode_mismatch"]
        : []
    )
  ];
  return {
    show,
    monthly,
    annual,
    expectedProviderMode,
    subscriptionCount,
    checkoutAttemptCount,
    blockers
  };
}

function presentPremiumPriceContext(
  env: PodcastEnv,
  context: PremiumPriceContext
): Record<string, unknown> {
  return {
    showId: context.show.id,
    currency: "USD",
    monthlyCents: context.monthly.amount_cents,
    annualCents: context.annual.amount_cents,
    providerMode: context.expectedProviderMode,
    providerReady: providerReady(context),
    providerProvisioningRequired: !providerReady(context),
    checkoutEnabled: isTruthy(env.SUBSCRIPTION_CHECKOUT_ENABLED),
    configurationLocked: context.blockers.length > 0,
    blockers: context.blockers,
    history: {
      subscriptions: context.subscriptionCount,
      checkoutAttempts: context.checkoutAttemptCount
    },
    confirmation: `CONFIGURE_SHOW_PRICES ${context.show.id}`
  };
}

function providerReady(context: PremiumPriceContext): boolean {
  return (
    context.show.billing_mode === context.expectedProviderMode
    && context.monthly.provider_mode === context.expectedProviderMode
    && context.annual.provider_mode === context.expectedProviderMode
    && Boolean(context.monthly.stripe_price_id)
    && Boolean(context.annual.stripe_price_id)
  );
}

function validPriceCents(value: unknown, field: string): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < MINIMUM_PRICE_CENTS
    || Number(value) > MAXIMUM_PRICE_CENTS
  ) {
    throw new RequestValidationError(
      `${field} must be a whole number of cents between `
      + `${MINIMUM_PRICE_CENTS} and ${MAXIMUM_PRICE_CENTS}`,
      "show_price_amount_invalid"
    );
  }
  return Number(value);
}
