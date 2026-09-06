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

## Operational evidence

Current deployment, schema, and readiness evidence belongs in
[CURRENT_STATE.md](../CURRENT_STATE.md). The July 2026 bootstrap checkpoint is
retained in Git history and must not be treated as the current environment.
This ADR owns the promotion decision, not a live migration inventory.
