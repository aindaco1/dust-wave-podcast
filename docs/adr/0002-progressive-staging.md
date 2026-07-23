# ADR 0002: Progressive staging and production promotion

- Status: Accepted
- Date: 2026-07-23

## Decision

Build and verify progressive staging slices behind explicit environment and
feature gates. Production promotion is a separate, evidence-backed decision.
Staging YouTube behavior is dry-run by default; the only live-channel exception
is a recently reauthenticated super-admin's tightly scoped, audited unlisted
smoke test.

Configuration declares every staging and production binding separately.
Secrets use local `.dev.vars` or Cloudflare secrets and never Wrangler vars or
repository configuration. Migrations are applied to local and staging first;
production migrations and routes are withheld until rollback, backup, auth, and
functional evidence pass.

## Current checkpoint

- Staging and production D1, R2, and Queue resources exist.
- Local D1 migrations `0001` through `0006` are applied.
- Staging D1 migrations `0001` through `0006` are applied after a verified SQL
  export; production D1 remains on its unmigrated baseline.
- Production D1 is not migrated.
- Both Worker environments pass tests, type checking, and Wrangler dry-run.
- The Podcast staging Worker is deployed only on its isolated `workers.dev`
  hostname with dry-run GitHub/YouTube modes. No permanent feed/media hostname
  or production route is attached.
- Public show, RSS, private R2 range delivery, passwordless admin, multipart
  upload, idempotent publication, and provider dry-run routes are implemented.
- An inactive Stripe test product and inactive monthly/annual test prices exist;
  their IDs are associated only with staging and checkout remains disabled.
- Two staging super-admin HMAC records exist. Fresh staging-only lookup/session
  secrets are configured; Resend and Turnstile still gate live email login.
- No live GitHub write, YouTube upload, directory submission, paid checkout, or
  production Podcast route exists.
- `feeds.dustwave.xyz` and `media.dustwave.xyz` are reserved in configuration,
  but neither DNS nor Worker Custom Domains are attached.
