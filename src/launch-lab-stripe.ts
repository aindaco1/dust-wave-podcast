import type { PodcastEnv } from "./env";
import { recordLaunchLabObservations } from "./launch-lab-ledger";
import { createPodcastStripeClient } from "./stripe-client";

type ShowRow = {
  id: string;
  billing_mode: string;
  stripe_product_id: string | null;
};

type PriceRow = {
  id: string;
  show_id: string;
  billing_period: string;
  amount_cents: number;
  currency: string;
  stripe_price_id: string | null;
  stripe_lookup_key: string | null;
  tax_behavior: string;
  provider_mode: string;
  stripe_product_id: string | null;
};

type StripeObject = Record<string, unknown> & {
  id?: string;
  livemode?: boolean;
  active?: boolean;
  currency?: string;
  unit_amount?: number;
  tax_behavior?: string;
  lookup_key?: string;
  product?: string;
  recurring?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export async function runLaunchLabStripeReadiness(
  env: PodcastEnv,
  runId: string
): Promise<void> {
  const [showsResult, pricesResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, billing_mode, stripe_product_id
       FROM shows
       WHERE premium_enabled = 1
         AND status != 'archived'
         AND test_fixture = 0
       ORDER BY id`
    ).all<ShowRow>(),
    env.DB.prepare(
      `SELECT
         price.id, price.show_id, price.billing_period, price.amount_cents,
         price.currency, price.stripe_price_id, price.stripe_lookup_key,
         price.tax_behavior, price.provider_mode, show_record.stripe_product_id
       FROM show_prices price
       JOIN shows show_record ON show_record.id = price.show_id
       WHERE price.active = 1
         AND show_record.test_fixture = 0
       ORDER BY price.show_id, price.billing_period`
    ).all<PriceRow>()
  ]);
  const shows = showsResult.results;
  const prices = pricesResult.results;
  if (
    String(env.STRIPE_MODE) !== "test"
    || !env.STRIPE_SECRET_KEY
    || shows.length < 1
    || prices.length < 2
    || shows.some((show) =>
      show.billing_mode !== "test" || !validStripeObjectId(show.stripe_product_id)
    )
    || prices.some((price) =>
      price.provider_mode !== "test"
      || !validStripeObjectId(price.stripe_price_id)
    )
  ) {
    await recordStripeObservations(env.DB, runId, false, false, "stripe_config_mismatch");
    return;
  }

  try {
    const stripe = createPodcastStripeClient(env);
    const [products, providerPrices] = await Promise.all([
      Promise.all(shows.map((show) =>
        stripe.products.retrieve(show.stripe_product_id as string)
      )) as Promise<StripeObject[]>,
      Promise.all(prices.map((price) =>
        stripe.prices.retrieve(price.stripe_price_id as string)
      )) as Promise<StripeObject[]>
    ]);
    const testModeVerified = [...products, ...providerPrices].every(
      (object) => object.livemode === false
    );
    const productsById = new Map(products.map((product) => [product.id, product]));
    const pricesById = new Map(providerPrices.map((price) => [price.id, price]));
    const contractVerified = shows.every((show) => {
      const product = productsById.get(show.stripe_product_id ?? "");
      return product?.active === false
        && product.metadata?.show_id === show.id
        && product.metadata?.platform === "dust_wave_podcast";
    }) && prices.every((price) => {
      const provider = pricesById.get(price.stripe_price_id ?? "");
      const recurring = provider?.recurring;
      return provider?.active === false
        && provider.currency === price.currency.toLowerCase()
        && provider.unit_amount === price.amount_cents
        && provider.tax_behavior === price.tax_behavior
        && provider.lookup_key === price.stripe_lookup_key
        && provider.product === price.stripe_product_id
        && recurring?.interval === (
          price.billing_period === "year" ? "year" : "month"
        )
        && recurring?.interval_count === 1
        && recurring?.trial_period_days === null
        && provider.metadata?.show_id === price.show_id
        && provider.metadata?.billing_period === price.billing_period;
    });
    await recordStripeObservations(
      env.DB,
      runId,
      testModeVerified,
      contractVerified,
      "stripe_contract_mismatch"
    );
  } catch {
    await recordStripeObservations(
      env.DB,
      runId,
      false,
      false,
      "stripe_api_unavailable"
    );
  }
}

async function recordStripeObservations(
  db: D1Database,
  runId: string,
  testModeVerified: boolean,
  contractVerified: boolean,
  failureCode: string
): Promise<void> {
  await recordLaunchLabObservations(db, runId, [
    {
      provider: "stripe",
      scenario: "api_test_mode",
      observedStatus: testModeVerified ? "verified" : "mismatch",
      failureCode: testModeVerified ? null : failureCode
    },
    {
      provider: "stripe",
      scenario: "product_price_contract",
      observedStatus: contractVerified ? "verified" : "mismatch",
      failureCode: contractVerified ? null : failureCode
    }
  ]);
}

function validStripeObjectId(value: string | null): value is string {
  return /^[A-Za-z]+_[A-Za-z0-9_]{6,128}$/.test(String(value ?? ""));
}
