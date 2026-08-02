PRAGMA foreign_keys = ON;

-- Retain only the test-mode refund identifier needed to resume provider
-- verification. PaymentIntent, card, customer, and address data stay at Stripe.
ALTER TABLE launch_lab_stripe_lifecycles
  ADD COLUMN provider_refund_id TEXT;

CREATE UNIQUE INDEX launch_lab_stripe_lifecycle_refund
  ON launch_lab_stripe_lifecycles(provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
