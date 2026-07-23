# ADR 0001: Podcast runtime and source boundaries

- Status: Accepted
- Date: 2026-07-23

## Decision

Podcast is a separate Cloudflare Worker runtime with separate staging and
production bindings. D1 is canonical for show, episode, subscription, feed,
campaign, transcript, clip, and distribution state. R2 is canonical for
Podcast-owned masters and derivatives. Analytics Engine receives bounded raw
observations; D1/R2 hold reviewed aggregates and exports.

`dustwave.xyz` remains canonical for show and episode pages. Every episode maps
to one News page, and every show page exists even when it has zero episodes.
RSS and media availability do not depend on completion of a static-site build.

Pool remains canonical for Pool purchases and benefit eligibility. Store
remains canonical for Store orders and its tax implementation. Stripe remains
the payment/subscription provider, not the entitlement projection. YouTube is a
distribution target, not a canonical media store.

Shared mechanism is consumed from the pinned `shared/dust-wave-platform`
gitlink. Product data, bindings, credentials, cookies, sessions, and business
rules are never shared merely because source code is shared.

## Consequences

- A Podcast deploy cannot mutate Pool or Store storage.
- Provider events must be journaled and projected idempotently.
- News rebuild lag is visible but does not roll back an already-published feed.
- Private feed tokens are stored only as hashes and never appear in logs.
- Every cross-runtime integration needs an authenticated, replay-safe contract.

