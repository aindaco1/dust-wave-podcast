# Staging migration validation

Audience: maintainers validating an identified schema change.

Use the [staging runbook](STAGING_RUNBOOK.md#2-back-up-and-migrate-staging) for
backup, pending-migration application, and deployment order. These recipes apply
to a fresh/disposable database or an identified unapplied migration. An instruction
to replay migrations means a fresh local database, never an existing remote one.
Empty-table and bootstrap assertions apply at the stated migration boundary;
preserve existing rows when validating an established environment.

The ordered files in [migrations](../migrations) own the schema. This guide keeps
the additional validation recipes already documented; it is not a second complete
migration inventory or evidence of remote application. [Current state](CURRENT_STATE.md)
owns dated operational results. Use [staging acceptance](STAGING_ACCEPTANCE.md)
for detailed media, UI, and controlled-provider exercises.

## Find the applicable checks

- [Listener, directory, and publication state](#listener-directory-and-publication-state)
- [Editorial and media state](#editorial-and-media-state)
- [Billing, announcements, and analytics](#billing-announcements-and-analytics)
- [RSS import and show lifecycle](#rss-import-and-show-lifecycle)
- [Automation and Launch Lab](#automation-and-launch-lab)
- [Rollback constraints](#rollback-constraints)

## Listener, directory, and publication state

### 0026 — Announcement preferences

For migration `0026`, verify the fresh and restored databases contain
`show_notification_preferences`, its listener/show primary key, and the
`show_notification_preferences_eligible` partial index. Before and after the
remote apply, record only
aggregate row counts and `PRAGMA foreign_key_check`; do not export listener
identifiers into shared release evidence.

### 0027 — Directory setup defaults

For migration `0027`, verify `show_distribution_destinations` contains one row
per show/directory pair, the show/setup index exists, and foreign-key checks are
empty. Keep every owner state `not_started` until an authorized operator
actually completes that platform's one-time setup; do not mark a directory
`verified` merely because its submission page or RSS feed is reachable.

### 0028–0029 — Distribution revision and release recovery

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

### 0030 — Directory observations

For migration `0030`, verify the three nullable directory-evidence columns,
their constrained source values, the admin-user foreign key, and clean
foreign-key checks. With an isolated current-revision fixture, confirm Analyst
is read-only; Producer+ requires same-origin CSRF; `observed` rejects missing or
unsafe evidence URLs; `failed` rejects an empty detail; stale revisions and
incomplete owner setup return `409`; and replaying identical evidence is
idempotent. Never mark ingestion observed merely because the canonical feed or
directory submission page is reachable.

### 0031 — Directory owner checklist

For migration `0031`, verify the four nullable owner-checklist columns and their
length/date constraints. Exercise an Admin/Super-admin update with a harmless
account label, ISO date, HTTPS receipt/dashboard URL, and non-secret note;
confirm Analysts/Producers cannot mutate it, foreign keys stay clean, and audit
metadata contains only presence booleans. Reject URL credentials/fragments,
invalid calendar dates, multiline account labels, control characters, unknown
fields, passwords, and verification codes. Do not fabricate a provider
submission merely to exercise staging.

### 0041 — Root publication job supersession

For migration `0041`, create only isolated root-job fixtures. Advance an
episode with older `queued` and `failed` jobs and confirm both atomically become
`canceled` with a completion time. Then create an older `running` job and
confirm revision advancement aborts with `publication_jobs_running`, leaving
the episode revision unchanged. Exercise a stale Queue message and a
show/type-mismatched message: the stale retryable row must be canceled without
provider I/O, while the mismatched payload must not claim durable work. After
the matching running fixture reaches a terminal state, retry Publish and
confirm exactly one new root-job set. Keep GitHub and YouTube in `dry_run`.

### 0053 — Feed validation and directory recovery

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

### 0077–0078 — Directory registry updates

Migration `0077` is the provider-semantic exception to the
[0027 setup default](#0027--directory-setup-defaults). Verify the
Overcast information URL is `https://overcast.fm/podcasterinfo`, and untouched
Overcast show rows move from `not_started` to `not_required`. Confirm a fixture
already marked `pending` or `verified` keeps its complete operator-authored state.
Overcast still needs current feed validation, observed ingestion, and a real
failed-to-observed recovery sequence before certification; `not_required`
alone must not increase the public 10+ platform count. Run `PRAGMA quick_check`
and `PRAGMA foreign_key_check` after the staging apply.

For migration `0078`, verify the exact first-party action URLs for Spotify for
Creators, Amazon Music's RSS submission form, Player FM's add form, Castbox's
current podcaster-tools page, and iHeartRadio's add-podcast form. Compare all
show-scoped directory setup rows before and after the apply; this registry-only
migration must not change owner, submission, listing, error, or operational-note
evidence. Use table-scoped `PRAGMA quick_check('distribution_destinations')` if
the bounded remote D1
request cannot run a database-wide quick check, and still require an empty
`PRAGMA foreign_key_check` result.

## Editorial and media state

### 0032 — Chapter review

For migration `0032`, verify `episode_chapters` gained `chapter_key` and `toc`,
the four `episode_chapter_*` review/history tables and indexes exist, any
legacy rows have a revision-zero `episode_chapter_sets` header, and foreign-key
checks stay empty. With an isolated fixture, confirm Producer+ writes require
same-origin CSRF and advance one base revision once; Admin+ approval binds the
exact revision; a newer draft leaves the prior immutable approval readable.
Reject nonzero first markers, duplicate/out-of-order or out-of-duration starts,
all-silent documents, unsafe title controls/markup, and non-HTTPS or
credentialed URLs.

### 0033 — Production review

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

### 0034 — Publication evidence

For migration `0034`, verify the episode evidence column; show/global evidence
epoch tables; private override table/index; empty checked batch-guard table;
and all episode dependency triggers. Confirm one episode dependency increments
only its episode epoch, show metadata/setup increments only its show epoch, and
a global directory edit increments only the global epoch. Replay migrations
from zero and keep `PRAGMA foreign_key_check` empty.

### 0035 — Audio QC

For migration `0035`, verify one default `show_audio_qc_policies` row per show,
the new-show seed trigger, all three run indexes (including one-active-source-
policy uniqueness), strict policy bounds, and the queued/running/succeeded/
failed state checks. Replay from zero and keep foreign keys clean. Staging
should still have zero QC runs until a real rights-cleared source exists.

### 0036 — Working masters

For migration `0036`, verify one revision-zero
`episode_working_master_states` row per episode, the new-episode seed and
state-reference triggers, immutable master history/uniqueness, all preview
state checks/indexes, and clean foreign keys. In an isolated fixture, approve
revision one, approve a different revision-two QC snapshot, and confirm
current transcript/chapter approvals clear, clips return to draft, authored
rows remain, and the publication evidence epoch advances. A missing or
cross-episode master pointer must abort.

### 0037–0038 — Transcription and chunks

For migration `0037`, verify the explicit episode source-language column,
one pinned `show_transcription_settings` row per show, the new-show trigger,
both transcription-job indexes, working-master staleness, and zero jobs before
an owner-controlled source exists. For migration `0038`, verify the
chunk-run/chunk tables, both indexes, job-to-run staleness trigger, 16 MiB
per-chunk cap, exact core/media/encoded-duration bounds, and clean foreign
keys. Replay both from zero.

### 0039 — Alignment review

For migration `0039`, verify `transcript_alignment_jobs`,
`transcript_alignment_approvals`, both alignment-job indexes, both word
indexes, and the four approval/pass/staleness triggers. Confirm the same
position can exist in two different alignment revisions but not twice in one
revision. A direct `passed` update must abort without an exact approval; an
approval must abort for a failed, dirty-environment, mismatched-adapter, stale
transcript, stale master, or structurally ineligible result. Replay all 39
migrations from zero and keep both `PRAGMA quick_check` and
`PRAGMA foreign_key_check` clean.

### 0040 — Private benchmark evidence

For migration `0040`, back up remote staging before applying it, restore that
backup into a disposable local SQLite file, and verify `quick_check`, foreign
keys, all 39 prior migration records, and row counts. After applying, verify
the seven benchmark evidence columns, unique submission/input indexes,
non-unique report index, passing-evidence view, and recreated approval trigger.
A manually inserted passing benchmark without private evidence or the exact
runner revision must still fail approval. Replay every migration from zero.
Before any real benchmark import, `alignment_benchmark_runs` and private
benchmark R2 objects must remain zero.

### 0071 — Show-notes proposals

Migration `0071` adds private, review-only `editorial_ai_drafts`. Before the
Worker deploy, replay all migrations locally and prepare
`AUTOMATED_SHOW_NOTES_SOURCES_SQL` against the real schema. On staging, record
content-free counts by status and attempt count before and after migration;
never select `draft_json`, transcript text, prompt text, provider output, email,
or login material. Confirm the table is empty before the first eligible
approval in a fresh fixture; production activation remains separately gated.

### 0073 — Chapter proposals

Migration `0073` losslessly extends the same private proposal ledger with the
`chapters` kind and an exact alignment-revision foreign key. Before deploying,
prepare `AUTOMATED_CHAPTER_SOURCES_SQL` against a zero-to-current schema and
confirm existing show-notes rows survive the rebuild. Record only aggregate
kind/status/attempt counts and `PRAGMA foreign_key_check`; never select draft,
transcript, prompt, provider, email, or token content. Production must retain
`CHAPTER_DRAFT_AUTOMATION_MODE=disabled` and
`CHAPTER_DRAFT_AI_ENABLED=false`.

### 0074 — Clip proposals

Migration `0074` losslessly extends the private proposal ledger with the
`clips` kind and requires its exact alignment-revision foreign key. Before
deploying, prepare `AUTOMATED_CLIP_SOURCES_SQL` against a zero-to-current
schema, confirm existing show-notes and chapter rows survive the rebuild, and
record only aggregate kind/status/attempt counts plus
`PRAGMA foreign_key_check`. Production must retain
`CLIP_DRAFT_AUTOMATION_MODE=disabled` and `CLIP_DRAFT_AI_ENABLED=false`.

After schema validation, use the [editorial workflow exercises](STAGING_ACCEPTANCE.md#editorial-workflow)
for proposal generation, human review, staleness, UI behavior, and privacy checks.

## Billing, announcements, and analytics

### 0042 — Invoice and tax evidence

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

### 0043 — Subscriber administration

For migration `0043`, verify the show-scoped and global subscription keyset
indexes, confirm source lookups continue to use the existing unique
listener/show/provider index, then run `PRAGMA foreign_key_check`. With
Super-admin fixtures, confirm JSON pagination,
all allowlisted filters, aggregate/source counts, private-feed and consent
booleans, and the 500-row CSV bound. Reject Admin and lower roles before the
subscriber query runs. Inspect JSON and CSV for absence of email, address,
feed-token, login-token, session-token, and raw entitlement credential fields;
formula-shaped fixture text must be neutralized in CSV.

### 0044 — Announcement outbox

For migration `0044`, verify the immutable announcement/outbox tables,
delivery-due/provider indexes, suppression journal, webhook replay journal, and
the nullable notification unsubscribe HMAC. Keep staging in `dry_run`; a
review/approval exercise must complete without decrypting a destination or
contacting Resend.

### 0045 — Marketing links

For migration `0045`, verify show-local saved-link code uniqueness, the
`podcast_marketing_links_show_recent` query plan, and clean foreign keys.
Confirm Analyst can list but not mutate, Producer is confined to the assigned
show, off-origin or missing-CSRF writes fail before D1 mutation, and a stale
`expectedUpdatedAt` returns `marketing_link_changed` without a second audit
event. The returned JSON must omit admin-user IDs.

### 0046 — Audience analytics

For migration `0046`, verify both analytics tables, the expiry and show/date
indexes, closed event/methodology checks, 64-character key checks, UTC-date
shape checks, positive rollup counts, and clean foreign keys. Set a dedicated
staging-only `ANALYTICS_HASH_SECRET`; never copy an auth, Stripe, Resend, Pool,
Store, or deployment secret. Exercise a full and sub-minute range with a
controlled fixture, confirm one daily deduplicated rollup, confirm raw IP/user
agent values do not appear in D1, then confirm the admin 7/30/90-day JSON and
CSV remain private/no-store. Known bots, `HEAD`, watchOS, untrusted player
origins, and premium/non-public player events must not count. Production
activation requires its own reviewed evidence snapshot.

### 0047 — Web-player completion

For migration `0047`, verify the two isolated web-player completion tables,
their expiry and show/date indexes, the closed 25/50/75/100 milestone check,
64-character key checks, positive rollup counts, and clean foreign keys.
Replay one exact unique/milestone pair twice and confirm its rollup stays at
one. From the trusted staging site, exercise a 60-second engaged play followed
by bounded cumulative completion events; seeking without foreground elapsed
time must not advance a milestone. Confirm D1 contains no raw IP, user agent,
playhead position, or elapsed-second value and that the 7/30/90 JSON/CSV and
English/Spanish dashboard identify the scope as Dust Wave web player only.
Do not infer production activation from these staging checks.

## RSS import and show lifecycle

### 0055 — Reviewed import plans

For migration `0055`, verify `rss_import_plans` and
`rss_import_plan_items`, the show/recent index, evidence immutability triggers,
1–25 selection bound, query-free display-URL checks, and clean foreign keys.
Replay all migrations from zero and confirm direct item update/delete and plan
delete fail. This migration is additive; retain the pre-migration staging Time
Travel bookmark. Do not apply it to production as part of a staging exercise.

### 0056 — Private copy execution

For migration `0056`, verify `rss_import_executions` and
`rss_import_execution_items`, recovery/show indexes, composite plan-item
foreign key, exact status/count constraints, identity/delete immutability
triggers, and the trigger that prevents canceling a plan after execution
exists. Confirm both tables are empty, foreign-key checks are empty, and
`PRAGMA quick_check` is `ok` immediately after the staging migration. Retain a
new pre-`0056` Time Travel bookmark. The migration is additive; do not apply it
to production as part of a staging exercise.

### 0057 — Copy reconciliation

For migration `0057`, verify `rss_import_reconciliations`, its show/approval
index, immutable row triggers, and execution/item update locks. Confirm the
table is empty, foreign-key checks are empty, and table-scoped
`PRAGMA quick_check` is `ok` immediately after the staging migration. Retain a
new pre-`0057` Time Travel bookmark. The migration is additive; do not apply it
to production as part of a staging exercise. If Cloudflare's whole-database
quick check exhausts remote SQLite memory, record that failure transparently
and require both the complete local replay/global quick check and every new
table's scoped staging check to pass.

### 0058 — Redirect attestation

For migration `0058`, verify `rss_import_redirect_attestations`, its
show/attested index, both immutable triggers, exact redirect-method constraint,
three required confirmation flags, and semantic uniqueness over the
execution/copy/old-feed/new-feed/method identity. Confirm the table is empty,
foreign-key checks are empty, and its table-scoped `PRAGMA quick_check` is
`ok`. Retain a new pre-`0058` Time Travel bookmark. The migration is additive;
do not apply it to production as part of a staging exercise.

### 0059 — Cutover packets

For migration `0059`, verify `rss_import_cutover_packets`, its show/prepared
index, cross-evidence guard, immutable update/delete triggers, ten-directory
minimums, exact confirmation flags, and semantic uniqueness over execution
and cutover digest. Confirm the table is empty, foreign-key checks are empty,
and its table-scoped `PRAGMA quick_check` is `ok`. Retain a new pre-`0059`
Time Travel bookmark. The migration is additive; do not apply it to
production as part of a staging exercise.

### 0064 — Manual redirect handoff

For migration `0064`, verify
`rss_import_redirect_activation_approvals`, its show/approved index,
one-approval-per-packet constraint, cross-evidence guard, and immutable
update/delete triggers. Confirm the table is empty, foreign-key checks are
empty, and its table-scoped `PRAGMA quick_check` is `ok`. Retain a new
pre-`0064` Time Travel bookmark. The migration is additive and records only a
staging owner handoff; do not apply it to production or activate any redirect
as part of this exercise.

### 0065 — Launch-show author

For migration `0065`, confirm the existing Ópera en la Selva author is exactly
the legacy `Dust Wave` fallback before applying it. Afterward, confirm the
author is `Jay Renteria`, `PRAGMA foreign_key_check` is empty, and the public
show API plus RSS `<itunes:author>` agree. The guarded update must leave any
other show and any already-customized Ópera author untouched. Production
application, if still pending, requires its own explicit promotion
decision after verifying the current migration list.

### 0089 — Show creation and deletion

For migration `0089`, create a disposable show only in a fresh local database
and verify the insert automatically creates one distribution row per current
destination plus one audio-QC policy, transcription setting, and publication
evidence version. Replay the same creation request and verify that neither the
show nor its `show.created` audit duplicates. Do not exercise the production
creation endpoint as a deployment probe: show identity is permanent, even
while the show remains private and `coming_soon`.

Delete that same local disposable shell with the exact `DELETE_SHOW {slug}`
confirmation. Verify the show and untouched default rows are gone, exactly one
`show.deleted` audit remains, and `deleted_show_identities` permanently retains
the show ID, slug, feed slug, Podcast GUID, and both opaque request IDs without
PII. Replay the deletion and confirm no duplicate audit. Confirm both the old
creation request and a new creation request using the retired slug fail closed.
Then repeat with an isolated episode and a queue dead-letter incident and
verify both blocker categories preserve the show. Do not use remote staging or
production content to test deletion; archive any show with real history.

The [RSS import exercise](STAGING_ACCEPTANCE.md#rss-import-and-manual-cutover)
owns the complete preview, private copy, reconciliation, and manual-cutover sequence.

## Automation and Launch Lab

| Migration | Validation owner |
|---|---|
| `0067` | [Processor dispatch verification](PROCESSOR_DISPATCH_AUTOMATION.md#verification) |
| `0068` | [Queue failure verification](QUEUE_FAILURE_AUTOMATION.md#verification) |
| `0069`, `0072` | [Admin review notifications](STAGING_ACCEPTANCE.md#admin-review-notifications) and the rollback constraints below |
| `0080`, `0083–0088` | [Launch Lab setup, lifecycle, recovery, and cleanup](LAUNCH_LAB_RUNBOOK.md) |

### 0081 — Stripe event ordering

Migration `0081` adds content-minimal provider-event ordering to each Stripe
entitlement source. Replay all migrations from zero, run the signed webhook
lifecycle test, and confirm checkout, monthly renewal, payment failure and
recovery, cancellation, Pool overlap, duplicate delivery, delayed delivery,
and same-second delivery leave the newest Stripe state authoritative with
clean foreign keys. A signed `charge.refunded` fixture is intentionally
journaled as ignored until a refund-access policy is approved; it must not
revoke or extend access implicitly.

### 0082 — Entitlement expiry

Migration `0082` adds partial indexes for bounded entitlement-expiry scans.
Replay the Pool lifecycle test against every migration from zero and confirm a
signed grant/replay and authenticated redemption/replay, Stripe overlap,
private-feed rotation, scheduled expiry, interrupted-pass recovery, and signed
revocation all finish with clean foreign keys and no raw email, code, or bearer
token persisted.

## Rollback constraints

Apply the [general rollback sequence](STAGING_RUNBOOK.md#7-rollback) first.
Keep these constraints with the affected migration review.

- A Worker-code rollback after migration `0020` is safe because the new partial
  unique index is additive. Do not drop it during rollback; it preserves the
  one-active-feed invariant.
- A Worker-code rollback after migration `0026` is also safe because the new
  notification table/index is additive. Leave it in place; older code neither
  reads it nor implies consent from its presence.
- A Worker-code rollback after migration `0052` must leave delivery job/part
  tables and triggers in place. They preserve immutable evidence and prevent
  older/manual delivery audio from silently replacing a current-master render.
- A Worker-code rollback after migration `0056` must leave the execution/item
  tables and triggers in place. They retain copy/draft evidence, prevent
  identity edits or cancellation races, and let operators reconcile any
  private object before a later forward deployment. Disable
  `RSS_IMPORT_EXECUTION_MODE` and pause affected Queue work before rollback.
- A Worker-code rollback after migration `0057` must leave the reconciliation
  table, immutable triggers, and execution/item locks in place. They preserve
  approved evidence; older code does not read it and must not try to rewrite
  reconciled execution rows.
- A Worker-code rollback after migration `0058` must leave the immutable
  redirect-attestation table and triggers in place. Older code ignores the
  hash-only evidence; it does not authorize activation.
- A Worker-code rollback after migration `0059` must leave the immutable
  cutover-packet table and triggers in place. Older code ignores the packet;
  it cannot activate a redirect or authorize a provider action.
- A Worker-code rollback after migration `0069` must leave the content-free
  admin action ledger in place. Disable `ADMIN_ACTION_NOTIFICATION_MODE` first;
  older code ignores the additive table and cannot issue a link from it.
