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

If the D1 export endpoint is temporarily unavailable, do not silently skip
recovery evidence. Confirm read-only D1 access and clean foreign keys, then
capture an exact pre-migration Time Travel bookmark with
`wrangler d1 time-travel info DB --env staging --json`. Proceed only when that
bookmark is returned and the migration is additive/reversible through Time
Travel; record the export failure and bookmark privately. Never substitute a
production bookmark or apply the migration to production.

For migration `0026`, verify the fresh and restored databases contain
`show_notification_preferences`, its listener/show primary key, and the
`show_notification_preferences_eligible` partial index. Before and after the
remote apply, record only
aggregate row counts and `PRAGMA foreign_key_check`; do not export listener
identifiers into shared release evidence.

For migration `0027`, verify `show_distribution_destinations` contains one row
per show/directory pair, the show/setup index exists, and foreign-key checks are
empty. Keep every owner state `not_started` until an authorized operator
actually completes that platform's one-time setup; do not mark a directory
`verified` merely because its submission page or RSS feed is reachable.

For migration `0028`, verify `distribution_jobs.publication_revision` exists,
the episode/revision/destination index is present, every existing job received
its episode's current revision, and foreign-key checks remain empty. Exercise
the scheduler with a later episode revision and confirm it still enqueues the
revision stored on each durable job.

For release recovery, use only a current-revision failed fixture. Confirm an
Analyst cannot retry it, a Producer/Admin/Super-admin requires same-origin CSRF,
two concurrent requests create one conditional audit/mutation and at most one
immediate send, and queued/running retries are idempotent. Confirm a stale
revision and succeeded/canceled job return `409`. For News, only the matching
`site_publications` revision may reset to `queued`. A simulated Queue-send
failure must leave the durable row queued for Cron, and a 15-minute stale
`running` fixture must be reclaimed without allowing two processors to own it.
Migration `0029` must add the partial `distribution_jobs_running_lease` index;
verify its predicate is `status = 'running'` and foreign-key checks stay empty.

For migration `0030`, verify the three nullable directory-evidence columns,
their constrained source values, the admin-user foreign key, and clean
foreign-key checks. With an isolated current-revision fixture, confirm Analyst
is read-only; Producer+ requires same-origin CSRF; `observed` rejects missing or
unsafe evidence URLs; `failed` rejects an empty detail; stale revisions and
incomplete owner setup return `409`; and replaying identical evidence is
idempotent. Never mark ingestion observed merely because the canonical feed or
directory submission page is reachable.

For migration `0031`, verify the four nullable owner-checklist columns and their
length/date constraints. Exercise an Admin/Super-admin update with a harmless
account label, ISO date, HTTPS receipt/dashboard URL, and non-secret note;
confirm Analysts/Producers cannot mutate it, foreign keys stay clean, and audit
metadata contains only presence booleans. Reject URL credentials/fragments,
invalid calendar dates, multiline account labels, control characters, unknown
fields, passwords, and verification codes. Do not fabricate a provider
submission merely to exercise staging.

For migration `0032`, verify `episode_chapters` gained `chapter_key` and `toc`,
the four `episode_chapter_*` review/history tables and indexes exist, any
legacy rows have a revision-zero `episode_chapter_sets` header, and foreign-key
checks stay empty. With an isolated fixture, confirm Producer+ writes require
same-origin CSRF and advance one base revision once; Admin+ approval binds the
exact revision; a newer draft leaves the prior immutable approval readable.
Reject nonzero first markers, duplicate/out-of-order or out-of-duration starts,
all-silent documents, unsafe title controls/markup, and non-HTTPS or
credentialed URLs.

For migration `0033`, verify the three `production_review*` tables, four
episode/readiness/comment/blocker indexes, range/resolution checks, assignment
foreign keys, and replay-uniqueness constraints. With an isolated ready-audio
fixture and scoped Admin session, create one timed bilingual blocker, replay
its `commentId`, resolve/reopen it, move its exact target through
`ready_for_review` and Admin approval, and replay each mutation. Change the
fixture ETag/revision before approval and confirm stale approval is `409`.
Confirm readiness counts only current targets, publish enforcement remains
false, comment text never enters audit metadata, unauthorized/CSRF-cross-origin
writes fail before mutation, and foreign keys remain clean.

For migration `0034`, verify the episode evidence column; show/global evidence
epoch tables; private override table/index; empty checked batch-guard table;
and all episode dependency triggers. Confirm one episode dependency increments
only its episode epoch, show metadata/setup increments only its show epoch, and
a global directory edit increments only the global epoch. Replay migrations
from zero and keep `PRAGMA foreign_key_check` empty.

For migration `0035`, verify one default `show_audio_qc_policies` row per show,
the new-show seed trigger, all three run indexes (including one-active-source-
policy uniqueness), strict policy bounds, and the queued/running/succeeded/
failed state checks. Replay from zero and keep foreign keys clean. Staging
should still have zero QC runs until a real rights-cleared source exists.

For migration `0036`, verify one revision-zero
`episode_working_master_states` row per episode, the new-episode seed and
state-reference triggers, immutable master history/uniqueness, all preview
state checks/indexes, and clean foreign keys. In an isolated fixture, approve
revision one, approve a different revision-two QC snapshot, and confirm
current transcript/chapter approvals clear, clips return to draft, authored
rows remain, and the publication evidence epoch advances. A missing or
cross-episode master pointer must abort.

For migration `0037`, verify the explicit episode source-language column,
one pinned `show_transcription_settings` row per show, the new-show trigger,
both transcription-job indexes, working-master staleness, and zero jobs before
an owner-controlled source exists. For migration `0038`, verify the
chunk-run/chunk tables, both indexes, job-to-run staleness trigger, 16 MiB
per-chunk cap, exact core/media/encoded-duration bounds, and clean foreign
keys. Replay both from zero.

After this workflow is present on a dispatchable branch, queue the current
source from Production and run:

```sh
gh workflow run process-audio-qc.yml \
  --ref release/0.1.0 \
  -f run_id="qc_REPLACE_WITH_QUEUED_ID"
```

Before claiming evidence, confirm the workflow fetched the exact private
manifest/source through signed Worker routes, fully decoded the source,
retained only `callback.json`, and returned a report whose source, manifest,
and report hashes match D1. Refresh Production and verify bounded findings,
policy revision, and resource/version evidence. Change the current source ETag
or policy revision and confirm a new run is required. Never upload a fabricated
episode to shared staging merely to make this path green.

If the approved working master is larger than 16 MiB, queue transcription,
copy the displayed chunk run ID, and dispatch:

```sh
gh workflow run process-transcription-chunks.yml \
  --ref agent/launch-configuration \
  -f run_id="transcription_chunks_REPLACE_WITH_QUEUED_ID"
```

Confirm the run used the exact signed manifest/source, retained no source or
chunk audio artifact, selected the closest safe silence or documented
deterministic duration fallback, and uploaded only checksum-verified chunks.
Refresh the workbench and verify the run becomes ready before Workers AI begins.
Force one Queue retry after a completed chunk and confirm its immutable raw
response is reused rather than billed twice. Confirm one final transcript
revision, source-relative monotonic segment cues, no word/alignment rows, no
transcript text in audits, and unchanged working-master/public-media objects.
Do not expose the production processor routes until this rehearsal passes with
rights-cleared English and Spanish sources.

After a real zero-blocker current QC run exists, approve the exact source from
the Production tab with a bounded reason and acknowledgement. Confirm a stale
`baseRevision` is `409`, non-Super-admin approval is `403`, the response/audit
contains hashes but no object key or reason text, and readiness changes from a
missing to ready `core.working_master` node.

Queue one bounded A/B preview and dispatch:

```sh
gh workflow run process-audio-enhancement-preview.yml \
  --ref agent/launch-configuration \
  -f job_id="enhance_REPLACE_WITH_QUEUED_ID"
```

Confirm the workflow checks the source SHA against successful QC, renders both
48 kHz 192 kbps MP3 excerpts, uploads through signed Worker streams, verifies
both native R2 checksums, retains no audio artifact, and commits one bounded
report. In the workbench, test authenticated range playback and downloads for
both sides. Confirm anonymous media is `401`, a changed ETag/report/recipe is
`409`, a preview cannot become a master, and production remains untouched.

Using an isolated fully reviewed fixture, confirm
`GET /v1/admin/episodes/{id}/readiness` returns 15 ordered nodes, the existing
legacy Publish checks pass unchanged, every current review target is counted,
the candidate is ready, and repeated reads return the same `snapshotDigest`
despite different `generatedAt` values. Confirm Analyst access succeeds,
anonymous access is `401`, non-GET methods are `405`, allowlisted preflight is
credentialed, and private/no-store/noindex/nosniff headers are present.

Then mutate only disposable evidence: advance a transcript revision without
alignment/review, change the delivery-audio ETag under an ad plan/clip, leave
one current review target unreviewed, add an open blocker, fail one
current-revision root job, disable directory owner setup, and exercise
audio-only and `premium_bonus` access. Confirm the corresponding nodes become
stale/pending/failed/not-applicable, the snapshot digest changes, raw keys,
digests, review bodies, and job errors are absent, and neither a queue nor an
external provider is touched. In staging shadow, confirm
`publishingEnforced`/`overrideAvailable` remain false, a fresh digest/revision
reports `snapshotMatched: true`, a missing or stale snapshot reports false
without blocking a legacy-ready fixture, and no override row is created.

In an isolated local or disposable staging database, temporarily exercise
`enforce`: a Producer cannot override; an Admin override needs recent
authentication, exact confirmation, a valid operation ID, and 1–500 safe
characters. Confirm the private table has the full reason while the audit event
has only hash/length/count/version metadata. Mutate episode, show, and global
evidence between snapshot and Publish and confirm `409`, zero queued/site/
directory/override/audit rows, and an empty guard table. Restore staging to
`shadow` immediately after this controlled test. Do not change production from
`legacy`.

For the public transcript projection, use an isolated published/due/public
episode with ready media and one immutable approved English or Spanish
revision. Confirm `GET` returns only plain timed text, confirmed speaker names,
the expected revision digest, wildcard read-only CORS, a public short-cache
policy, and a content-derived ETag; confirm `HEAD` is body-free and a weak
`If-None-Match` returns `304`. Tamper a disposable revision digest/content pair
and confirm that language is omitted. Draft, future, archived-show,
`premium_bonus`, and non-ready-media fixtures must all return the same
no-store `404`. Do not use a real premium transcript as a negative fixture.

For the chapter projection, use a separate isolated episode with one approved
revision. Confirm public `GET` returns version `1.2.0`, ascending second-based
markers, `application/json+chapters`, the expected optional HTTPS metadata,
wildcard read-only CORS, short shared caching, and a content-derived ETag;
confirm `HEAD` is body-free and weak `If-None-Match` returns `304`. Confirm the
public RSS item has exactly one HTTPS `<podcast:chapters>` tag. Tamper the
disposable revision digest and confirm the document becomes a no-store `404`.
Draft/future/premium-only/non-ready fixtures must share that public `404`.
Using a disposable entitled listener, confirm early/bonus private RSS points
to the tokenized chapter route and its response is private/no-store with no
wildcard CORS. Never put the token in shared evidence.

## 3. Configure non-secret test state

- Associate the inactive Stripe test product and inactive $5/month and
  $50/year prices with Ópera en la Selva.
- Keep `billing_mode=test`, `SUBSCRIPTION_CHECKOUT_ENABLED=false`, manual tax
  assignments empty, and all provider prices inactive until the billing
  preflight below is complete.
- Seed at least two super-admin lookup HMACs using one newly generated staging
  pepper. Do not store raw email addresses in D1 or the repository.
- Confirm eleven directory rows exist with truthful owner-setup states.

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

Admin and listener peppers/session secrets must be independently generated.
The feed-token pepper must also be independent. Replacing it invalidates every
issued private URL, so rotate it only during a planned all-feed reissue or an
incident; normal listener URL replacement uses the rotate endpoint.
The Resend and Turnstile provider credentials may be shared by the Podcast
runtime, but listener and admin requests use distinct idempotency namespaces
and Turnstile actions.

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
existing Pool/Store signing key. Before enabling the bridge, create a
non-production Pool benefit mapping with an explicit show and duration, then:

1. Send one signed grant to the staging bridge and retry the exact event;
   confirm one HMAC-only code row and an idempotent response.
2. Redeem it through an owner-controlled listener session; confirm the code
   works once, only for the intended verified email, and creates an independent
   `pool` entitlement source.
3. Confirm the same code, a wrong email, malformed signatures, stale
   timestamps, and conflicting event reuse all fail without revealing state.
4. Revoke the grant and confirm only its matching current Pool source is
   canceled; an unrelated Stripe/manual fixture must remain active.
5. Exercise revoke-before-grant ordering and confirm a later grant with the
   same grant ID remains revoked.
6. Disable the bridge again and delete the synthetic Pool mapping after saving
   redacted evidence.

Before the first controlled Checkout:

1. Back up D1 and apply every pending migration.
2. Confirm the test Product/Prices are active and mode-matched.
3. Enter an accountant-approved, effective test tax version and assign it to
   the show; confirm its Stripe manual Tax Rate has the identical
   percentage/inclusive/country/state evidence.
4. Confirm the signed webhook subscribes to `checkout.session.completed`,
   `checkout.session.expired`, and `customer.subscription.*`.
5. Verify `GET /v1/admin/billing/readiness` shows every dependency and zero
   failed journal events.
6. Set `SUBSCRIPTION_CHECKOUT_ENABLED=true`, deploy only the reviewed commit,
   and buy once with a Stripe test card and owner-controlled address/email.
7. Confirm the Checkout attempt stores hashes/evidence only, the webhook
   creates one listener plus Stripe entitlement source, the aggregate is
   active, the magic link works, private feed creation works, and Portal opens.
8. Cancel in Portal, replay webhook events out of order/duplicated, and confirm
   the entitlement changes once without affecting a fixture Pool/manual source.
9. Disable the kill switch again and remove all customer/subscription fixtures
   after exporting redacted evidence.

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

The clip workflow does not need a Cloudflare API token, account ID, or R2
access key. Its purpose-bound source and output routes stream through the
staging Worker's private R2 binding. The workflow file must exist on the
default branch before GitHub accepts a manual dispatch. Then queue one render
in the authenticated clip workbench and run:

```sh
gh workflow run process-clip-render.yml \
  --ref main \
  -f render_id=clip_render_example
```

Confirm the report artifact contains only callback/failure/upload evidence,
never the source MP3, manifest/captions, raster frames, or MP4. Follow
`CLIP_RENDER_GATE.md` for the acceptance and rollback matrix.

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
- an entitled listener can create one private URL, read due premium RSS, play
  a byte range, and rotate it; the old feed and media URLs then return the same
  `404` as an unknown token, while the replacement continues to work;
- notification state begins disabled even for an entitled listener; an
  authenticated same-origin/CSRF `PUT` can explicitly enable English or
  Spanish for one show and can withdraw it again without changing entitlement;
- the Marketing announcement dry run rejects anonymous/cross-show access,
  returns only normalized content, an eligible count, and pseudonymous
  revision hashes, and remains `reviewOnly: true` with
  `sendEnabled: false`;
- no announcement review creates an outbox/provider row or Resend request;
  the empty staging preference table must yield zero eligible recipients;
- private responses remain no-store/noindex without wildcard CORS, D1 contains
  only a 64-character token HMAC, and polling within one hour does not advance
  `last_used_at`;
- Cloudflare automatic invocation URL logs remain disabled and saved smoke
  evidence contains no private bearer URL;
- News and YouTube jobs report `dry-run`;
- a public audio-only publication creates RSS and News jobs but no YouTube job;
  a public video publication adds YouTube; and a premium-bonus publication
  creates RSS plus a versioned `premium_teaser` News snapshot with no media,
  download, transcript, chapter, duration, token, or premium-time fields;
- the premium teaser canonical page, show card, and noindex embed render a
  subscription CTA without an audio element, player/transcript/chapter script,
  associated-media JSON-LD, or episode media origin;
- a Producer can prepare one immutable private/unlisted Shorts draft for a
  current ready clip; recent-super-admin approval records `dry_run`, issues no
  Google request, and a `public` value is rejected;
- the canonical website remains unchanged;
- Stripe rejects unsigned and wrong-mode events.
- the disabled Pool bridge returns `404` before D1 access; during its controlled
  test, signed grant/retry/redeem/revoke behavior matches the sequence above
  without persisting raw emails or codes.
- unsigned ad-plan processor callbacks return `401` before D1 lookup; a
  reviewed fixture workflow produces private frame-aligned segments, moves the
  plan only to `needs_review`, and requires an authenticated producer approval.
- unsigned clip manifest/source/output/complete requests return `401` before
  D1 lookup; one queued staging render streams the immutable source, produces
  and fully decodes the expected aspect, stores matching native/custom R2
  checksums, reaches `ready`, and returns `idempotent: true` on callback replay.
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
The staging `FEED_ORIGIN` and `MEDIA_ORIGIN` intentionally use this hostname so
copied staging feed/enclosure URLs remain testable without production DNS.

Do not attach `feeds.dustwave.xyz` or `media.dustwave.xyz` during this step.

## 6. Controlled external tests

Live GitHub publication targets only the release branch and requires a reviewed
fixture.

For the YouTube clip test:

1. Leave `YOUTUBE_PUBLISH_MODE=dry_run`, prepare the immutable current-render
   draft in Marketing, and have a recently authenticated super-admin approve
   it. Confirm D1/audit status `dry_run` and zero provider calls.
2. Confirm the D1 backup/restore drill, current render checksum evidence, exact
   show/runtime channel URL, production-channel ownership, and a cleanup owner.
3. Install the four YouTube Worker secrets listed above. Temporarily change
   only the staging environment to `YOUTUBE_PUBLISH_MODE=controlled_test`,
   validate a dry-run bundle, and deploy the exact reviewed commit.
4. Reopen the existing dry-run record and approve it once. Prefer `unlisted`;
   `private` is allowed, while `public` is structurally rejected. The request
   should return `202` before any provider upload completes.
5. Record the publication ID, provider video ID, verified channel/privacy,
   upload audit event, Queue outcome, and manual inspection result. Delete or
   retain the test video according to the recorded owner decision.
6. Restore staging `YOUTUBE_PUBLISH_MODE=dry_run` first and redeploy the exact
   reviewed configuration. Any still-queued job then fails closed as
   `youtube_mode_disabled` without R2/provider access. Remove or rotate the
   temporary provider secrets if they are not needed.

If Google accepted a video but verification or the D1/audit commit failed, do
not retry automatically. Reconcile the channel manually and record cleanup
before authorizing a new render. Production Worker configuration, routes, D1,
R2, Queue, and DNS remain untouched throughout this test.

## 7. Rollback

- Restore dry-run provider variables first.
- Roll back Worker code to the last verified deployment.
- Pause Queue consumers if jobs are unsafe; retain messages and D1 audit state.
- Restore D1 only when forward repair is unsafe and the backup is verified.
- Abort orphaned multipart uploads and remove fixture objects after their
  evidence is captured.
- Do not delete a public GUID, enclosure identity, or directory feed. Correct
  metadata in a new publication revision.
- A Worker-code rollback after migration `0020` is safe because the new partial
  unique index is additive. Do not drop it during rollback; it preserves the
  one-active-feed invariant.
- A Worker-code rollback after migration `0026` is also safe because the new
  notification table/index is additive. Leave it in place; older code neither
  reads it nor implies consent from its presence.
