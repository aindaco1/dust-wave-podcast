# Staging runbook

This runbook applies only to `dust-wave-podcast-staging`. Production D1, R2,
Queue, DNS, routes, and provider modes remain untouched until an explicit
promotion decision.

## 1. Verify source

```sh
git status --short
git submodule status
npm ci
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
```

The production dry run validates packaging only. It is not authorization to
deploy production.

## 2. Back up and migrate staging

```sh
wrangler d1 export DB --remote --env staging --output /absolute/backup/path.sql
npm run db:migrate:staging
wrangler d1 migrations list DB --remote --env staging
```

Retain the export outside the repository and record its path in the private
release evidence. Apply migrations to a fresh local database as a second
forward-migration check.

## 3. Configure non-secret test state

- Associate the inactive Stripe test product and inactive $5/month and
  $50/year prices with Ópera en la Selva.
- Keep `billing_mode=test`, checkout disabled, manual tax assignments empty,
  and all provider prices inactive.
- Seed at least two super-admin lookup HMACs using one newly generated staging
  pepper. Do not store raw email addresses in D1 or the repository.
- Confirm eleven directory rows exist with truthful owner-setup states.

## 4. Configure staging secrets

Required for login:

- `ADMIN_EMAIL_LOOKUP_PEPPER`
- `ADMIN_SESSION_SECRET`
- `RESEND_API_KEY`
- `TURNSTILE_SECRET_KEY`

Required for later provider tests:

- `GITHUB_TOKEN`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- YouTube OAuth client, secret, and refresh token

Required for the isolated ad-plan processor:

- Worker secret `MEDIA_PROCESSOR_CALLBACK_SECRET`
- Podcast GitHub secret `MEDIA_PROCESSOR_CALLBACK_SECRET` with the same
  staging-only value
- Podcast GitHub secrets `CLOUDFLARE_ACCOUNT_ID` and a dedicated
  `CLOUDFLARE_API_TOKEN` limited to the staging media bucket

Do not copy Pool/Store GitHub secret values; GitHub and Cloudflare intentionally
do not expose them. Create a new least-privilege Podcast processor token.

Required for the isolated signed-decision exercise:

- Worker secret `AD_DECISION_SIGNING_SECRET`
- Worker secret `AD_QUALIFICATION_CALLBACK_SECRET`
- optional overlap secret `AD_DECISION_SIGNING_SECRET_PREVIOUS` during rotation
- staging variable `AD_DECISION_MODE=staging_validate`

Production must keep `AD_DECISION_MODE=disabled` and must not receive that
staging secret. Issuance is authenticated/CSRF-protected; its returned URL is
short-lived and is not an episode enclosure.

Rotate by installing the old current value as `..._PREVIOUS`, installing a new
current value, confirming old and new fixture URLs, waiting at least the
two-hour decision lifetime, and then deleting the previous secret.

Rotate the independent qualification callback secret only after stopping its
trusted observer, install the new value on both sides, then restart and verify
an idempotent retry. Durable one-per-slot identity prevents a rotation retry
from creating a second qualification.

Required only while the synthetic real-client audio matrix is active:

- `VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN`

Supply that token to `npm run matrix:virtual-audio` through the environment,
never a command argument. The generated JSON redacts the fixture path and
labels header-level app probes as protocol emulation rather than native-client
evidence.

Use the same environment-only token with `npm run load:virtual-audio` after
uploading the generated `virtual-midroll.mp3` baseline. The default 5,000
paired cases produce 10,000 measured requests across identical virtual and
preassembled bytes. Remove all four objects and the diagnostic secret
immediately after saving the redacted evidence.

Use least-privilege staging credentials. Cloudflare does not expose existing
secret values, so rotate or enter them rather than attempting to copy them from
Pool or Store.

The verified `dustwave.xyz` Resend domain may be reused, but Podcast requires
its own domain-restricted sending key. Do not reuse the existing Pool or Store
key. The same separation applies to the Turnstile widget secret. Public
Turnstile test keys are not acceptable on the Internet-accessible staging
Worker.

## 5. Deploy and smoke test

```sh
wrangler deploy --env staging
```

Verify:

- `/health`, `/v1/shows`, the configured show, and an empty valid RSS feed;
- unauthenticated admin routes return private `401` responses;
- unknown login emails receive the same response as known emails;
- a known super-admin completes Turnstile, Resend, exchange, session, and
  logout;
- a small staged audio upload completes, serves a byte range, and downloads;
- publishing a fixture episode twice returns the same revision;
- News and YouTube jobs report `dry-run`;
- the canonical website remains unchanged;
- Stripe rejects unsigned and wrong-mode events.
- unsigned ad-plan processor callbacks return `401` before D1 lookup; a
  reviewed fixture workflow produces private frame-aligned segments, moves the
  plan only to `needs_review`, and requires an authenticated producer approval.
- bad ad-decision signatures return `401` before D1 lookup; repeated issuance
  in one decision epoch returns the same manifest/ETag; changed R2 evidence is
  rejected before headers; duplicate/capped qualifications do not increment a
  campaign counter.
- a decision whose ad object is unavailable before its first response commits
  the snapshotted full-file fallback before headers; restoring the ad object
  does not switch that signed URL back to primary, and mutating a committed
  primary fails closed rather than switching mid-download.
- each issued decision reports its recomputed primary/fallback byte contract;
  exact house coverage reports `fallbackType: house_fill` and
  `deliveryLengthReady: true`; incomplete coverage uses the unequal
  `full_file` diagnostic with `deliveryLengthReady: false`; a tampered or
  missing contract fails before delivery.
- bad qualification callback signatures return `401` before D1 lookup; one
  signed full-creative completion is idempotent across secret rotation; the
  analyst reconciliation report is show-scoped, bounded, and returns zero
  counter-to-row differences.

Current isolated staging runtime:
`https://dust-wave-podcast-staging.jogo.workers.dev`. This address is for
engineering evidence only and is not the permanent public feed or media origin.

Do not attach `feeds.dustwave.xyz` or `media.dustwave.xyz` during this step.

## 6. Controlled external tests

Live GitHub publication targets only the release branch and requires a reviewed
fixture. A YouTube test requires a recently authenticated super-admin,
explicitly enabled live mode, and an unlisted item on the production channel.
Record the provider ID, audit event, cleanup result, and mode restoration.

## 7. Rollback

- Restore dry-run provider variables first.
- Roll back Worker code to the last verified deployment.
- Pause Queue consumers if jobs are unsafe; retain messages and D1 audit state.
- Restore D1 only when forward repair is unsafe and the backup is verified.
- Abort orphaned multipart uploads and remove fixture objects after their
  evidence is captured.
- Do not delete a public GUID, enclosure identity, or directory feed. Correct
  metadata in a new publication revision.
