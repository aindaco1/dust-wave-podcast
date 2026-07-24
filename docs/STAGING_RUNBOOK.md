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

Required only while the synthetic real-client audio matrix is active:

- `VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN`

Use least-privilege staging credentials. Cloudflare does not expose existing
secret values, so rotate or enter them rather than attempting to copy them from
Pool or Store.

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
