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

Confirm invocation logs and automatic traces remain disabled because private
feed bearer values are path-scoped. Queue failures must emit the bounded
structured `job_failed` event before retrying; never log a job payload or
private URL. Add automatic tracing only after a redacting Tail Worker or
token-free route passes an independent security gate.

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

For migration `0041`, create only isolated root-job fixtures. Advance an
episode with older `queued` and `failed` jobs and confirm both atomically become
`canceled` with a completion time. Then create an older `running` job and
confirm revision advancement aborts with `publication_jobs_running`, leaving
the episode revision unchanged. Exercise a stale Queue message and a
show/type-mismatched message: the stale retryable row must be canceled without
provider I/O, while the mismatched payload must not claim durable work. After
the matching running fixture reaches a terminal state, retry Publish and
confirm exactly one new root-job set. Keep GitHub and YouTube in `dry_run`.

For migration `0042`, verify the Checkout integration-identifier column, both
tax-evidence tables, their show/attention/subscription indexes, JSON validity,
fixed state checks, and clean foreign keys. Keep Checkout disabled. With signed
local or Stripe CLI fixture events, confirm:

- a matching subscription invoice stores one non-PII evidence row per event;
- duplicate delivery is idempotent through the existing event journal;
- a Dust Wave invoice received before its source projection returns a retryable
  projection failure, while an unrelated non-subscription invoice is ignored;
- mismatched/missing provider tax evidence produces attention state without
  failing or mutating the provider;
- `customer.updated` discards the raw address after normalization and HMAC,
  records only one preview per event/subscription, and makes no Stripe request;
- the Super-admin JSON/CSV export is bounded and private, rejects unauthorized
  roles, neutralizes formula-shaped text, and contains no email/address/token;
  and
- Checkout includes a stable `dustwave_podcast_` integration identifier ending
  in eight lowercase letters, while omitting `automatic_tax` and
  `payment_method_types`.

For migration `0043`, verify the show-scoped and global subscription keyset
indexes, confirm source lookups continue to use the existing unique
listener/show/provider index, then run `PRAGMA foreign_key_check`. With
Super-admin fixtures, confirm JSON pagination,
all allowlisted filters, aggregate/source counts, private-feed and consent
booleans, and the 500-row CSV bound. Reject Admin and lower roles before the
subscriber query runs. Inspect JSON and CSV for absence of email, address,
feed-token, login-token, session-token, and raw entitlement credential fields;
formula-shaped fixture text must be neutralized in CSV.

For migration `0044`, verify the immutable announcement/outbox tables,
delivery-due/provider indexes, suppression journal, webhook replay journal, and
the nullable notification unsubscribe HMAC. Keep staging in `dry_run`; a
review/approval exercise must complete without decrypting a destination or
contacting Resend.

For migration `0045`, verify show-local saved-link code uniqueness, the
`podcast_marketing_links_show_recent` query plan, and clean foreign keys.
Confirm Analyst can list but not mutate, Producer is confined to the assigned
show, off-origin or missing-CSRF writes fail before D1 mutation, and a stale
`expectedUpdatedAt` returns `marketing_link_changed` without a second audit
event. The returned JSON must omit admin-user IDs.

Use a Stripe sandbox test clock only after an accountant-approved staging Tax
Rate exists. Exercise initial invoice, monthly and annual renewal, address
change, same-rate replay, rate change, payment failure/recovery, cancellation,
duplicate delivery, and out-of-order events. Do not create or expire a tax
registration, activate a live Tax Rate, or enable Checkout as part of this
migration gate.

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

For migration `0053`, verify `show_feed_validations`, the append-only
`distribution_observation_events` sequence, both show/destination and
episode/revision indexes, the immutability trigger, publication-evidence
triggers, and clean foreign keys. Before applying remotely, take the standard
staging export or exact Time Travel bookmark and record only aggregate counts.
After apply:

- publish one isolated eligible fixture and confirm the RSS root job records a
  `valid` current feed with a 64-character SHA-256, the expected self URL,
  validator version, and item count before that job succeeds;
- remove one required metadata fragment in a local/fixture-only validator test
  and confirm the closed failure code is recorded while the RSS job fails;
- record one evidence-backed `observed` state and confirm ingestion is ready
  but recovery is not;
- record a bounded `failed` state and then a later HTTPS-evidenced `observed`
  state for the same directory; confirm exactly one failed-to-observed recovery
  proof, replay the final request, and confirm no second event;
- verify the Distribution response and bilingual admin cards show all four
  proofs independently, remain readable at 320 CSS pixels, and announce no
  status by color alone; and
- verify nine certified destinations remain below the claim gate while ten
  become ready. Do not mark real owner, ingestion, or recovery evidence in
  staging merely to make the counter green.

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

For migration `0039`, verify `transcript_alignment_jobs`,
`transcript_alignment_approvals`, both alignment-job indexes, both word
indexes, and the four approval/pass/staleness triggers. Confirm the same
position can exist in two different alignment revisions but not twice in one
revision. A direct `passed` update must abort without an exact approval; an
approval must abort for a failed, dirty-environment, mismatched-adapter, stale
transcript, stale master, or structurally ineligible result. Replay all 39
migrations from zero and keep both `PRAGMA quick_check` and
`PRAGMA foreign_key_check` clean.

For migration `0040`, back up remote staging before applying it, restore that
backup into a disposable local SQLite file, and verify `quick_check`, foreign
keys, all 39 prior migration records, and row counts. After applying, verify
the seven benchmark evidence columns, unique submission/input indexes,
non-unique report index, passing-evidence view, and recreated approval trigger.
A manually inserted passing benchmark without private evidence or the exact
runner revision must still fail approval. Replay every migration from zero.
Before any real benchmark import, `alignment_benchmark_runs` and private
benchmark R2 objects must remain zero.

For migration `0046`, verify both analytics tables, the expiry and show/date
indexes, closed event/methodology checks, 64-character key checks, UTC-date
shape checks, positive rollup counts, and clean foreign keys. Set a dedicated
staging-only `ANALYTICS_HASH_SECRET`; never copy an auth, Stripe, Resend, Pool,
Store, or deployment secret. Exercise a full and sub-minute range with a
controlled fixture, confirm one daily deduplicated rollup, confirm raw IP/user
agent values do not appear in D1, then confirm the admin 7/30/90-day JSON and
CSV remain private/no-store. Known bots, `HEAD`, watchOS, untrusted player
origins, and premium/non-public player events must not count. Production stays
unmigrated and undeployed until owner review.
For migration `0047`, verify the two isolated web-player completion tables,
their expiry and show/date indexes, the closed 25/50/75/100 milestone check,
64-character key checks, positive rollup counts, and clean foreign keys.
Replay one exact unique/milestone pair twice and confirm its rollup stays at
one. From the trusted staging site, exercise a 60-second engaged play followed
by bounded cumulative completion events; seeking without foreground elapsed
time must not advance a milestone. Confirm D1 contains no raw IP, user agent,
playhead position, or elapsed-second value and that the 7/30/90 JSON/CSV and
English/Spanish dashboard identify the scope as Dust Wave web player only.
Production remains unmigrated and undeployed.

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

After both reviewed transcript languages and an exact working master exist,
queue an alignment from the Production workbench in isolated staging. Copy the
displayed job ID and dispatch only from the reviewed release branch:

```sh
gh workflow run process-alignment.yml \
  --ref agent/launch-configuration \
  -f job_id="alignment_job_REPLACE_WITH_QUEUED_ID"
```

Before dispatch, confirm the runner submodule is the exact revision displayed
by the API and the repository secret is only
`MEDIA_PROCESSOR_CALLBACK_SECRET`. The run must use Ubuntu 24.04, install the
selected adapter from the committed `uv.lock`, fetch the exact signed
manifest/source, and retain only content-free evidence. Confirm the source
audio, transcript projection, raw result, and callback are absent from
artifacts and logs.

Refresh the workbench and verify the job reaches `ready` while the alignment
revision stops at `needs_review`. Check every stored word belongs to the exact
revision and has stable position/cue identity; invalid/interpolated/omitted
words must not be structurally eligible. Replay the same callback and queue
request and confirm no duplicate word rows or new billable job. Force one
bounded retryable failure and confirm the same job reopens; force five claimed
attempts and confirm the sixth claim fails closed. Change the transcript or
working master and confirm the original job becomes stale.

Do not click approval or claim H1 until the 24 rights-cleared English/Spanish
fixtures, 100 unclipped preview reviews, both 60-minute resource runs,
idempotency checks, and clean-environment reproduction have produced one exact
passed benchmark row for this adapter/model/settings/runner digest. Production
alignment processor routes must remain `404`.

When the reviewed corpus is ready, sign in with a fresh Super-admin magic link,
open Production → English/Spanish word alignment, and import the runner’s
`alignment-benchmark-submission-v1` JSON. First use staging with a
rights-cleared copy. Confirm:

- a first import is `201` and an exact replay is `200`/idempotent;
- a reused submission ID with changed evidence is `409`;
- the list returns counts/gates/digests but no word text or object key;
- D1 has one row with input bytes/SHA, private object key, runner revision, and
  submitter ID;
- the private R2 object’s size/native SHA/custom metadata match D1;
- audit JSON contains no corpus text, audio location, or object key;
- failed evidence is retained but cannot unlock approval; and
- stale recent authentication, missing CSRF, or non-Super-admin import is
  rejected before any D1/R2 write.

Do not upload the production corpus to GitHub Actions, attach it to a PR, paste
it into logs, or place its R2 key in screenshots. A passing synthetic fixture
is test coverage, not launch evidence.

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

Select the reviewed ready preview in the Production tab and queue its
full-length derivative. Dispatch the returned ID:

```sh
gh workflow run process-audio-enhancement-derivative.yml \
  --ref agent/launch-configuration \
  -f job_id="derivative_REPLACE_WITH_QUEUED_ID"
```

The render job must finish multipart upload and return the derivative QC run
ID; the called QC job must then finish against that exact output. Confirm the
artifact contains only `processor-evidence.json` and no object key, source,
rendered audio, manifest, callback body, or FFmpeg log. In the workbench,
confirm authenticated full-file range playback/download, current-policy and
digest-match indicators, and that the approval form appears only to a
Super-admin after zero-blocker QC.

Approve with the exact displayed base revision and a bounded operational
reason. Confirm the response creates an `enhanced_derivative` master at the
next revision, the old derivative becomes approved while other active
derivatives become stale, and transcript/chapter/clip approvals are
invalidated through the existing master triggers. Repeat with a stale
revision, changed current master, mismatched output SHA, old QC-policy
revision, and non-Super-admin session; each must fail closed without a master
or audit row. Anonymous derivative media is `401`; production queue,
processor, and object state remain untouched.

With the final working master selected, queue Delivery audio and player
waveform from Production and dispatch the returned job ID:

```sh
gh workflow run process-delivery-audio.yml \
  --ref agent/launch-configuration \
  -f job_id="delivery_audio_REPLACE_WITH_QUEUED_ID"
```

Confirm the run fetches only the exact signed master, emits raw complete
44.1 kHz stereo 128 kbps MP3 frames without ID3/Xing metadata, fully decodes
the complete output, creates no more than 8,192 waveform peak pairs, and
uploads every 32 MiB-bounded part through the Worker with exact length and
SHA-256. The retained artifact must contain only IDs, byte/count totals, and
digests—not the source, MP3, waveform, manifest, callback, R2 key, or FFmpeg
log.

Refresh the workbench and exercise the existing authenticated player,
waveform, range request, and download. Anonymous admin media/peaks must be
`401`; production queue/processor routes must be `404`. From a fresh
Super-admin session, approve with a 10–500 character reason and exact-byte
acknowledgement. Confirm the episode enclosure and approved job change in one
transaction and readiness changes to a ready `core.delivery_audio` node.
Repeat against a changed master, mismatched MP3 ETag/SHA, altered peaks
digest, stale recent authentication, non-Super-admin identity, and replayed
callback; all must fail closed without a new audit row.

For a disposable published/due public episode, confirm
`GET|HEAD /episodes/{id}/peaks` returns the approved bounded JSON with public
short-cache headers and a conditional ETag. Draft, future, premium-only, stale,
and replaced-audio fixtures must return the same no-store `404`. Confirm direct
Publish and the asynchronous News projector each reject an episode lacking the
same exact approved/current delivery job. Do not migrate or deploy production
for this rehearsal.

Using an isolated fully reviewed fixture, confirm
`GET /v1/admin/episodes/{id}/readiness` returns the documented ordered nodes, the existing
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

Required for announcement consent and dry-run delivery:

- `ANNOUNCEMENT_DESTINATION_SECRET`
- `ANNOUNCEMENT_DELIVERY_MODE=dry_run`

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

Before any existing-feed migration:

1. Sign in to the isolated staging admin as a recently authenticated
   super-admin and select the intended existing show.
2. In Overview, enter the exact current public HTTPS RSS URL and confirm that
   Dust Wave owns or has permission to import it.
3. Run Preview. Confirm the response is private/no-store,
   `importMutationPerformed` is `false`, the owner address is not displayed,
   and every non-audio/image item is explicitly non-migratable.
4. Record only the feed digest, redirect count, total/audio/migratable counts,
   and blocker categories. Do not copy remote HTML, owner email, raw GUIDs, or
   enclosure URLs into public evidence.
5. Compare episode/media-table counts and the staging R2 prefix before and
   after; only the ordinary admin-session last-seen heartbeat may change.
6. Do not configure a new-feed tag or old-host 301 redirect. Those actions
   remain unavailable until a later immutable copy/reconciliation boundary and
   owner approval.

The authorized Ópera en la Selva Substack URL is useful as a negative preview
fixture while it contains newsletter article/image enclosures; it must not be
represented as source podcast audio. Re-evaluate the live feed on every run.

Before enabling the bridge, create a
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

The read-only Stripe provider preflight passed on 2026-07-27 without creating
a Customer, Checkout Session, Subscription, charge, or tax object:

- staging D1 and Stripe agree on the inactive Ópera en la Selva test Product,
  exclusive $5 monthly Price, exclusive $50 annual Price, USD currency,
  intervals, lookup keys, and show metadata;
- the active test webhook targets only the Podcast staging route, pins the
  Worker API version, and includes Checkout completion/expiration plus the
  subscription lifecycle events consumed by the projection;
- two provider-signed test Checkout expiration events are processed with zero
  failed journal entries;
- the Podcast-only test Portal configuration is active, permits payment-method
  updates and at-period-end cancellation without proration, and disables
  address updates, plan changes, and pause;
- the staging Worker has a test-mode API credential and independently scoped
  webhook secret, while `SUBSCRIPTION_CHECKOUT_ENABLED` remains `false`;
- the Product and both Prices remain inactive, and no approved tax version is
  assigned.

The authenticated Stripe CLI credential used for this read-only preflight
expires on 2026-10-12. It is acceptable only while Checkout is disabled.
Replace it with a dedicated restricted Podcast test key before step 2, then
repeat the preflight. Never reuse the Pool/Store webhook signing secret or a
live API key.

Run the same evidence contract without copying provider output into a shell
transcript:

```sh
npm run gate:stripe:staging
```

The safe pre-activation result is `14 pass, 1 block, 0 fail`; the sole blocker
is the absent accountant-approved tax version. The gate exits nonzero for any
configuration/provider drift. During final promotion, require the blocker to
be gone as well:

```sh
npm run gate:stripe:staging -- --require-ready
```

The gate accepts no production selector, performs no Stripe or D1 mutation,
reads only Worker secret names, and never emits a provider key. Run it only
from the reviewed Podcast repository with authenticated test-mode Stripe and
Wrangler CLIs.

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

- migration `0048_virtual_audio_diagnostic_leases.sql` on the staging D1
  database;
- staging secret `AD_DECISION_SIGNING_SECRET`; and
- staging variable `AD_DECISION_MODE=staging_validate`.

The gate reuses the ad-decision signing secret only through a distinct HMAC
domain. It does not create, rotate, or delete Worker secrets. Its one-time
lease contains only a domain-separated SHA-256 hash of a random token and
expires after 15 minutes.

If running an individual matrix for diagnosis, supply its signed capability to
`npm run matrix:virtual-audio` or `npm run load:virtual-audio` through
`VIRTUAL_AUDIO_DIAGNOSTIC_CAPABILITY`, never a command argument. Generated JSON
redacts the fixture path and labels header-level app probes as protocol
emulation rather than native-client evidence. Remove all four exact fixture
objects and the matching D1 lease immediately after saving the evidence.

Prefer the atomic staging-only wrapper for routine evidence runs:

```sh
npm run gate:virtual-audio:staging -- \
  --output /absolute/private/evidence/empty-directory \
  --pairs 5000 --concurrency 12
```

The wrapper refuses the production origin, a nonempty evidence directory, or
any non-matching pre-existing fixture object. It inserts one exact hashed lease
in the dedicated D1 table, exchanges the raw token once, and keeps the returned
15-minute capability only in memory and child-process environment state. The
raw token and capability are not printed or persisted in evidence.

Before creating that temporary lease, it requires three consecutive successful
responses from the non-sensitive staging player route. Its exact-name setup
endpoint then requires both the signed capability and an active exchanged
lease, and verifies byte length, MIME type, and SHA-256 before writing through
the Worker's private R2 binding. Streaming verifies the signature without a D1
request so load evidence measures the launch hot path. The wrapper preserves
matching pre-existing objects, removes only objects uploaded by the current
run, deletes only its generated lease ID, waits for ten consecutive ranged
readiness probes before recording evidence, and fails if either cleanup step
cannot be confirmed.

After an uncatchable force kill, inspect the dedicated
`virtual_audio_diagnostic_leases` table for unexpired or recently expired rows,
then inspect the four exact `fixtures/virtual-audio/` keys. Delete only a
confirmed diagnostic lease ID and confirmed fixture keys; never use a
prefix-wide R2 delete. The scheduled Worker cleanup also removes expired
leases, but it does not replace the manual object audit.

Use least-privilege staging credentials. Cloudflare does not expose existing
secret values, so rotate or enter them rather than attempting to copy them from
Pool or Store.

The verified `dustwave.xyz` Resend domain may be reused, but Podcast requires
its own domain-restricted sending key. Do not reuse the existing Pool or Store
key. The same separation applies to the Turnstile widget secret. Public
Turnstile test keys are not acceptable on the Internet-accessible staging
Worker.

Create the dedicated real staging widget only after Wrangler's OAuth grant
includes `challenge-widgets.write`. Wrangler 4.114.0 exposes this boundary
directly, so there is no need to reuse a Pool/Store widget or paste the secret
through the dashboard:

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
build. Put it in `PODCAST_ADMIN_TURNSTILE_SITE_KEY` and
`PODCAST_MEMBER_TURNSTILE_SITE_KEY` only for that build; do not put the secret
in a command argument, environment file, GitHub variable, source file, shell
history, or build artifact. Use a separate Checkout widget/site key when
Checkout activation begins so its action and hostname policy can change
independently.

If widget creation or either JSON assertion fails, keep login closed, delete
only the exact temporary file created above, and inspect `wrangler whoami`.
Never fall back to Cloudflare's public dummy key on the deployed Pages/Worker
origins. After installation, `wrangler secret list --env staging` may confirm
the secret name only; it must not be readable.

Validate a new Resend key against Resend's designated delivered-test address
before installing it, using a hidden environment or interactive prompt rather
than a command argument. The Worker records only a closed delivery failure
code and numeric provider status; it never logs the provider response body,
destination, login URL, or exception text. Keep login fail-closed until a real
staging Turnstile widget and matching secret are installed. A dummy Turnstile
pair is suitable for local/automated tests only, not the public `workers.dev`
deployment.

The staging Podcast webhook contract passed its provider-independent
signature/replay exercise on 2026-07-27. The dedicated active webhook subscribes
only to delivered, bounced, complained, failed, and suppressed events; its
one-time signing secret was rotated after the exercise and installed only as
`RESEND_WEBHOOK_SECRET`. An unsigned JSON request returned `401`; after edge
propagation stabilized, one signed content-free unmatched delivery event
returned `200`, and its exact replay returned `200` with `duplicate: true`.
The exercised secret/webhook was disabled, not deleted, and no listener,
announcement, address, or delivery row was fabricated. This is signature and
replay evidence only: `ANNOUNCEMENT_DELIVERY_MODE` remains `dry_run` until one
consented staging listener can receive the bounded live-send test below.

## 5. Deploy and smoke test

```sh
wrangler deploy --env staging
```

Verify:

- credentialed `OPTIONS /v1/admin/session` from
  `https://dust-wave-website-staging.pages.dev` reflects that exact origin,
  while the production Dust Wave origins, Pages preview hostnames, and an
  unrelated origin receive no `Access-Control-Allow-Origin`;
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
  Spanish for one show only after the listener re-enters the matching account
  email; D1 stores an AES-GCM-sealed destination and erases it after the final
  withdrawal without changing entitlement;
- the Marketing announcement dry run rejects anonymous/cross-show access,
  returns only normalized content, an eligible count, and pseudonymous
  revision hashes, and remains `reviewOnly: true` with `deliveryMode:
  "dry_run"`;
- a recently authenticated Admin can approve the unchanged review into
  immutable announcement/delivery rows; the queue resolves every row to
  `dry_run`, the count-only history reflects completion, and no Resend request
  occurs;
- changing message, consent, destination, entitlement, or suppression evidence
  between review and approval returns `announcement_review_changed` and
  cancels the frozen work before queue/provider side effects;
- the empty staging preference table yields zero eligible recipients and
  cannot be approved;
- one-click unsubscribe withdraws only that show, suppresses pending work, and
  erases the sealed destination when no other show consent needs it;
- private responses remain no-store/noindex without wildcard CORS, D1 contains
  only a 64-character token HMAC, and polling within one hour does not advance
  `last_used_at`;
- Cloudflare automatic invocation URL logs remain disabled and saved smoke
  evidence contains no private bearer URL;
- News and YouTube jobs report `dry-run`;
- a changed publication revision atomically cancels its older queued/failed
  root jobs, refuses to race an older running job, and rejects a Queue payload
  whose show/type does not match durable state;
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
- with the committed `staging_validate` mode, the permanent enclosure remains
  the approved full file even if both dynamic-ad flags are true; no automatic
  decision row or redirect is created.

Only after the synthetic protocol/load gate is green, use one isolated
rights-cleared episode for a temporary `staging_public` exercise. Confirm both
feature flags, complete equal-length house coverage, and both independent
secrets before deploying that mode. Verify the stable enclosure returns a
private/no-store `307`, persists only normalized app/device values, preserves
range/ETag/download behavior, counts one fully emitted direct creative once,
and does not count `HEAD`, partial, canceled, repeated, or fallback delivery.
Invalidate the primary creative before a new decision and confirm the request
stays on or commits the exact house fallback before headers. Then restore
`staging_validate`, set both feature flags false, deploy, and verify the stable
enclosure is full-file-only again. Never save an unredacted signed decision URL
or request header set in shared evidence.

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

For the full-episode YouTube test, use a separate fixture publication:

1. Complete one bounded `video_source` multipart upload as `video/mp4`, publish
   or schedule the non-premium-bonus fixture, and confirm its immutable release
   graph contains one YouTube root job for the same revision.
2. With `YOUTUBE_PUBLISH_MODE=dry_run`, create
   `POST /v1/admin/episodes/{episodeId}/youtube` using a new publication ID,
   the exact publication revision, `unlisted`, bounded title/description, and
   the exact configured channel URL. A recently authenticated super-admin then
   approves that publication. Confirm `dry_run`, audit evidence, and zero Queue,
   R2 body reads, OAuth, and provider calls.
3. Install the same four temporary launch-channel secrets, switch only staging
   to `controlled_test`, dry-run/deploy the reviewed commit, and approve the
   same immutable record. If public release is due, confirm `202` and one root
   Queue message; if it is future-dated, confirm no immediate send and let cron
   enqueue it only at public release.
4. Confirm the consumer conditionally reads the snapshotted R2 ETag, verifies
   the returned channel and unlisted privacy, records one provider video ID on
   the publication/current episode/root job, and emits the upload audit.
5. Restore staging to `dry_run` before cleanup. If state becomes
   `reconciliation_required`, do not use the generic retry action. Inspect the
   launch channel first. If an unlisted video exists, keep the temporary OAuth
   secrets long enough to submit `uploaded`, its provider ID, and
   `CONFIRM_VERIFIED_UNLISTED_VIDEO`; the Worker verifies channel/privacy before
   committing it. If no item remains (including after intentional deletion),
   submit `not_uploaded` and `CONFIRM_NO_CHANNEL_VIDEO_REMAINS`. Both paths
   require recent Super-admin authentication and audit the outcome. Production
   configuration and data remain untouched.

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
- A Worker-code rollback after migration `0052` must leave delivery job/part
  tables and triggers in place. They preserve immutable evidence and prevent
  older/manual delivery audio from silently replacing a current-master render.
