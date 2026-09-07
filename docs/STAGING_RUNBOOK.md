# Staging runbook

This runbook applies only to `dust-wave-podcast-staging`. Production D1, R2,
Queue, DNS, routes, and provider modes remain untouched until an explicit
promotion decision.

Use Node 22 for CI parity. [CURRENT_STATE.md](CURRENT_STATE.md) owns the dated
deployment/readiness snapshot; this runbook owns the staging deployment sequence.
Migration validation applies to a fresh/disposable database or an identified
unapplied migration, never to reapplying or editing an existing migration.
Reconcile current state before seeding defaults, creating provider objects, or
rotating credentials.

Audience: operators preparing or recovering a staging deployment.

| Need | Procedure |
|---|---|
| Verify, configure, deploy, and roll back staging | Follow steps 1–7 below |
| Validate a schema change | [Migration validation](MIGRATION_VALIDATION.md) |
| Exercise affected product and provider behavior | [Staging acceptance](STAGING_ACCEPTANCE.md) |
| Refresh isolated provider-contract evidence | [Launch Lab runbook](LAUNCH_LAB_RUNBOOK.md) |
| Interpret platform versus launch readiness | [Prelaunch readiness](PRELAUNCH_READINESS.md) |

## 1. Verify source

```sh
git status --short
git submodule status
npm ci
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
npm run gate:public:staging
```

The production dry run validates packaging only. It is not authorization to
deploy production. `gate:public:staging` is a read-only live canary for the
canonical RSS and feed artwork. `gate:public:production` is also a read-only
audit; always run it after an
authorized production migration or deployment. A passing public gate does not
authorize a production mutation.

Run the focused timestamp contract whenever release, entitlement, tax, or
publication scheduling SQL changes:

```sh
npx vitest run tests/sql-time-boundaries.test.mjs tests/jobs.test.ts \
  tests/feed-media.test.ts tests/tax-quotes.test.ts
```

The contract must show that same-day RFC 3339 past/present rows are due,
future rows remain closed, raw SQLite clocks are absent from canonical
external-time predicates, and the composite due-time index is still selected.

Confirm invocation logs and automatic traces remain disabled because private
feed bearer values are path-scoped. Queue failures must emit the bounded
structured `job_failed` event before retrying; never log a job payload or
private URL. Add automatic tracing only after a redacting Tail Worker or
token-free route passes an independent security gate.

Processor transport is automated through the signed pull boundary documented
in [`PROCESSOR_DISPATCH_AUTOMATION.md`](PROCESSOR_DISPATCH_AUTOMATION.md).
Before enabling its scheduled workflow, run its focused tests and confirm
production keeps `PROCESSOR_DISPATCH_MODE=disabled`.

The staging job consumer sends a message to
`dust-wave-podcast-jobs-staging-dlq` only after its three ordinary delivery
retries are exhausted. A second consumer on the same staging Worker writes one
content-free, digest-deduplicated incident to D1, then acknowledges the
message. It has no producer binding and never replays a job or calls a
provider. Temporary D1 failures retry every five minutes with a bounded retry
ceiling. Confirm the DLQ exists and run the focused verification in
[`QUEUE_FAILURE_AUTOMATION.md`](QUEUE_FAILURE_AUTOMATION.md) before deploying
staging. Production queue changes require an independent promotion and recovery
review;
verify its actual migration state instead of assuming a bootstrap baseline.

Before deploying the staging Worker, resolve its configured `GITHUB_REF` through
the website repository's GitHub commits API. Staging uses an immutable reviewed
website commit while `GITHUB_PUBLISH_MODE=dry_run`; Git branch listings alone do
not validate a commit pin. Derive the ref from `wrangler.jsonc`, confirm the
commit and `src/_data/podcastShows.json` are readable at that exact ref, and
validate the catalog/News preview contracts. A missing target must leave the
preview unavailable and must never fall back to the repository default branch.
Any future staging write mode needs a separately reviewed writable branch.
Production remains pinned to `main` with its current guarded publication mode.

## 2. Back up and migrate staging

```sh
wrangler d1 export DB --remote --env staging --output /absolute/backup/path.sql
npm run db:migrate:staging
wrangler d1 migrations list DB --remote --env staging
```

Retain the export outside the repository and record its path in the private
release evidence. Apply migrations to a fresh local database as a second
forward-migration check.

If the D1 export endpoint is temporarily unavailable, do not silently skip
recovery evidence. Confirm read-only D1 access and clean foreign keys, then
capture an exact pre-migration Time Travel bookmark with
`wrangler d1 time-travel info DB --env staging --json`. Proceed only when that
bookmark is returned and the migration is additive/reversible through Time
Travel; record the export failure and bookmark privately. Never substitute a
production bookmark or apply the migration to production.

Select the applicable [migration checks](MIGRATION_VALIDATION.md) before
applying an identified pending migration. Record the applied list and integrity
results afterward. That guide also owns migration-specific rollback constraints;
the ordered SQL files remain the schema source of truth.

## 3. Configure non-secret test state

These are bootstrap constraints for a new isolated environment, not instructions
to reset the existing staging system:

- Keep `billing_mode=test`, `SUBSCRIPTION_CHECKOUT_ENABLED=false`, and provider
  publication modes guarded. Reconcile existing test catalog and tax assignments
  with the Stripe gate; do not recreate archived launch-show objects or clear
  already-approved evidence. The reusable Launch Lab catalog is separate.
- Maintain at least two authorized super-admin lookup HMACs. Never reseed an
  existing environment with a new pepper without its explicit rotation procedure.
- Verify distribution rows against the current registry with truthful owner
  states; do not hard-code a second destination inventory.
- Keep `CLIP_PUBLICATION_MODE=staging_preview` in isolated staging and
  `CLIP_PUBLICATION_MODE=disabled` in production.

## 4. Configure staging secrets

Required for login:

- `ADMIN_EMAIL_LOOKUP_PEPPER`
- `ADMIN_SESSION_SECRET`
- `LISTENER_EMAIL_LOOKUP_PEPPER`
- `LISTENER_SESSION_SECRET`
- `RESEND_API_KEY`
- `TURNSTILE_SECRET_KEY`

Required for private feeds:

- `FEED_TOKEN_PEPPER`

Required for announcement consent and dry-run delivery:

- `ANNOUNCEMENT_DESTINATION_SECRET`
- `ANNOUNCEMENT_DELIVERY_MODE=dry_run`

Required only for the isolated RSS private-copy boundary:

- a newly generated Podcast-only `RSS_IMPORT_URL_SECRET`
- `RSS_IMPORT_EXECUTION_MODE=staging_copy`

Keep production `RSS_IMPORT_EXECUTION_MODE=disabled`. Do not reuse a Pool,
Store, session, feed-token, Stripe, Resend, processor, or provider secret.
Wrangler can confirm only the staging secret name; never print or attempt to
read the value.

Required only for a controlled live announcement test:

- `RESEND_WEBHOOK_SECRET`
- `ANNOUNCEMENT_DELIVERY_MODE=live` during the bounded test window

Admin and listener peppers/session secrets must be independently generated.
The feed-token pepper and announcement destination secret must also be
independent. Replacing the feed pepper invalidates every issued private URL;
replacing the destination secret makes existing sealed addresses unavailable
for new sends. Rotate either only during a planned reissue/re-consent window or
an incident; normal listener URL replacement uses the rotate endpoint.
The Resend and Turnstile provider credentials may be shared by the Podcast
runtime, but listener and admin requests use distinct idempotency namespaces
and Turnstile actions.

### Provider credentials

Required for later provider tests:

- `GITHUB_TOKEN`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- non-secret `STRIPE_PORTAL_CONFIGURATION_ID` for the committed Podcast-only
  staging profile
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`
- `YOUTUBE_CHANNEL_ID`

Do not install the YouTube values for an ordinary dry run. They are required
only during the bounded controlled-test window and must resolve to the same
channel represented by the selected show's `youtube_channel_url` and the
committed `YOUTUBE_CHANNEL_URL`.

Required for subscription Checkout:

- `TAX_QUOTE_HASH_SECRET`
- the listener email-HMAC and Turnstile secrets listed above
- `CHECKOUT_TURNSTILE_REQUIRED=true`
- `SUBSCRIPTION_CHECKOUT_ENABLED=false` until the controlled test window

The Portal profile must allow only the approved Podcast subscription
self-service actions and must not allow customer-address/rate changes until
renewal-time Store-tax re-evaluation is implemented. Never reuse a Store order
or Pool pledge Portal configuration implicitly.

Required for the Pool supporter-benefit bridge:

- a newly generated `POOL_PODCAST_BRIDGE_SECRET`, installed independently in
  the Pool and Podcast staging runtimes;
- a Podcast-only `POOL_REDEMPTION_CODE_PEPPER`;
- the listener email-HMAC pepper listed above;
- `POOL_REDEMPTION_ENABLED=false` until the controlled bridge test.

Do not reuse a Stripe webhook secret, listener/admin session secret, or an
existing Pool/Store signing key.

### Processor credentials

Required for the isolated ad-plan processor:

- Worker secret `MEDIA_PROCESSOR_CALLBACK_SECRET`
- Podcast GitHub secret `MEDIA_PROCESSOR_CALLBACK_SECRET` with the same
  staging-only value
- Podcast GitHub secrets `CLOUDFLARE_ACCOUNT_ID` and a dedicated
  `CLOUDFLARE_API_TOKEN` limited to the staging media bucket

Do not copy Pool/Store GitHub secret values; GitHub and Cloudflare intentionally
do not expose them. Create a new least-privilege Podcast processor token.

Required for the isolated clip-render processor:

- Worker secret `MEDIA_PROCESSOR_CALLBACK_SECRET`
- Podcast `podcast-staging` GitHub environment secret
  `MEDIA_PROCESSOR_CALLBACK_SECRET` with the same staging-only value

Clip execution and output checks are in
[private clip rendering](STAGING_ACCEPTANCE.md#private-clip-rendering).

### Ad decision credentials and rotation

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

The [virtual-audio exercise](STAGING_ACCEPTANCE.md#virtual-audio-evidence)
owns diagnostic leases, signed gate execution, and exact fixture cleanup.

### Resend and Turnstile setup

The verified `dustwave.xyz` Resend domain may be reused, but Podcast requires
its own domain-restricted sending key. Do not reuse the existing Pool or Store
key. The same separation applies to the Turnstile widget secret. Public
Turnstile test keys are not acceptable on the Internet-accessible staging
Worker.

Create the dedicated real staging widget only after Wrangler's OAuth grant
includes `challenge-widgets.write`. The locked Wrangler 4.115.0 exposes this
boundary directly, so there is no need to reuse a Pool/Store widget or paste
the secret through the dashboard:

```sh
umask 077
TURNSTILE_RESULT="$(mktemp -t dust-wave-podcast-turnstile.XXXXXX)"
npx wrangler turnstile widget create "Dust Wave Podcasts staging" \
  --domain dust-wave-website-staging.pages.dev \
  --mode managed \
  --clearance-level no_clearance \
  --region world \
  --json > "$TURNSTILE_RESULT"
jq -e '.sitekey | type == "string" and length > 0' "$TURNSTILE_RESULT" >/dev/null
jq -e '.secret | type == "string" and length > 0' "$TURNSTILE_RESULT" >/dev/null
jq -r '.secret' "$TURNSTILE_RESULT" |
  npx wrangler secret put TURNSTILE_SECRET_KEY --env staging
jq -r '.sitekey' "$TURNSTILE_RESULT"
rm -f -- "$TURNSTILE_RESULT"
unset TURNSTILE_RESULT
```

The final `jq` output is the public site key for the isolated website staging
build. While the owner-approved staging-admin bypass is active, put it in
`PODCAST_MEMBER_TURNSTILE_SITE_KEY` and
`PODCAST_CHECKOUT_TURNSTILE_SITE_KEY`, but leave
`PODCAST_ADMIN_TURNSTILE_SITE_KEY` empty. Do not put the secret in a command
argument, environment file, GitHub variable, source file, shell history, or
build artifact. Use a separate Checkout widget/site key when Checkout
activation begins so its action and hostname policy can change independently.

If widget creation or either JSON assertion fails, keep login closed, delete
only the exact temporary file created above, and inspect `wrangler whoami`.
Never fall back to Cloudflare's public dummy key on the deployed Pages/Worker
origins. After installation, `wrangler secret list --env staging` may confirm
the secret name only; it must not be readable.

Validate a new Resend key against Resend's designated delivered-test address
before installing it, using a hidden environment or interactive prompt rather
than a command argument. The Worker records only a closed delivery failure
code and numeric provider status; it never logs the provider response body,
destination, login URL, or exception text. Staging administrator login may
skip the widget only under the exact committed
`ENVIRONMENT=staging`/`ADMIN_TURNSTILE_REQUIRED=false` pair. It still requires
the exact staging origin, dual rate-limit buckets, a registered administrator,
and a single-use Resend link. Production ignores that bypass, and listener and
Checkout Turnstile remain required. A dummy Turnstile pair is suitable for
local/automated tests only, not the public `workers.dev` deployment.

## 5. Deploy and smoke test

```sh
wrangler deploy --env staging
```

Run the [smoke checklist](STAGING_ACCEPTANCE.md#smoke-checklist) and the
acceptance sections affected by this release. Use the documented isolated fixtures
and mode boundaries for each exercise; preserve their evidence and cleanup steps.
Record the exact source/deployment and bounded results in the dated current-state
report after verification.

Current isolated staging runtime:
`https://dust-wave-podcast-staging.jogo.workers.dev`. This address is for
engineering evidence only and is not the permanent public feed or media origin.
The staging `FEED_ORIGIN` and `MEDIA_ORIGIN` intentionally use this hostname so
copied staging feed/enclosure URLs remain testable without production DNS.

Do not attach `feeds.dustwave.xyz` or `media.dustwave.xyz` during this step.

### Private fixture and transport checks

The existing Dust Don't Settle source-test episode is private and marked
`Do not publish`. Its historical QC, enhancement, transcript, and upload diary
remains in Git history. Read current gate evidence rather than repeating old
approval or processing steps. It must never become public RSS, News, directory,
or YouTube evidence; use separate rights-cleared publishable content.

Resolve the existing private pointer without duplicating its identifier:

```sh
LAUNCH_EPISODE_ID="$(gh variable get PODCAST_LAUNCH_EPISODE_ID --env podcast-staging)"
npm run gate:episode:staging -- "$LAUNCH_EPISODE_ID"
```

Preserve the shared multipart transport's HTTP/1.1 upload, disabled
`Expect: 100-continue`, bounded retries, checksum verification, and post-write R2
`head`. Reconcile the exact immutable job and uploaded parts after a transport
failure; a completed upload is not human approval or publication evidence.

### Public clip withdrawal and canonical-page gate

The procedure is in [staging acceptance](STAGING_ACCEPTANCE.md#public-clip-withdrawal-and-canonical-page-gate).

## 6. Controlled external tests

Before a publishable episode exists, run the content-independent prelaunch
report against the private launch episode:

```sh
npm run gate:prelaunch:staging -- EPISODE_ID
```

This report preserves the strict launch result while separately proving
`platformReady`. It adds the current private golden canary and turns only the
directory-ingestion, controlled YouTube-publication, and real-client dynamic-ad
blocks into explicit `DEFER` results. See
[`PRELAUNCH_READINESS.md`](PRELAUNCH_READINESS.md) for the exact boundary and
first-content activation sequence. Use `--require-ready` here only to enforce
platform readiness; content deferrals remain visible and `launchReady` remains
false.

Before promoting any external boundary, run the strict composed read-only
launch report against the same episode:

```sh
npm run gate:launch:staging -- EPISODE_ID
```

The report reuses the episode and Stripe evaluators and adds exact staging and
production kill-switch posture, installed secret names, current RSS/directory
certification, controlled YouTube and Resend records, durable dynamic-ad pilot
records, and D1 referential integrity. It returns only counts and bounded
status; it never returns caption text, object keys, hashes, URLs, provider
identifiers, recipient identity, or secret values. `BLOCK` is expected while
human/provider evidence remains outstanding. Use `--require-ready` only as the
final promotion check; do not change data merely to make that mode exit zero.
The report uses the newest signed `virtual_audio_gate_runs` row by default.
Pass a successful gate artifact with
`--virtual-audio-evidence=/absolute/path/staging-gate.json` to bind the
dynamic-ad node to an independently retained run instead. Evidence is accepted
only for the signed 5,000-pair/10,000-request exercise, full cleanup, a
seven-day freshness window, and no relevant source drift.

The Resend node keeps listener and provider evidence separate. It requires one
real live announcement whose signed provider transition reached `delivered`,
a later withdrawal of that same listener/show preference, zero failed live
deliveries, and one passed `suppressed@resend.dev` Launch Lab scenario completed
within seven days with no relevant Resend adapter, webhook, shared verifier,
matrix, or workflow drift. A listener-side `suppressed` delivery cannot replace
the provider rehearsal, and a Launch Lab delivery cannot replace listener
consent or withdrawal.

Select the applicable controlled exercise:

- [RSS import and manual cutover](STAGING_ACCEPTANCE.md#rss-import-and-manual-cutover)
- [Billing and Pool](STAGING_ACCEPTANCE.md#billing-and-pool)
- [Public clips, virtual audio, and direct sponsors](STAGING_ACCEPTANCE.md#media-pipeline)
- [GitHub and YouTube](STAGING_ACCEPTANCE.md#external-publication)
- [Isolated Launch Lab rehearsals](LAUNCH_LAB_RUNBOOK.md)

Those procedures retain their exact review, provider-mode, reconciliation, and
cleanup requirements. For first publishable content, follow
[first-content activation](PRELAUNCH_READINESS.md#first-content-activation).

## 7. Rollback

- Restore dry-run provider variables first.
- Roll back Worker code to the last verified deployment.
- Pause Queue consumers if jobs are unsafe; retain messages and D1 audit state.
- Restore D1 only when forward repair is unsafe and the backup is verified.
- Abort orphaned multipart uploads and remove fixture objects after their
  evidence is captured.
- Do not delete a public GUID, enclosure identity, or directory feed. Correct
  metadata in a new publication revision.

Follow the [migration-specific rollback constraints](MIGRATION_VALIDATION.md#rollback-constraints)
for the affected schema. Preserve additive evidence tables, immutable public
identity, and the reviewed recovery state.

## Automated Launch Lab rehearsal

The procedure is in the [Launch Lab runbook](LAUNCH_LAB_RUNBOOK.md). It covers
existing-environment checks, protected workflows, provider reconciliation,
hosted Checkout, cleanup, and evidence acceptance.
