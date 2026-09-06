# Staging acceptance exercises

Audience: maintainers and operators validating the behavior affected by a release.

Start with the [staging runbook](STAGING_RUNBOOK.md) for deployment order and
credential configuration, then select the relevant exercises below. These are
procedures, not a claim that a feature or provider is currently accepted. Use
isolated fixtures and preserve each exercise's rights, review, mode, and cleanup
requirements. Production remains outside this staging runbook.

[Migration validation](MIGRATION_VALIDATION.md) owns schema checks;
[Launch Lab](LAUNCH_LAB_RUNBOOK.md) owns recurring isolated provider rehearsals;
[user flows](USER_FLOWS.md) owns cross-repository regression coverage. API,
security, and media gate documents retain their respective contracts.

## Choose an exercise

- [Smoke checklist](#smoke-checklist)
- [Media pipeline](#media-pipeline)
- [Editorial workflow](#editorial-workflow)
- [Show settings](#show-settings)
- [RSS import and manual cutover](#rss-import-and-manual-cutover)
- [Billing and Pool](#billing-and-pool)
- [External publication](#external-publication)
- [Historical observations](#historical-observations)

## Smoke checklist

Verify:

- credentialed `OPTIONS /v1/admin/session` from
  `https://dust-wave-website-staging.pages.dev` reflects that exact origin,
  while the production Dust Wave origins, Pages preview hostnames, and an
  unrelated origin receive no `Access-Control-Allow-Origin`;
- `/health`, `/v1/shows`, the configured show, and an empty valid RSS feed;
- unauthenticated admin routes return private `401` responses;
- unknown login emails receive the same response as known emails;
- a known super-admin completes the configured staging login protection,
  Resend, exchange, session, and logout; the explicit staging-only Admin
  Turnstile exception does not change listener/Checkout or production policy;
- a staged audio upload uses the returned 8 MiB recommendation, completes,
  serves a byte range, and downloads; every non-final part remains at least
  R2's 5 MiB minimum;
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
  test, signed grant/retry/redeem/revoke behavior matches the [Pool sequence](#pool-supporter-benefits)
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

## Media pipeline

### Source audio QC

Queue the current source from the staging Admin Production tools and let the
existing dispatcher start QC. Only for an audited dispatcher recovery, use the
reviewed default-branch workflow and exact queued ID:

```sh
gh workflow run process-audio-qc.yml \
  --ref main \
  -f run_id="qc_REPLACE_WITH_QUEUED_ID"
```

Before claiming evidence, confirm the workflow fetched the exact private
manifest/source through signed Worker routes, fully decoded the source,
retained only `callback.json`, and returned a report whose source, manifest,
and report hashes match D1. Refresh Production and verify bounded findings,
policy revision, and resource/version evidence. Change the current source ETag
or policy revision and confirm a new run is required. Never upload a fabricated
episode to shared staging merely to make this path green.

### Working master and enhancement

After a real zero-blocker current QC run exists, approve the exact source from
the Production tab with a bounded reason and acknowledgement. Confirm a stale
`baseRevision` is `409`, non-Super-admin approval is `403`, the response/audit
contains hashes but no object key or reason text, and readiness changes from a
missing to ready `core.working_master` node.

Queue one bounded A/B preview and dispatch:

```sh
gh workflow run process-audio-enhancement-preview.yml \
  --ref main \
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
  --ref main \
  -f job_id="derivative_REPLACE_WITH_QUEUED_ID"
```

The render job must finish multipart upload and return the derivative QC run
ID; the called QC job must then finish against that exact output. Confirm the
successful artifact contains only `processor-evidence.json` and no object key,
source, rendered audio, callback body, or FFmpeg log. If the R2 multipart
object completed but the final Worker evidence request did not, the processor
must leave the job `completing` instead of reporting a false render failure.
That exceptional artifact may retain only the bounded manifest and signed
callback alongside `processor-evidence.json`; it must never retain audio.
After the transient or contract issue is fixed, download those two private
files and replay them without rerendering:

```sh
DERIVATIVE_ID="derivative_REPLACE_WITH_QUEUED_ID" \
MEDIA_PROCESSOR_CALLBACK_SECRET="REDACTED" \
node scripts/replay-audio-enhancement-derivative-completion.mjs
```

The replay validates both retained contracts, accepts only the isolated
staging host/bucket, removes the manifest/callback after success, and must be
idempotent. In the workbench, confirm authenticated full-file range
playback/download, current-policy and digest-match indicators, and that the
promote and reject forms appear only to a recently authenticated Super-admin
after zero-blocker QC.

Exercise both terminal choices against separate disposable candidates:

- Promote with the exact displayed base revision and a bounded operational
  reason. Confirm the response creates an `enhanced_derivative` master at the
  next revision, the derivative becomes approved, other active derivatives
  become stale, and transcript/chapter/clip approvals are invalidated through
  the existing master triggers.
- Reject with the exact displayed base revision, a 10–500 character reason,
  and the exact-derivative acknowledgement. Confirm the API presents the
  candidate as `rejected`, the working-master ID and revision are unchanged,
  the private R2 object and QC row remain, immutable rejection evidence and
  one privacy-minimized audit event exist, and a fresh candidate can be
  queued for the same selected preview/master pair.

Repeat each terminal request with an authentication older than 15 minutes,
stale revision, changed current master, mismatched output SHA, old QC-policy
revision, and non-Super-admin session; each must fail closed without a master
change or audit row. A same-reason rejection retry must be idempotent.
Anonymous derivative media is `401`; production queue, processor, and object
state remain untouched.

### Delivery audio and player peaks

With the final working master selected, allow the next five-minute scheduler
run to create Delivery audio and player waveform automatically. Confirm one
`delivery_audio_auto_…` job and one `delivery_audio.queued` audit event with a
null admin actor, `automated: true`, and attempt `1`. The existing processor
dispatcher must claim that same manifest without a manual GitHub action. A
second scheduler run must create neither another multipart upload nor another
active job.

The Production-tab queue action and the following workflow dispatch remain a
recovery-only staging path if scheduler/dispatcher diagnosis requires an
explicit fixture:

```sh
gh workflow run process-delivery-audio.yml \
  --ref main \
  -f job_id="delivery_audio_REPLACE_WITH_QUEUED_ID"
```

After a terminal processor failure, confirm a later scheduler run derives a
new attempt ID and never exceeds three automatic attempts for the same
episode/master/profile. Active, ready, or approved work must suppress retries.
Production must read neither D1 nor R2 and keeps its processor routes at `404`.

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

### Admin review notifications

With `ADMIN_ACTION_NOTIFICATION_MODE=live`, install `PODCAST_ACTION_EMAIL` as
a staging Worker secret containing an existing Super-admin address. Keep the
raw address out of D1, logs, screenshots, and this repository. The next
five-minute trigger discovers the same exact ready/QC evidence, creates one
content-free `admin_action_notifications` row, and sends a bilingual Resend
link to `?show=...&episode=...&step=media&target=working_master`. After that
decision, the same ledger must create only the actions that become ready:
`target=delivery_audio` for the normalized player asset and
`step=transcript&target=transcript_review` for the exact initial transcript
revision. After an exact alignment result and matching private bilingual
benchmark become approval-ready, the same ledger may add only
`step=transcript&target=alignment`. Migration `0072` must preserve every
existing action row before this fourth kind is enabled. Confirm:

- one accepted request uses `podcast-admin-action/<action-digest>` as its
  idempotency key and a 15-minute single-use magic link;
- repeated scheduled runs do not send a second accepted message;
- the link selects the expected show/episode and focuses Working master without
  horizontal overflow at phone, tablet, and desktop sizes;
- non-Super-admin or unknown recipient setup fails closed without disclosing
  whether an account exists;
- three provider failures reuse byte-identical content and end in `failed`;
- promote/reject, current-master change, QC-policy drift, transcript drift, or
  benchmark drift moves the applicable row to `resolved`; alignment approval
  resolves its reminder in the same atomic batch; and
- D1 contains no email, usable token, login URL, media key, transcript, or
  provider response body.

Production keeps `ADMIN_ACTION_NOTIFICATION_MODE=disabled`; do not install its
recipient secret or enable the mode during this staging exercise.

### Private clip rendering

The clip workflow does not need a Cloudflare API token, account ID, or R2
access key. Its purpose-bound source and output routes stream through the
staging Worker's private R2 binding. The workflow file must exist on the
default branch before GitHub accepts a dispatch. Queue one render in the
authenticated staging clip workbench and let the automatic dispatcher claim it.
Only for an audited dispatcher recovery, run:

```sh
gh workflow run process-clip-render.yml \
  --ref main \
  -f render_id=clip_render_example
```

Confirm the report artifact contains only callback/failure/upload evidence,
never the source MP3, manifest/captions, raster frames, or MP4. Follow
[CLIP_RENDER_GATE.md](CLIP_RENDER_GATE.md) for the acceptance and rollback matrix.

For a ready render, use both Production and Marketing to download its WebVTT
and SubRip sidecars. Confirm `text/vtt` and `application/x-subrip` respectively,
attachment-only private/no-store/noindex delivery, and relative timestamps
beginning at `00:00:00.000` or `00:00:00,000`. Compare both sets of cues and
confirmed speaker labels with the burned captions. Then change the approved
transcript digest, source ETag, stored manifest digest, and output checksum one
at a time in a disposable fixture; each change must fail closed without
returning caption text. An out-of-scope Analyst must receive the same private
`404` before either R2 object is read.

### Virtual-audio evidence

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

Set `MEDIA_PROCESSOR_CALLBACK_SECRET` in the process environment. The wrapper
creates and deletes its exact D1 lease through the staging-only signed gate
endpoint and uploads fixtures only through the capability-bound Worker R2
binding. It must not receive a Cloudflare account/API token. The protected
`Refresh staging virtual-audio evidence` workflow runs this command every
three days with `--publish-evidence`, retains redacted aggregate artifacts for
30 days, and writes the successful current-source result to
`virtual_audio_gate_runs`.

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

The [virtual-audio gate](VIRTUAL_AUDIO_GATE.md) owns protocol/client
acceptance and evidence thresholds. Use the existing protected refresh workflow
described there to retain current-source evidence; dated measurements are in the
[historical appendix](#historical-observations).

Use only the purpose-bound staging callback secret for routine gate runs.
Cloudflare account credentials remain limited to recovery inspection and
deployment; do not copy a broader Pool or Store token into this workflow.

### Public clip withdrawal and canonical-page gate

Keep `CLIP_PUBLICATION_MODE=staging_preview` and use only a disposable staging
episode whose canonical URL has the exact
`/news/podcasts/{showSlug}/{episodeSlug}/` shape. Production stays disabled.

Before using a real media object, run the repository contracts:

```sh
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
```

The public clip tests must prove all of the following:

- approved metadata returns a strong content ETag with `public, max-age=0,
  must-revalidate`, and an unchanged conditional request returns `304`;
- the range-safe MP4 uses the same revalidation policy, canonical `Link`
  ownership points to the episode News page, and object identity/checksums are
  absent from public JSON;
- after recent-Super-admin withdrawal, the same conditional metadata request
  returns a new ETag and an empty clip selection instead of stale `304`;
- the withdrawn MP4 returns no-store `404` without another R2 object read;
- the website consumer renders with `preload="none"`, first-party canonical
  share/download URLs, DOM text assignment, and at least 44 px controls;
- at a 320 px device-width exercise, the card and every action remain within
  the document width, the actions stack with intentional gaps, the copy status
  occupies its own row, and `scrollWidth` equals `clientWidth`;
- replaying the consumer with the empty metadata response leaves the whole
  clip region hidden, clears its children, and records the local `empty`
  state.

The deterministic local browser fixture uses
`PODCAST_ADMIN_MOCK_PUBLIC_CLIPS=ready|empty|missing`; it must never be
published as an episode or copied to R2.

### Public clip preview before upload

Before any external clip upload, exercise the first-party public clip preview:

1. Prepare one current ready render with a lowercase public slug, bounded
   title/description, and exact expected clip revision. Confirm the draft
   stores no new R2 object and returns no object key, ETag, or digest.
2. With the episode still scheduled, have a recently authenticated
   super-admin approve it. Confirm metadata/media remain `404` before the
   public release time.
3. On an isolated published/due fixture, confirm the metadata ETag, wildcard
   CORS, canonical News URL, responsive browser playback, `HEAD`, download,
   valid single/suffix ranges, invalid multi-range `416`, and exact R2
   checksum/manifest evidence.
4. Change the clip revision and confirm the old selection becomes unavailable
   before R2. Restore the fixture, create a new selection, then withdraw it
   and confirm origin `404` plus CDN revalidation within the documented
   one-minute bound.
5. Restore/delete only the isolated fixture state. Do not change production
   `CLIP_PUBLICATION_MODE`, DNS, routes, or media bindings.

### Direct-sponsor enclosure exercise

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

## Editorial workflow

### Transcription and review quality

After the enhanced-master decision is final, allow the next five-minute
scheduler run to create any missing source-language transcription job. Direct
jobs must enter the existing Queue once; masters larger than 16 MiB must create
one immutable chunk run and let the normalized processor dispatcher claim it.
A second scheduler run must be idempotent. The Admin queue control and the
following workflow command are recovery-only staging paths:

```sh
gh workflow run process-transcription-chunks.yml \
  --ref main \
  -f run_id="transcription_chunks_REPLACE_WITH_QUEUED_ID"
```

GitHub accepts a recovery dispatch only after the workflow file exists on the
repository's default branch, even when `--ref` selects the reviewed release
branch for the run. Before queueing a billable long-source rehearsal, verify
that `process-transcription-chunks.yml` appears in the repository Actions
workflow list. If the immutable staging job was already queued while the
workflow still exists only on the release branch, leave that exact job queued,
merge through the reviewed release process, and dispatch its displayed run ID
afterward. Do not create a replacement job, copy an Actions environment secret
into a local file, or write processor state directly into D1.

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

Before human transcript approval, exercise the review-only browser quality
panel against a synthetic large draft. Build `dust-wave-new` against the local
Podcast mock API, start that API with
`PODCAST_ADMIN_MOCK_TRANSCRIPT_CUES=1300`, and use its dependency-free Chrome
tracer with `--admin-tab production` at both 1440×900 and 390×844. Confirm:

- the Production tab is selected and verified rather than inferred from a
  stored preference;
- the summary counts all 1,300 cues but never includes transcript text;
- invalid timing, under-0.5-second, over-10-second, over-25-visible-characters-
  per-second, and speaker-confirmation cards contain bounded counts and a
  button that opens the first matching cue;
- cue navigation changes to the correct 100-cue page, scrolls the exact stable
  cue ID into view, and places keyboard focus on its start-time field;
- the Spanish mobile tab control remains synchronized with Production, every
  diagnostic card fits the viewport, and the document has no horizontal
  overflow;
- no enforced CSP violation or browser console error occurs; and
- the main unminified admin module remains within its existing 304,000-byte
  ceiling, the isolated transcript-review module remains within 12,000 bytes,
  and the diagnostic-navigation controller remains within 7,000 bytes.

The review panel is an editing aid only. Do not treat its local product
thresholds as a transcript approval, accessibility certification,
word-alignment result, or substitute for listening. It must not add a Worker
request, D1 write, analytics event, browser storage entry, transcript export,
or provider action.

### AI show notes

Complete the [0071 schema checks](MIGRATION_VALIDATION.md#0071--show-notes-proposals)
before the corresponding staging deployment.

For the separate AI show-notes review aid, first use the local admin mock so
no model call or durable write occurs. Edit the fixture episode, generate an
English and Spanish draft, and confirm the review card reports the exact
language, revision, cue coverage, summary, Markdown, and keywords. Confirm
there is no HTML sink, horizontal overflow, console error, or episode PATCH.
With existing notes present, cancel the replacement confirmation and verify
the WYSIWYG is unchanged. Accept it and verify only the unsaved editor changes;
the normal Update draft button remains the sole persistence path.

Then deploy the exact Worker commit to staging only. Use a disposable transcript
in `needs_review`; its request must fail closed
with `show_notes_approved_transcript_required` and must not call Workers AI.
After a human separately approves a suitable transcript, generate no more than
one controlled manual draft and verify:

- the response is private/no-store and reports `reviewRequired: true`,
  `saved: false`, exact revision/digest, and full or partial cue coverage;
- audit metadata includes languages, revision/digest, counts, model, bounded
  usage, and result only—never transcript, prompt, provider response, or draft;
- six requests per admin/episode/hour are allowed and the seventh returns a
  private `429` with `Retry-After: 3600`;
- no episode, media, News, RSS, YouTube, directory, subscriber, ad, billing, or
  publication row changes; and
- the production bundle retains `SHOW_NOTES_AI_ENABLED=false`.

At the next five-minute boundary, automatic discovery may create proposals for
the approved transcript language and the show language when different. Verify
only aggregate evidence: one ready row per exact input fingerprint, no active
expired lease, attempt count at most three, and one system completion audit per
new ready row. A second boundary must create no duplicate row or audit. The
Admin should load the newest ready proposal automatically, leave the WYSIWYG
unchanged, keep manual regeneration collapsed, and remain responsive at 320,
768, and 1440 CSS pixels. Invalid provider output must move only that proposal
to `failed`; retries reuse the same row and stop at attempt three. No episode,
News, RSS, YouTube, distribution, media, billing, ad, or subscriber row may
change.

### AI chapter proposals

Complete the [0073 schema checks](MIGRATION_VALIDATION.md#0073--chapter-proposals)
before the corresponding staging deployment.

Exercise the companion chapter assistant first against the local mock. Select
the same episode in Production, generate English and Spanish proposals, and
confirm the evidence reports the exact approved revision and all reviewed
cues. Titles must render as text; no `PUT /chapters` may occur until the
operator separately chooses Save review draft. Cancel replacement with
existing rows and confirm they remain unchanged; accept it and confirm only
the unsaved rows change. Verify 320 px layout, 44 px actions, no horizontal
overflow, console error, or CSP violation.

On staging, the real `needs_review` transcript must return
`chapter_draft_approved_transcript_required` without a model call. After
separate human approval, one controlled request must prove private/no-store,
`reviewRequired: true`, `saved: false`, complete cue counts, content-free
request/completion audits, no chapter revision/approval write, and the
separate six-request rate limit. A transcript over 48,000 prompt characters
must return `chapter_draft_full_transcript_required` before an audit claim.
The production dry bundle must retain `CHAPTER_DRAFT_AI_ENABLED=false`.

After an exact transcript has separately passed human alignment review, the
next five-minute staging boundary may create at most one chapter proposal per
output language and exact input fingerprint. Verify that every row pins the
current master, transcript revision/digest, and passed alignment revision;
attempts never exceed three; expired leases recover in place; and system audit
metadata contains only identifiers, digests, counts, model/version, usage, and
error class. A second boundary must not duplicate the row or audit. The Admin
must load but not apply the newest proposal, and saving/approving the chapter
set must remain separate explicit actions. Before any qualifying alignment,
the scheduler must create zero chapter rows, audits, or model calls.

### AI clip proposals

Complete the [0074 schema checks](MIGRATION_VALIDATION.md#0074--clip-proposals)
before the corresponding staging deployment.

Exercise the social clip-candidate assistant against the local mock with
`PODCAST_ADMIN_MOCK_TRANSCRIPT_CUES=24` and
`PODCAST_ADMIN_MOCK_TRANSCRIPT_APPROVED=true`. Generate English and Spanish
candidates and confirm the review evidence reports the exact approved
revision, digest, and all reviewed cues. Candidate text must use DOM text
nodes. Cancel replacement over populated fields and verify the recipe is
unchanged; accept one candidate and verify only the unsaved title and exact
start/end cue fields change. No clip PUT, render request, approval, publication,
or provider action may occur until its separate existing control is used.
Verify 320 px layout, 44 px actions, no horizontal overflow, console error, or
CSP violation.

On staging, the real `needs_review` transcript must return
`clip_draft_approved_transcript_required` without a model call. After separate
human approval, one controlled request must prove private/no-store,
`reviewRequired: true`, `saved: false`, complete cue counts, 15–90 second
server-derived non-overlapping ranges, content-free request/completion audits,
no clip/revision/render/publication write, and the separate six-request rate
limit. Oversized complete input must fail before the claim with
`clip_draft_full_transcript_required`. The production dry bundle must retain
`CLIP_DRAFT_AI_ENABLED=false`.

After an exact transcript separately passes human alignment review, the next
five-minute staging boundary may create at most one clip proposal per output
language and exact fingerprint. Verify current master, transcript
revision/digest, passed alignment revision, episode-copy digest, three-attempt
ceiling, lease recovery, and content-free system audits. A second boundary
must not duplicate the proposal or audit. The Admin must load but not apply the
newest proposal; clip save, alignment, render, approval, public publication,
and YouTube remain separate explicit actions. Before any qualifying alignment,
the scheduler must create zero clip proposals, audits, or model calls.

### Saved captions, import, search, and quality navigation

On that saved synthetic transcript, download both WebVTT and SubRip from the
Production workbench in English and Spanish. Confirm the filenames identify
language and revision, the response exposes that same revision, timestamps and
cue text match the last saved state, and an unconfirmed speaker label is
omitted. Make an unsaved browser edit and confirm both files remain unchanged;
save a new revision and confirm both advance together. Re-run with a mismatched
D1 content digest and verify no caption text returns. At 320 CSS pixels, both
localized actions must retain at least 44 px height, wrap without horizontal
overflow, and produce no console or CSP error.

Import those two saved formats back into a disposable review draft. Confirm
the browser performs no API request during file reading, explicit WebVTT voice
labels enter as unconfirmed, an SRT speaker-looking prefix remains caption
text, line breaks normalize without HTML execution, and the existing saved
revision remains unchanged until the ordinary Save action. Existing or unsaved
work must require replacement confirmation. Empty, malformed, overlapping,
out-of-order, over-two-minute, past-episode, over-10,000-cue, and normalized
over-1-MB fixtures must fail without changing the editor. Exercise English and
Spanish at 320 CSS pixels; the file field and action must retain the shared
44 px control height with no horizontal overflow, console error, or CSP
violation.

On that imported or synthetic draft, use local transcript search for caption
text and public speaker labels on different cue pages. Confirm English/Spanish
case and accent folding, ordered Previous/Next navigation, cue-range status,
and focus on the matched cue through the existing paginated editor. A
Markdown link label may match but its hidden destination must not. Empty,
over-160-character, and over-10,000-cue searches must fail locally without a
request, storage write, cue mutation, dirty-state change, or approval-state
change. Changing episode or transcript language must clear prior query and
results. Exercise both locales at 320 CSS pixels; the input and all three
actions must retain at least 44 px height, stack without horizontal overflow,
and produce no console or CSP error.

On the same loaded draft, exercise every transcript quality category with more
than one matching cue. Confirm the category exposes one labeled control group
with previous, open/current, and next actions; the endpoints disable rather
than wrap; the visible and accessible position uses the selected cue and total;
and the selected issue survives a transition between the first and second
100-cue pages. Each action must reuse the existing paginated cue focus path.
Fix one flagged value locally and confirm the next render either preserves the
same cue when it still matches or returns to the first remaining match. The
navigation may retain only bounded cue indexes in browser memory: no caption
text, API request, storage write, dirty-state change, save, or approval may be
introduced by navigation alone. Repeat in English and Spanish at 320 CSS
pixels; each action must remain at least 44 px high with no horizontal
overflow, inaccessible name, CSP violation, or console/page error.

### Unsaved edits and speaker ranges

Create unsaved transcript and chapter edits without saving. For each relevant
show, episode, transcript-language, and chapter selector, decline the bilingual
discard prompt and confirm the prior value and draft remain unchanged with no
load or write request. Accept the prompt and confirm only the affected local
draft is discarded before the ordinary read loader runs. Repeat with Logout,
then dispatch a cancelable `beforeunload` event and verify it is prevented while
either draft is dirty and not prevented after both drafts are saved or
discarded. Exercise English and Spanish at 320 CSS pixels with no overflow,
console error, duplicate confirmation, or inaccessible control.
Before editing, confirm both visible Save review draft actions report
`data-dirty-state="clean"` and are disabled. Edit one transcript cue and one
chapter independently; only the corresponding action may become enabled,
`is-dirty`, and `data-dirty-state="dirty"`. A successful save must restore the
clean disabled state, while a rejected save must preserve the dirty enabled
state so the producer can retry.

On the same synthetic draft, exercise the separate speaker-range aid on the
first and second 100-cue pages in English and Spanish. Confirm its minimum and
maximum follow only the currently rendered page, neighboring cues remain
unchanged, and the unchecked path applies an unconfirmed label. The checked
path must require the editor's explicit exact-range acknowledgement, mark the
draft dirty, and keep approval disabled. The aid must dispatch through the
existing cue inputs, make no request itself, and preserve every cue ID,
caption, and timestamp. At 320 CSS pixels, text and action controls must remain
44 px high, the checkbox label must remain a comfortable full-row target, and
there must be no horizontal overflow, CSP violation, or console/page error.

### Word alignment and private benchmarks

After either reviewed transcript language and an exact final working master
exist, wait through one staging schedule boundary. The Worker should queue the
exact alignment automatically and the durable processor dispatcher should
claim it without an Admin click or CLI dispatch. Use the following only as an
audited break-glass recovery from a dispatcher outage, with the displayed job
ID and reviewed default-branch source:

```sh
gh workflow run process-alignment.yml \
  --ref main \
  -f job_id="alignment_job_REPLACE_WITH_QUEUED_ID"
```

Before dispatch, confirm the parent alignment gitlink is
`32111c2a8dd62d891c4309f7638a86c31a789dc3`, containing the private
benchmark-bundle assembler. The API must
display execution revision
`e611801d2af82dcdb079444b7e8a7eea4309d1a6`; the workflow must validate that
constant, verify the expected GitHub remote, and detach the submodule at that
exact content-addressed commit before installing an adapter. The repository
secret must still be only `MEDIA_PROCESSOR_CALLBACK_SECRET`. The run must use
Ubuntu 24.04, install the selected adapter from that execution revision's
committed `uv.lock`, fetch the exact signed manifest/source, and retain only
content-free evidence. Confirm the source audio, transcript projection, raw
result, and callback are absent from artifacts and logs.

Refresh the workbench and verify the job reaches `ready` while the alignment
revision stops at `needs_review`. Check every stored word belongs to the exact
revision and has stable position/cue identity; invalid/interpolated/omitted
words must not be structurally eligible. Replay the same callback and queue
request and confirm no duplicate word rows or new billable job. Force one
bounded retryable failure and confirm the same job reopens; force five claimed
attempts and confirm the sixth claim fails closed. Change the transcript or
working master and confirm the original job becomes stale.

For an explicitly approved private source, prepare candidate corpus windows
locally before any transcript or alignment work. The output directory must not
already exist, all media and references remain outside Git, and the rights
record must identify the actual approval rather than inferring it from a public
URL:

```sh
npm run prepare:alignment-benchmark-source -- \
  --audio /private/source.m4a \
  --reference /private/source.es-orig.json3 \
  --output /private/alignment-benchmark/source-id/candidates \
  --source-id source-id \
  --language es \
  --source-url https://www.youtube.com/watch?v=source-id \
  --source-title "Approved interview" \
  --rights-approved-by "Approver" \
  --rights-approved-at YYYY-MM-DD
```

The command reports only aggregate counts, paths, and hashes. Inspect the
private inventory and independently review/correct the transcript before
creating runner requests. A successful preparation is sourcing evidence, not
an H1 pass.

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

### Publication readiness

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

### Public transcript and chapter projections

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

## Show settings

Also exercise the separate Settings tab in English and Spanish. Confirm the
responsive tab controller exposes and selects Settings, the selected show is
synchronized with the Episodes selector, exactly one show-settings form is
present, and changing the tab performs no save. Exercise primary language,
lifecycle, author, category, artwork, explicit-content policy, premium, free
mini-episode, early-access, and YouTube values through the existing show
update route. Confirm canonical-page and RSS inputs are read-only and absent
from the update payload. Entering archived from another lifecycle must raise a
localized confirmation before any request. At 320 CSS pixels, every text, URL,
number, textarea, checkbox, select, and save control must remain inside the
panel; text/select controls and the save button must retain at least 44 px
height, and document `scrollWidth` must equal `clientWidth`.

Repeat the URL checks with the browser constraint disabled or by calling the
staging API directly: HTTP artwork, credential-bearing artwork, a non-YouTube
channel host, and a YouTube watch URL must each return private/no-store `400`
without an `UPDATE shows` or audit insert. Clearing either optional URL should
store `NULL`. A canonical `https://www.youtube.com/@handle` channel and
credential-free HTTPS artwork should save through the existing audited
mutation.

As a Super-admin, load the separate Podcast Premium price card in Settings
and confirm it reports the current $5 monthly / $50 annual USD pair and
matching Stripe test readiness without exposing either provider Price ID.
At 320 CSS pixels, both decimal inputs, the confirmation field, and the action
must remain within the panel at a minimum 44 px control height. Reject
fractional cents, an annual price below the monthly price, and an annual price
without a discount. A stale expected pair must change neither row nor audit.
With checkout disabled and no billing history, an isolated changed-price
fixture must update both expected rows atomically, clear only the changed
row's provider link, and insert one audit. Never change the actual launch pair
merely to exercise staging; use an isolated local fixture. Checkout enabled,
any subscription, or any checkout attempt must lock the mutation. Stripe must
receive no request from this boundary.

In Settings, preview the site projection for the selected show. Confirm the
configured owner/repository/ref/path, Git blob SHA, changed Worker-owned
fields, and an empty blocker list. Verify local artwork variants, wordmark,
social card, source link, benefit copy, episode override policy, and episode
fallback remain byte-for-byte unchanged in the projected show. A stale SHA
must return private/no-store `409`; a missing premium monthly or annual USD
price and a missing local presentation asset must each block. In staging,
submit the exact typed confirmation after recent Super-admin authentication:
the response must report `dryRun: true`, create only an audit event, and make
no GitHub `PUT`. Do not enable live mode until the reviewed branch and Pages
build gate are both approved.

## RSS import and manual cutover

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
6. Select one to 25 migration-ready items and prepare an immutable plan.
   Confirm the response says `mediaCopyPerformed: false` and
   `episodeMutationPerformed: false`, D1 contains no query-bearing source URL,
   and episode/R2 counts remain unchanged.
7. Re-enter the exact source feed URL, explicitly confirm the immutable
   selection, and review it. Change one feed byte in a local/mock fixture and
   confirm review returns `409` while the plan stays `draft`; then restore the
   exact feed and confirm review succeeds without episode/R2 mutation.
8. Cancel an isolated fixture with a unique internal phrase; confirm the raw
   phrase is absent from plan and audit rows while its purpose-bound digest is
   present. Confirm plan/item evidence cannot be edited or deleted.
9. Before an execution test, capture a new staging Time Travel bookmark and
   record episode, upload, import-execution, publication-job, distribution-job,
   and R2-prefix counts. Use only a rights-cleared, tightly bounded fixture
   whose reviewed enclosure bytes and MIME type are known.
10. Re-enter the exact feed, map every selected identity once to a unique
    show-local slug and `en`/`es` source language, explicitly confirm the
    private copy, and queue it. Confirm Queue contains no URL or source token.
11. Confirm the stream copied the exact reviewed byte count into the private
    `source_audio` prefix, stored SHA-256/R2 ETag evidence, created exactly one
    `draft`/`processing` episode and completed source upload per successful
    item, erased the sealed URL at terminal completion, and remains
    idempotent on replay.
12. Confirm publication, News, RSS, distribution, YouTube, announcement, ad,
    billing, and redirect counts did not change. Confirm an enclosure
    byte/MIME drift fixture fails closed without an episode and a production-
    mode request returns unavailable before D1, Queue, or R2 mutation.
13. Do not configure a new-feed tag or old-host 301 redirect. Working-master
    review, publication, and the redirect checklist remain separate approval
    gates.
14. Load reconciliation evidence. Confirm the Worker rechecks the exact
    execution/item counts, draft ID/slug/GUID/language/canonical URL, completed
    source upload, private R2 size/ETag/content type/purpose metadata, and
    zero-delivery/News/RSS/directory publication state without exposing the
    source URL or private object key.
15. Tamper one isolated fixture's R2 metadata and confirm approval fails. Put
    the exact fixture back, reload the digest, approve it as a recently
    authenticated super-admin, and replay the same identifier/digest to
    confirm idempotency. Confirm another identifier or digest conflicts and
    direct execution/item updates are locked.
16. Confirm approval changes only the immutable reconciliation/audit rows.
    `r2MutationPerformed`, `episodeMutationPerformed`,
    `publicationMutationPerformed`, `redirectMutationPerformed`, and
    `providerContactPerformed` must all remain `false`.
17. Confirm the old-host checklist says activation is unavailable and remains
    blocked on imported episodes becoming public, canonical-feed validation
    after their latest update, renewed 10+ directory certification, and an
    explicit owner redirect attestation. On an isolated rights-cleared fixture
    only, re-enter the exact old feed, record the selected supported method,
    and confirm raw signed URLs and credentials are absent, exact replay is
    idempotent, semantic duplication conflicts, and direct update/delete fail.
    Do not attest the current Ópera en la Selva negative fixture and do not
    activate a redirect in this staging exercise.
18. On an isolated synthetic fixture only, make every imported current
    revision publicly due with ready delivery audio, and record successful
    current-revision RSS, canonical-News job, and site-publication evidence.
    Validate the exact canonical feed afterward. Confirm any stale revision,
    pending News/site state, mismatched feed URL, or older validation blocks
    the cutover packet.
19. Give ten enabled fixture destinations verified owner setup, immutable
    failed-to-observed recovery evidence, and a new observed event after that
    feed validation. Confirm nine re-observations remain blocked, an
    observation before validation remains blocked, and the exact ten become
    ready without contacting a directory.
20. As a recently authenticated Super-admin, freeze the exact cutover digest.
    Confirm exact replay is idempotent, another identifier conflicts, direct
    update/delete fails, and a later show/episode evidence change marks the
    packet stale. Confirm only the packet/audit rows change and all R2,
    episode, publication, redirect, provider, email, ad, and billing mutation
    flags remain false. Never configure a new-feed tag, HTTP 301, DNS, or
    provider setting in this exercise.
21. Re-enter the exact fresh cutover packet/digest and explicitly confirm
    final review, later manual owner action, a rollback plan, and that this
    request performs no activation. Confirm exact replay is idempotent,
    another identifier conflicts, direct update/delete fails, and a later
    show/episode/feed/directory evidence change marks both packet and approval
    stale. The response may mark the manual handoff ready but must keep
    `activationAvailable: false` and report zero R2, episode, publication,
    redirect, provider, email, ad, and billing mutations. Do not contact the
    old host or activate a redirect.

The authorized Ópera en la Selva Substack URL is useful as a negative preview
fixture while it contains newsletter article/image enclosures; it must not be
represented as source podcast audio. Re-evaluate the live feed on every run.

## Billing and Pool

### Pool supporter benefits

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
6. Issue and rotate a private feed, confirm the original bearer URL returns
   `404`, and confirm only an HMAC of the replacement token is stored.
7. Move the synthetic benefit end into the past, run the scheduled expiry
   reconciliation, and confirm the aggregate is `expired` and both member feed
   issuance and the prior bearer URL are denied. Rerun it to confirm the pass
   is idempotent.
8. Disable the bridge again and delete the synthetic Pool mapping after saving
   redacted evidence.

### Controlled Checkout

Before the first controlled Checkout:

1. Back up D1 and apply every pending migration.
2. Confirm the test Product/Prices are active and mode-matched.
3. Review `GET /v1/admin/shows/{id}/tax-policy`. If its checked-in candidate
   exactly matches the approved jurisdiction, rate, inclusive behavior,
   effective period, and source revision, submit that unchanged candidate and
   the displayed exact confirmation to `PUT` on the same path from a session
   authenticated within 15 minutes. Confirm the response reports an assigned,
   provider-ready test policy. The route creates and re-reads the manual Stripe
   Tax Rate idempotently, verifies its complete safe evidence, and commits the
   D1 policy/audit/assignment atomically; it does not enable Checkout. Stop if
   the candidate is stale or broader than the underlying Store evidence.
4. Confirm the signed webhook subscribes to `checkout.session.completed`,
   `checkout.session.expired`, `customer.updated`, the five consumed
   `customer.subscription.*` lifecycle events, and all seven invoice events
   recognized by the tax-evidence projection: `invoice.created`,
   `invoice.updated`, `invoice.finalized`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.voided`, and
   `invoice.marked_uncollectible`.
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

### Stripe test-clock boundaries

Use a Stripe sandbox test clock with billable show Prices only after an
accountant-approved staging Tax Rate exists. The isolated, tax-free Launch Lab
$1 fixture is the sole exception because it cannot enter public Checkout and
is deleted after projection evidence is captured. Exercise initial invoice,
monthly and annual renewal, address
change, same-rate replay, rate change, payment failure/recovery, cancellation,
duplicate delivery, and out-of-order events. Do not create or expire a tax
registration, activate a live Tax Rate, or enable Checkout as part of this
migration gate.

### Stripe preflight

Run the same evidence contract without copying provider output into a shell
transcript:

```sh
npm run gate:stripe:staging
```

Inspect the current structured result; dated counts belong in
[CURRENT_STATE.md](CURRENT_STATE.md). The gate exits nonzero for any
configuration/provider drift. During final promotion, require all blockers
to be gone as well:

```sh
npm run gate:stripe:staging -- --require-ready
```

The gate accepts no production selector, performs no Stripe or D1 mutation,
reads only Worker secret names, and never emits a provider key. Run it only
from the reviewed Podcast repository with authenticated test-mode Stripe and
Wrangler CLIs.

## External publication

### GitHub

Live GitHub publication targets only the release branch and requires a reviewed
fixture.

### YouTube clips and channel access

For the YouTube clip test:

The five-minute Worker scheduler checks a configured YouTube refresh grant on
a bounded cadence before any controlled test: every 12 hours after success and
hourly after failure. It uses an expiring D1 lease so overlapping cron
invocations cannot duplicate the provider read. The composed launch gate
requires a successful exact-channel check from the last 24 hours as its own
node; that node never substitutes for the separately required inspected
unlisted upload. A failed check stores only a bounded failure code. Reauthorize
the dedicated staging consent grant when it reports `youtube_oauth_invalid_grant`;
repair the dedicated client when it reports `youtube_oauth_invalid_client` or
`youtube_oauth_unauthorized_client`. Network, rejected-request, and malformed-
response states remain distinct; timeouts are separated from other transport
failures. The adapter never stores Google's error
description or response body, and a browser access token must never be copied
into Worker configuration or evidence.
Google requests use manual redirect handling because the Cloudflare runtime
throws before exposing Google's ordinary response with `redirect: error`;
every `3xx` is still rejected without following or forwarding credentials.

1. Leave `YOUTUBE_PUBLISH_MODE=dry_run`, prepare the immutable current-render
   draft in Marketing, and have a recently authenticated super-admin approve
   it. Confirm D1/audit status `dry_run` and zero provider calls.
2. Confirm the D1 backup/restore drill, current render checksum evidence, exact
   show/runtime channel URL, production-channel ownership, and a cleanup owner.
3. Install the four YouTube Worker secrets from the
   [provider configuration](STAGING_RUNBOOK.md#provider-credentials). Temporarily change
   only the staging environment to `YOUTUBE_PUBLISH_MODE=controlled_test`,
   validate a dry-run bundle, and deploy the exact reviewed commit.
4. Reopen the existing dry-run record and approve it once. Prefer `unlisted`;
   `private` is allowed, while `public` is structurally rejected. The request
   must first refresh OAuth and find the exact configured channel ID in
   YouTube's authenticated `mine=true` channel list. Only then should it return
   `202`; no upload occurs inline. A mismatch or provider failure must leave
   the publication unqueued and create no Queue message.
5. Record the publication ID, provider video ID, verified channel/privacy,
   upload audit event, Queue outcome, and manual inspection result. Confirm the
   consumer repeated the channel preflight before creating the resumable upload
   session. Delete or retain the test video according to the recorded owner
   decision.
6. Restore staging `YOUTUBE_PUBLISH_MODE=dry_run` first and redeploy the exact
   reviewed configuration. Any still-queued job then fails closed as
   `youtube_mode_disabled` without R2/provider access. Remove or rotate the
   temporary provider secrets if they are not needed.

If Google accepted a video but verification or the D1/audit commit failed, do
not retry automatically. Reconcile the channel manually and record cleanup
before authorizing a new render. Production Worker configuration, routes, D1,
R2, Queue, and DNS remain untouched throughout this test.

### Full-episode YouTube

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
   same immutable record. Confirm approval refreshes OAuth and finds the exact
   configured channel ID in YouTube's authenticated `mine=true` channel list
   before D1/Queue mutation. If public release is due, confirm `202` and one
   root Queue message; if it is future-dated, confirm no immediate send and let
   cron enqueue it only at public release.
4. Confirm the consumer conditionally reads the snapshotted R2 ETag, verifies
   the authenticated channel again before creating an upload session, verifies
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

## Historical observations

These dated observations are preserved for traceability. Their deployment URLs,
budgets, credential notes, readiness counts, and provider states describe the
original exercise. They are not current configuration or instructions to restore
an earlier state. Reverify through the procedures above and record the result in
[CURRENT_STATE.md](CURRENT_STATE.md).

### Transcript quality navigation — July 29, 2026

The July 29, 2026 acceptance exercised exact site commit
`bd6667a7f6955aff074266c9a6bf307af9d8086a` at immutable staging URL
`https://b2e757b2.dust-wave-website-staging.pages.dev`. The isolated 1,300-cue
fixture produced 113 short-duration signals. In both English and Spanish,
ten consecutive next actions moved from cue 12 (signal 1) to cue 122
(signal 11), crossed from page 1–100 to 101–200, preserved position through
the rerender, and enabled the previous action without wrapping. Every action
retained its localized accessible name, `aria-controls` relationship, minimum
44 px target, and 320 px viewport bounds. The exact commit-pinned main,
transcript-review, and diagnostic-navigation modules all returned `200`; the
browser recorded zero page/console errors, failed requests, or API mutation
methods. The unauthenticated real staging shell separately passed English and
Spanish localization, noindex/private authentication, exact asset pinning,
and a 320 px document width. Navigation did not save or approve any content.

The source budgets passed at 303,757 bytes for the main module, 9,935 bytes
for transcript review, and 5,535 bytes for diagnostic navigation. GitHub run
`30475974597` passed the exact site commit. The immutable 320×844 Chrome trace
is
`.artifacts/performance/podcast-admin-transcript-signals-bd6667a-320x844.json`
(2,753,739 bytes; SHA-256
`560dbf781d6be2d5058547c031b3ec03f0e8d1d8cc48ef3fa2cc6a2b236de4c6`).

### Speaker ranges — July 29, 2026

The July 29, 2026 acceptance used the bounded 1,300-cue fixture at exact site
commit `99829e5ec57d05e0d36ae01c183776c00b7cc335`. English pages 1–100 and
101–200 plus Spanish page 1 passed both confirmed and unconfirmed paths with
untouched neighboring cues. The main source module remained 301,946 bytes
against its unchanged 302,000-byte ceiling; the isolated controller was 5,336
bytes against 7,000. The immutable deployed 320×844 trace is
`.artifacts/performance/podcast-admin-speaker-range-99829e5-320x844.json`
(2,311,742 bytes), and the deployed admin routes were private/no-store,
noindex, and 320 px wide. The browser fixture deliberately kept these edits
local; it did not claim a real transcript save or approval.

### Public-show rendering — July 29, 2026

The July 29, 2026 public-show audit used exact site commit
`4980505b201b7781d9fb84a2d24752a15013a2cc` at the stable isolated staging
origin and immutable deployment
`https://5cfbb5a3.dust-wave-website-staging.pages.dev`. The staging entrypoint
reused the production CI image pipeline and generated every one of 124
referenced WebP assets; the show wordmark and artwork returned `200 image/webp`
instead of the earlier missing sources. The public checkout loaded
`@dustwave/admin-shell` 0.10.2 with `credentials: "omit"`, and the real
credential-free `GET /v1/shows/opera-en-la-selva` returned `200` without
broadening the Worker's CORS response.

Mobile Chrome measured 131 ms LCP and 0.00 CLS. Lighthouse scored
Accessibility 100 and Best Practices 100 after the light hero action, tier
labels, and account link met AA contrast and the hero action retained a 44 px
target. Its only failed SEO audit was the staging project's required
`X-Robots-Tag: noindex, nofollow, noarchive`. English and Spanish loaded every
first-party image/script/style/API request successfully with no console
warning, error, or inspector issue. Site run `30477544602` and shared run
`30477269242` passed their exact commits. Production Pages, Worker, routes,
data, and DNS remained untouched.

### Stripe preflight — July 27, 2026

The read-only Stripe provider preflight passed on 2026-07-27 without creating
a Customer, Checkout Session, Subscription, charge, or tax object:

- staging D1 and Stripe agree on the inactive Ópera en la Selva test Product,
  exclusive $5 monthly Price, exclusive $50 annual Price, USD currency,
  intervals, lookup keys, and show metadata;
- the active test webhook targets only the Podcast staging route, pins the
  Worker API version, and includes Checkout completion/expiration,
  subscription lifecycle, customer tax-preview, and invoice tax-evidence
  events consumed by the projection;
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
Replace it with a dedicated restricted Podcast test key before
[controlled Checkout step 2](#controlled-checkout), then
repeat the preflight. Never reuse the Pool/Store webhook signing secret or a
live API key.

### Virtual-audio wrapper — July 31, 2026

The complete wrapper passed on July 31, 2026 against source commit
`b0e5799ca7285b6518ccf6d38d7a5d1c3a14225e`. All 24 protocol probes passed;
5,000 paired requests produced 10,000 successful measured requests with zero
errors and zero content mismatches. Virtual p95 was 282.93 ms, the
byte-identical private-R2 baseline was 206.27 ms, and the added p95 was
76.66 ms against the 250 ms ceiling. The wrapper reported both exact-object
and exact-lease cleanup complete, and a follow-up aggregate query returned
zero diagnostic leases. The redacted evidence deliberately records
`nativeClientValidation: false`; keep `AD_DECISION_MODE=staging_validate`,
both episode/show dynamic-ad flags false, and production disabled until the
native-client, equal-length inventory/fallback, and reviewed sponsor-pilot
gates also pass.

### Resend signature and replay — July 27, 2026

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
consented staging listener can receive a separately authorized bounded live-send
test. The [current owner queue](OWNER_ACTIONS.md) records the later evidence;
this paragraph describes only the July signature/replay exercise.

### Composed gate — July 29, 2026

The 2026-07-29 isolated rerun passed all 24 protocol probes and 10,000 paired
requests with zero errors, zero content mismatches, and 27.97 ms p95 added
latency. The signed diagnostic lease and every temporary object were removed.
The composed report then returned six safe passes, six expected promotion
blocks, and zero failures. The dynamic-ad block narrowed to the real isolated
client pilot; production remained disabled.

### Public clip browser fixture — July 28, 2026

The 2026-07-28 exercise used one 9:16
24-second Spanish-caption fixture. At the narrow viewport its three actions
were 219 by 48 px, the post-copy status was 219 by 21 px on its own row, and
document client/scroll widths were both 291 CSS px under Chrome's 320 px
device override. No media playback or provider action occurred.

### Show settings — July 28, 2026

The 2026-07-28
Spanish exercise rendered one DRY form, synchronized both selectors, completed
the existing mock PATCH save, raised the archive confirmation, kept both
permanent destinations read-only, retained 44 px controls, and had matching
291 px document widths under Chrome's 320 px device override with no
horizontal overflow.
