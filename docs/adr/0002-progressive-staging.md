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
- Local and staging D1 migrations `0001` through `0003` are applied.
- Production D1 is not migrated.
- Both Worker environments pass Wrangler dry-run.
- No Podcast Worker is deployed.
- No public route, feed, Stripe product, or YouTube action exists yet.
- `feeds.dustwave.xyz` and `media.dustwave.xyz` are reserved in configuration,
  but neither DNS nor Worker Custom Domains are attached.
