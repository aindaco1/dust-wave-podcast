# HTTP API

All bodies are JSON unless noted. Public routes may be called without a
session. Admin routes use an HttpOnly cookie scoped to `/v1/admin`; mutating
routes also require the `x-podcast-csrf` value returned at login exchange.

## Public

| Method | Path | Purpose |
|---|---|---|
| `GET`, `HEAD` | `/health` | Runtime and environment health |
| `GET`, `HEAD` | `/v1/shows` | Non-archived shows, including coming-soon shows |
| `GET`, `HEAD` | `/v1/shows/{slug}` | Show, internal price choices, global Checkout gate, and public episodes |
| `GET`, `HEAD` | `/v1/shows/{show-slug}/episodes/{episode-slug}/transcripts` | Latest immutable approved English/Spanish transcript revisions for a due public episode |
| `GET`, `HEAD` | `/v1/shows/{show-slug}/episodes/{episode-slug}/chapters.json` | Latest immutable approved Podcasting 2.0 chapter document for a due public episode |
| `GET`, `HEAD` | `/{rss-slug}/rss.xml` | Canonical public RSS |
| `GET`, `HEAD` | `/v1/feeds/{rss-slug}/rss.xml` | RSS alias for staging and diagnostics |
| `GET`, `HEAD` | `/episodes/{episode-id}/audio` | Public R2-backed audio with byte ranges |
| `GET`, `HEAD` | `/v1/media/{episode-id}` | Media alias for staging and diagnostics |
| `POST` | `/v1/webhooks/stripe` | Signed Stripe event intake |
| `POST` | `/v1/shows/{slug}/tax/quote` | Rate-limited, no-store manual subscription-tax estimate |
| `POST` | `/v1/shows/{slug}/checkout` | Turnstile-protected Stripe subscription Checkout start/resume |

Append `?download=1` to the episode media URL for attachment disposition.
Public audio is available only when the episode is published, due, eligible
for public access, and backed by ready delivery media.

The public transcript route applies the same due/public-access/ready-media
boundary and returns `404` for drafts, scheduled releases, premium bonuses,
archived shows, and unknown records. It reads the latest immutable approved
revision for each language, requires confirmed public speaker labels,
revalidates the canonical cue contract, verifies its stored SHA-256, and omits
any invalid revision rather than exposing it. Output is plain timed text with
stable cue IDs and millisecond ranges; it contains no Markdown/HTML, internal
episode/transcript/admin ID, draft, or word-alignment record. Successful
responses use a content-derived ETag and a 60-second public cache with
stale-while-revalidate; errors are no-store. Read-only CORS is `*`, API
responses are noindex, `HEAD` is body-free, and weak/list conditional ETags are
accepted.

The public chapter route uses the same episode visibility boundary, then reads
the latest immutable approval/revision pair, revalidates ordered integer
millisecond markers and safe text/HTTPS metadata, and recomputes its SHA-256.
It returns the Podcasting 2.0 `1.2.0` shape with
`application/json+chapters`, second-based `startTime`, optional `img`/`url`,
and optional silent `toc: false` markers. Missing, malformed, tampered, or
unapproved data returns the same no-store `404`. Successful public responses
use content-derived ETags, short shared caching, wildcard read-only CORS,
noindex/nosniff, and body-free `HEAD`.

Subscription tax quotes accept a configured `priceId` and a billing
`destination`. The Worker normalizes the destination with the same shared
primitive used by Store, selects the most specific assigned
accountant-approved rate version, and returns integer-cent exclusive or
inclusive math. It never returns the Stripe Tax Rate ID or stores the address.
A missing assignment or provider mapping fails closed.

Checkout accepts the same `priceId` and normalized `destination`, plus
`email` and a Turnstile token. It re-resolves price and tax server-side,
creates one idempotent one-hour attempt, sends the normalized address directly
to Stripe, and applies the selected immutable manual Tax Rate as the recurring
subscription default. D1 stores an email HMAC, a keyed destination hash, and
the jurisdiction/rate/source/amount snapshot—not raw email or address fields.
An explicit environment kill switch, correct test/live bindings, webhook
secret, approved assigned rate, active Stripe Price, and challenge
configuration must all pass before a provider request is possible. Automatic
Stripe Tax and dynamic manual-rate selection remain off.

Public show prices include the non-secret internal `id` required by the tax
quote and Checkout routes. The top-level `checkoutEnabled` boolean reports
only whether the global environment gate is ready; destination-specific tax
resolution and every request-time security check still fail closed.

## Passwordless listener authentication

1. `POST /v1/member/auth/start` with `email`, `preferredLanguage`, and a
   Turnstile token. Known and unknown addresses receive the same accepted
   response.
2. Resend sends a one-time link to
   `/podcasts/account/#magic-link={token}`.
3. The browser exchanges only the URL-fragment token at
   `POST /v1/member/auth/exchange`.
4. The response sets a `Secure`, `HttpOnly`, `SameSite=Lax` cookie scoped to
   `/v1/member` and returns a CSRF token for in-memory use.
5. `GET /v1/member/session` rotates CSRF state and returns only the listener
   ID plus non-secret subscription/show status, including whether a
   show-scoped Stripe billing source exists.
6. `POST /v1/member/logout` requires same-origin CSRF and revokes the session.

Listener login tokens expire after 15 minutes and are single-use. Sessions
expire after 30 days. Start and exchange have independent atomic rate limits.
Session responses never contain an email address, provider
customer/subscription ID, or private-feed token.

### Premium private feeds

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/v1/member/shows/{show-slug}/notifications` | Explicitly opt in/out of show announcements and select English or Spanish |
| `POST` | `/v1/member/shows/{show-slug}/feed` | Create the entitled listener's first private feed |
| `POST` | `/v1/member/shows/{show-slug}/feed/rotate` | Revoke the prior URL and return a replacement |
| `POST` | `/v1/member/shows/{show-slug}/billing/portal` | Create a scoped Stripe Customer Portal session |
| `POST` | `/v1/member/redemptions/pool` | Redeem one email-bound Pool benefit code |
| `GET`, `HEAD` | `/v1/private/{token}/{rss-slug}/rss.xml` | Entitlement-gated premium RSS |
| `GET`, `HEAD` | `/v1/private/{token}/{rss-slug}/episodes/{episode-slug}/chapters.json` | Entitlement-gated approved chapter document |
| `GET`, `HEAD` | `/v1/private/{token}/episodes/{episode-id}/audio` | Entitlement-gated byte-range audio |

Create and rotate require the listener cookie, allowed site origin, and current
CSRF token. The raw 256-bit bearer token appears only in the successful
create/rotate response; D1 stores its HMAC. Create fails when one active feed
already exists. Rotate revokes the old URL immediately and atomically installs
one replacement.

The private feed includes due public/free-mini episodes, due early-access
episodes, and due premium bonuses. A current active subscription is rechecked
for every RSS and media request. Invalid, revoked, mismatched, expired, and
unconfigured bearer URLs all return the same `404` shape. Private responses
are `private, no-store`, omit wildcard CORS, and are marked noindex. Append
`?download=1` to a private media URL for attachment disposition.

The billing-portal endpoint requires the listener cookie, same-origin CSRF,
one Stripe entitlement source for that show, an explicitly configured Portal
profile, and an atomic per-session rate limit. Pool-code redemption remains a
separate gated endpoint.

Notification preference writes require the same listener cookie, site origin,
and current CSRF token. The caller must send an explicit boolean `enabled` and
an `en` or `es` language. Consent is show-scoped and may be withdrawn at any
time; the session response exposes only the boolean and language, never the
listener email. A preference does not create an entitlement, and an
entitlement does not imply marketing consent.

### Pool benefit bridge

`POST /v1/internal/pool/grants` accepts only a bounded JSON body signed over
`{timestamp}.{exact body}` with the dedicated Pool–Podcast bridge secret. A
grant carries a stable event/grant ID, show slug, recipient email, high-entropy
code, optional redemption deadline, and optional benefit duration. Podcast
stores only HMACs of the normalized email and code. Event IDs are replay-safe;
conflicting reuse fails, revocation is final even if it arrives before a grant,
and a later regrant requires a new grant ID.

An authenticated listener redeems the code on the Dust Wave member site. The
cookie, current CSRF token, exact recipient email HMAC, code state/deadline,
single-use trigger, and atomic session/code rate limits must all pass. Success
writes an independent `pool` entitlement source and recomputes aggregate show
access. Revocation cancels only the matching current Pool source, so it cannot
cancel an unrelated Stripe or manual entitlement.

## Passwordless admin authentication

1. `POST /v1/admin/auth/start` with `email`, `preferredLanguage`, and a
   Turnstile token. The response is deliberately the same for known and unknown
   addresses.
2. Resend sends a link to `/admin/podcasts/#magic-link={token}`.
3. The browser sends the fragment token to
   `POST /v1/admin/auth/exchange`.
4. The response sets the HttpOnly session cookie and returns a CSRF token for
   in-memory use.
5. `GET /v1/admin/session` restores non-secret identity and role scope.
6. `POST /v1/admin/logout` revokes the session.

Login tokens expire after 15 minutes and are single-use. Sessions expire after
8 hours. Raw administrator email addresses are not stored in Podcast D1.

### Super-admin lifecycle

All lifecycle mutations require a `super_admin` session, same-origin CSRF, and
authentication within the preceding 15 minutes. Responses never expose an
email address or lookup HMAC.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/admin/users` | List up to 100 admin identities and scoped roles |
| `POST` | `/v1/admin/users` | Invite an email lookup with one initial role |
| `PATCH` | `/v1/admin/users/{id}` | Move an identity to invited, suspended, or revoked |
| `POST` | `/v1/admin/users/{id}/roles` | Idempotently grant a global or show-scoped role |
| `DELETE` | `/v1/admin/users/{id}/roles/{role}?showId={id}` | Idempotently revoke a role |

Invited administrators use the standard Turnstile-protected magic-link form.
Once an environment has two active super-admins, D1 triggers prevent a status
change, user deletion, or role deletion from reducing that count below two,
including under concurrent requests.

## Admin

| Method | Path | Roles | Purpose |
|---|---|---|---|
| `GET` | `/v1/admin/shows` | analyst+ | Show overview |
| `PATCH` | `/v1/admin/shows/{id}` | admin+ | Editable show metadata |
| `GET` | `/v1/admin/shows/{id}/audio-qc-policy` | analyst+ | Read the show-scoped source-audio thresholds before or after episodes exist |
| `PATCH` | `/v1/admin/shows/{id}/audio-qc-policy` | admin+ | Optimistically replace show-scoped source-audio measurement thresholds |
| `POST` | `/v1/admin/shows/{id}/marketing/announcements/dry-run` | producer+ | Review one consent-filtered, paired-language announcement without sending |
| `GET` | `/v1/admin/shows/{id}/episodes` | analyst+ | Draft, scheduled, and published episode workbench rows |
| `GET` | `/v1/admin/shows/{id}/clips` | analyst+ | Bounded, filterable cross-episode private clip library |
| `POST` | `/v1/admin/shows/{id}/episodes` | producer+ | Create a draft episode |
| `PATCH` | `/v1/admin/episodes/{id}` | producer+ | Edit episode metadata |
| `POST` | `/v1/admin/episodes/{id}/publish` | producer+ | Idempotent snapshot-aware publish/schedule; blocker override requires recently authenticated admin+ |
| `GET` | `/v1/admin/episodes/{id}/readiness` | analyst+ | Stable exact-evidence snapshot plus the environment's `legacy`, `shadow`, or `enforce` gate projection |
| `GET` | `/v1/admin/episodes/{id}/audio-qc` | analyst+ | Current source/policy, up to 20 private QC summaries, and the latest bounded full report |
| `POST` | `/v1/admin/episodes/{id}/audio-qc` | producer+ | Staging-only queue of one exact source/policy manifest; does not modify or publish audio |
| `GET` | `/v1/admin/episodes/{id}/audio-master` | analyst+ | Current revisioned working master, eligible zero-blocker source, immutable history, presets, and private previews |
| `POST` | `/v1/admin/episodes/{id}/audio-master/approve-source` | super-admin | Optimistically approve the exact current source/QC evidence as a new master revision |
| `POST` | `/v1/admin/episodes/{id}/audio-enhancement-previews` | producer+ | Staging-only queue of a curated, bounded, private A/B preview |
| `GET`, `HEAD` | `/v1/admin/audio-enhancements/{jobId}/media/{original\|enhanced}` | analyst+ | Show-scoped, range-safe, no-store preview or download |
| `GET` | `/v1/admin/distribution?showId={id}` | analyst+ | Show-scoped 10+ directory setup/readiness registry and canonical feed |
| `GET` | `/v1/admin/episodes/{id}/distribution` | analyst+ | Latest immutable RSS/News/YouTube jobs plus per-directory state for one role-scoped episode |
| `PATCH` | `/v1/admin/episodes/{id}/distribution/{destinationId}` | producer+ | Record evidence-backed observation/failure for the exact current revision |
| `POST` | `/v1/admin/episodes/{id}/distribution/{rss\|news\|youtube\|email}/retry` | producer+ | Requeue one failed job for the exact current publication revision |
| `PATCH` | `/v1/admin/shows/{showId}/distribution/{destinationId}` | admin+ | Record show-specific enabled/setup state plus a credential-free owner/submission checklist |
| `GET` | `/v1/admin/episodes/{id}/transcription-jobs` | analyst+ | Current working-master/source-language readiness and up to 20 immutable transcription jobs |
| `POST` | `/v1/admin/episodes/{id}/transcription-jobs` | producer+ | Idempotently queue the explicit source language against an exact approved working master |
| `GET` | `/v1/admin/alignment-benchmarks` | analyst+ | Latest 20 content-free bilingual benchmark summaries plus required runner identity and input limits |
| `POST` | `/v1/admin/alignment-benchmarks` | recent super-admin | Validate, evaluate, and privately record one closed-schema, pinned-runner benchmark submission |
| `GET` | `/v1/admin/episodes/{id}/alignments` | analyst+ | Exact approved-transcript/current-master candidates, up to 30 immutable alignment jobs, workflow identity, and H1 gate state |
| `POST` | `/v1/admin/episodes/{id}/alignments` | producer+ | Staging-only idempotent queue of one exact English/Spanish transcript/master/adapter/runner fingerprint |
| `POST` | `/v1/admin/episodes/{id}/alignments/{jobId}/approve` | admin+ | Approve only a current, structurally eligible result with an exact passed clean bilingual benchmark |
| `GET` | `/v1/admin/episodes/{id}/transcripts` | analyst+ | Versioned English/Spanish cue and matching-alignment state |
| `PUT` | `/v1/admin/episodes/{id}/transcripts/{en\|es}` | producer+ | Idempotent optimistic transcript-cue revision |
| `POST` | `/v1/admin/episodes/{id}/transcripts/{en\|es}/approve` | admin+ | Approve one exact reviewed revision |
| `GET` | `/v1/admin/episodes/{id}/chapters` | analyst+ | Current normalized chapter rows plus version/approval state |
| `PUT` | `/v1/admin/episodes/{id}/chapters` | producer+ | Idempotent optimistic chapter revision |
| `POST` | `/v1/admin/episodes/{id}/chapters/approve` | admin+ | Approve one exact chapter revision |
| `GET` | `/v1/admin/episodes/{id}/reviews` | analyst+ | Current reviewable targets, exact-revision history, comments, blockers, and non-enforcing readiness |
| `POST` | `/v1/admin/episodes/{id}/reviews` | producer+ | Add one replay-safe plain-text note to an exact current target and optional time range |
| `PATCH` | `/v1/admin/reviews/{id}` | producer+; admin+ for approval/reopen | Optimistically update target review state/assignment |
| `PATCH` | `/v1/admin/review-comments/{id}` | producer+ | Optimistically resolve/reopen or assign a review note |
| `GET` | `/v1/admin/episodes/{id}/clips` | analyst+ | List versioned clip recipes and latest private render state |
| `PUT` | `/v1/admin/episodes/{id}/clips/{clipId}` | producer+ | Idempotently create/revise an approved-transcript clip recipe |
| `POST` | `/v1/admin/clips/{clipId}/render` | producer+ | Queue one exact private render contract and return its processor manifest |
| `POST` | `/v1/admin/clip-renders/{renderId}/youtube` | producer+ | Staging-only immutable private/unlisted YouTube test draft for a current ready render |
| `POST` | `/v1/admin/clip-youtube-publications/{id}/approve` | recently authenticated super-admin | Record the default dry run or queue the explicitly enabled controlled test |
| `GET` | `/v1/admin/distribution` | analyst+ | Directory registry |
| `GET` | `/v1/admin/episodes/{id}/distribution` | analyst+ | Per-episode destination state |
| `POST` | `/v1/admin/uploads` | producer+ | Start R2 multipart upload |
| `PUT` | `/v1/admin/uploads/{id}/parts/{n}` | producer+ | Stream one upload part |
| `POST` | `/v1/admin/uploads/{id}/complete` | producer+ | Verify and complete upload |
| `DELETE` | `/v1/admin/uploads/{id}` | producer+ | Abort an incomplete upload |
| `GET` | `/v1/admin/billing/readiness` | super-admin | Non-secret provider/tax readiness |
| `POST` | `/v1/admin/ads/preview` | analyst+ | Read-only sponsor decision preview |
| `GET` | `/v1/admin/ads/campaigns?showId={id}` | analyst+ | Show-scoped campaign/readiness list |
| `POST` | `/v1/admin/ads/campaigns` | admin+ | Create an audited draft campaign and target |
| `PATCH` | `/v1/admin/ads/campaigns/{id}` | admin+ | Edit metadata and reset approval |
| `POST` | `/v1/admin/ads/campaigns/{id}/creatives` | producer+ | Create pending MP3 creative metadata |
| `PUT` | `/v1/admin/ads/creatives/{id}/audio` | producer+ | Stream one bounded creative MP3 to private R2 |
| `POST` | `/v1/admin/ads/creatives/{id}/validate` | producer+ | Validate exact frame/profile/duration/size and hash |
| `GET` | `/v1/admin/episodes/{id}/ad-plan` | analyst+ | Latest processor/review state and approved marker/segment state |
| `POST` | `/v1/admin/episodes/{id}/ad-plan` | producer+ | Submit versioned pre/mid/post marker intent against immutable source audio |
| `POST` | `/v1/admin/ads/plans/{id}/approve` | producer+ | Atomically approve processor evidence as active markers/segments |
| `POST` | `/v1/admin/ads/plans/{id}/reject` | producer+ | Reject pending processor evidence with an audited reason |
| `POST` | `/v1/admin/ads/decisions/issue` | producer+ | Isolated-staging immutable decision exercise; never the public enclosure |
| `GET` | `/v1/admin/ads/reconciliation?showId={id}` | analyst+ | Bounded, paginated campaign-counter versus durable-qualification report |
| `POST` | `/v1/admin/ads/campaigns/{id}/approve` | admin+ | Approve only complete, validated inventory |
| `POST` | `/v1/admin/ads/campaigns/{id}/kill` | admin+ | Immediately and idempotently revoke a campaign |

### Isolated-staging transcription chunk processor

These HMAC-authenticated routes are `404` in production. They use the existing
Podcast media-processor secret; the workflow receives no R2 or Cloudflare API
credential.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/processor/transcription-chunks/{runId}/manifest` | Return the exact digest-bound source/policy/output contract |
| `POST` | `/v1/processor/transcription-chunks/{runId}/source` | Stream the immutable private working master after manifest authorization |
| `PUT` | `/v1/processor/transcription-chunks/{runId}/chunks/{index}` | Store one signed, SHA-256-checked MP3 chunk no larger than 16 MiB |
| `POST` | `/v1/processor/transcription-chunks/{runId}/complete` | Validate the deterministic plan, every R2 object, report digest, and bounded failure/success transition |

### Isolated-staging word-alignment processor

These HMAC-authenticated routes are also `404` in production. The manual
workflow receives only the existing media-processor callback secret; it
receives no Cloudflare API token, R2 credential, or deploy credential.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/processor/alignments/{jobId}/manifest` | Atomically claim an attempt and return the canonical source/transcript/adapter/runner contract |
| `POST` | `/v1/processor/alignments/{jobId}/source` | Stream only the exact private working master after signed manifest authorization |
| `POST` | `/v1/processor/alignments/{jobId}/complete` | Accept one signed bounded success/failure result and project normalized words to private D1/R2 evidence |

Each signed request binds its action and job ID. Manifest rebuild must match
the stored manifest hash, attempts stop at five, inputs are rechecked before
completion, and retryable failures reuse the same immutable job fingerprint.
The workflow retains only content-free digest/quality/resource evidence; it
does not upload audio, transcript projections, or raw alignment output as a
GitHub artifact.

The publish operation hashes all publication-relevant episode state. Repeating
the request without a change returns the existing revision. A changed episode
creates one new revision, stable idempotency keys, one site publication, and
one status record per configured directory.

Directory records distinguish orchestration from provider ownership. Each show
has its own enabled/setup/listing state. A platform marked `verified` means an
authorized Dust Wave operator completed that directory's one-time owner setup;
it does not claim that Dust Wave directly uploads an episode or controls the
provider's ingestion time. After setup, one reviewed publication updates the
canonical RSS feed and creates a monitored `waiting_for_feed` state for every
enabled RSS-following directory. The registry keeps the directory submission
URL and optional observed listing URL separate.
Changing owner setup atomically reconciles only each episode's current,
unobserved `setup_required|waiting_for_feed|disabled` row; prior revisions and
observed/failed evidence are never rewritten.

Migration `0031` extends that show-specific record with a bounded responsible
account label, ISO submission date, safe HTTPS receipt/dashboard URL, and
bounded operational notes. These fields are workflow evidence, not a credential
vault: provider passwords, verification codes, URL credentials/fragments, and
control-character spoofing are rejected or explicitly prohibited. Audit
metadata records only field presence, state, and booleans—not checklist text or
URLs.

Episode directory reconciliation accepts only the current publication revision
and `observed` or `failed`. `observed` requires an HTTPS episode/provider
evidence URL without credentials or fragments. `failed` requires a bounded
operator detail and may include the same kind of evidence URL. The destination
must be enabled with verified/not-required owner setup, and `setup_required` or
`disabled` rows cannot be bypassed. Migration `0030` stores only the evidence
URL, fixed source classification, and reviewing admin ID; the audit event stores
only content-free presence/status metadata.

The episode response also returns the latest immutable root publication
revision and its bounded RSS, News, YouTube, and optional notification job
states. Job status, schedule/start/completion times, attempts, bounded failure
text, dry-run/provider evidence, and News site-publication evidence are kept
separate from directory observation. Migration `0028` stores the revision on
the durable job itself so a later episode edit cannot cause an older queued job
to execute against the wrong revision.

Retry accepts only a positive `publicationRevision`, rejects stale revisions
and succeeded/canceled jobs, and is idempotent while the job is already queued
or running. The conditional D1 mutation and content-free audit event are one
transaction; a News retry also resets only its matching site-publication
revision. An immediate Queue-send failure leaves the durable job queued for the
five-minute scheduler. Processing uses an atomic status/revision claim to
prevent concurrent duplicate provider work, while Cron safely requeues a
`running` lease that has not finished after 15 minutes. Migration `0029` keeps
that bounded stale-lease scan on a partial running-job index.

`POST /v1/admin/episodes/{id}/publish` derives its root jobs from the same pure
intent planner used by readiness and contract tests. Every accepted episode
gets RSS and canonical News work. YouTube work exists only when the episode has
a native video source and is not `premium_bonus`; audio-only and premium-only
episodes do not create a placeholder YouTube job. The plan is recorded in
content-minimized audit metadata.

News snapshots use `publicationSchemaVersion: 1` and a required `pageMode`.
`full_episode` includes the public media/download/transcript/chapter contract.
`premium_teaser` is a separate structural variant containing only public
episode/show identity, title, summary, public release time, canonical and
subscription links, and publication revision. Media URLs, MIME/byte metadata,
duration, transcript/chapter endpoints, private tokens, and premium timing are
absent rather than null or hidden.

Multipart clients should use 32 MiB parts; the API currently caps each request
at 100 MiB and each logical media object at 20 GiB. Parts are streamed to R2 and
never buffered as one Worker request.

### Announcement review

The announcement dry run accepts `language`, `subject`, `heading`,
`bodyMarkdown`, and a same-site `ctaUrl`/`ctaLabel` pair. English and Spanish
are reviewed independently. It returns normalized content, the count of
listeners who explicitly opted into that show and language and currently have
an active, unexpired entitlement, plus pseudonymous audience, announcement,
and combined review hashes. It never returns email addresses or recipient
identifiers.

This route is intentionally review-only: it writes no campaign or outbox row,
has no send mode, and does not call Resend. A future sending endpoint must
freeze the approved audience/content revision in a durable outbox, recheck
withdrawals and suppression at delivery, use deterministic provider
idempotency, preserve an unsubscribe path, and pass its own staging promotion
gate.

### Source-language transcription and review

Queue requests require `requestId`, `expectedWorkingMasterId`, and an explicit
`en` or `es` language matching the episode source language. The server
re-resolves the current approved master and show settings; the input
fingerprint binds master SHA-256, language, adapter/model, settings version,
and normalized vocabulary. Repeating the same fingerprint returns the stored
job without another provider call; reusing a request ID for different inputs
returns `409`.

The Queue consumer verifies the R2 object size, ETag, and byte SHA-256 before
Workers AI. Success writes private immutable provider JSON, timed-text JSON,
WebVTT, SRT, and plain text, then optimistically creates one `needs_review`
transcript revision. It imports segment timing only. Word timing and generated
speaker labels are never created.

Sources over 16 MiB return `delivery: "chunk_processor_required"` with a
content-free workflow/run reference. The staging processor fully decodes the
source and uses the shared deterministic silence-aware plan to create private
16 kHz mono 64 kbps MP3 chunks, each capped at 16 MiB. A signed completion
stores the exact plan and chunk inventory. Workers AI then consumes one chunk
per Queue message; a completed raw chunk response is reused after any later
failure. The final source-relative merge uses core-window ownership and
conservative adjacent-token deduplication. It emits only segment timing and
still creates a single optimistic transcript revision.

Transcript writes accept `mutationId`, `baseRevision`, and 1–10,000 ordered
cues within a one-megabyte canonical payload. Each cue has a stable ID, integer
millisecond start/end, optional public speaker label plus an explicit
confirmation bit, and restricted inline Markdown from the shared timed-text
editor. The Worker independently rejects HTML/control characters, duplicate
IDs, overlaps, cues longer than two minutes, and timing outside the reviewed
episode duration.

The mutation ID is replay-safe and each transcript/base-revision pair may
advance exactly once. A successful edit snapshots the canonical content JSON
and SHA-256, returns status to `needs_review`, clears prior approval, and
supersedes processing/reviewed/passed alignment revisions whose transcript
digest no longer matches. Audit metadata contains only IDs, language,
revision, cue count, digest, and speaker-confirmation state—never caption text.

Approval requires `approvalId` and `expectedRevision`, an Admin/Super-admin
session, current CSRF, and explicit confirmation for every non-empty speaker
label. Transcript approval does not manufacture or approve word timing. The
response exposes `alignment.wordControlsEnabled` only when a matching
alignment revision has status `passed` and contains aligned/editor-adjusted
word rows; otherwise the cue editor remains usable while word navigation and
word-accurate cuts stay locked.

Approval records and transcript-revision snapshots form the public source of
truth. Editing a newer working revision clears current approval but does not
rewrite or remove the last approved immutable snapshot. The public endpoint
changes only after another exact revision is approved, at which point its
content-derived ETag also changes.

### Word-alignment review

Queue requests require `requestId`, `expectedWorkingMasterId`,
`expectedTranscriptRevision`, `language`, and `adapter` (`whisperx` or
`stable-ts`). The Worker re-resolves an approved English/Spanish transcript and
current zero-blocker working master, then builds a deterministic lexical
projection with stable word IDs. The input fingerprint binds both the
transcript content SHA-256 and canonical projection SHA-256 so a semantically
different projection cannot reuse a job.

The external runner contract is schema version 2. Result validation requires
the exact job, alignment revision, source, transcript, projection, adapter,
model/settings, and runner identities. Every projected word must appear once
and in order. Timings must be monotonic, positive, inside their cue and source,
and carry bounded confidence/provenance; an omitted word needs an explicit
bounded reason. Interpolated timing and omissions may be retained for review
but set `structurallyEligible: false`. Invalid intervals fail the job.
Successful validation stores the raw bounded result privately, inserts one
word per exact alignment revision/position, and stops at `needs_review`.

Approval is intentionally a second action. It requires job `ready`, alignment
`needs_review`, exact current transcript/master identities,
`structurallyEligible: true`, and a passed clean-environment benchmark whose
adapter, version, model, model version, settings version, and runner digest all
match. The benchmark must also carry the current private evidence schema,
bounded byte count, content-addressed input/object identity, and exact runner
revision.

Benchmark import accepts
`alignment-benchmark-submission-v1` with `submissionId`, the exact runner
repository/revision, and one benchmark object containing the configured
adapter identity, 1–64 two-to-five-minute fixtures, bounded gold/candidate word
records, preview reviews, resource runs, per-fixture idempotency checks, and
the clean-environment flag. The request and canonical input are capped at
8 MiB and 25,000 total words. The Worker re-runs the policy; clients cannot
submit a status or report. Raw canonical input is private R2 evidence. Responses
and `GET` list results expose only counts, gates, identities, timestamps, byte
count, and SHA-256 values.

Both application checks and D1 triggers enforce approval. A transcript edit or
working-master replacement makes the job stale/superseded. There is no
override path and no production processor route.

### Chapter review

Chapter writes accept `mutationId`, `baseRevision`, and 1–500 ordered markers.
The first marker starts at zero; subsequent integer-millisecond starts must be
strictly increasing and inside the reviewed episode duration. Each chapter
has a stable key, required plain title, optional HTTPS link/artwork, and a
table-of-contents boolean; at least one marker must remain visible. Titles
reject markup, control, and bidirectional override characters. The canonical
review payload is capped at 256 KB.

The existing normalized `episode_chapters` table remains the only editable row
source. One replay-safe D1 batch conditionally advances its header revision,
replaces those rows, stores the immutable canonical JSON/digest, and writes
bounded audit metadata without titles or URLs. Admin approval binds one exact
revision/digest. A newer draft does not rewrite the last approved snapshot, so
public/private clients remain on the prior approval until the next review.

### Production review

Review targets are discovered server-side from the episode's current ready
audio ETag/publication revision, transcript content digest, chapter digest,
clip recipe digest, or latest processed ad-plan digest. A review snapshots that
exact type, ID, revision, and digest. When the underlying target changes, the
review remains readable as history but is not current and cannot receive a new
approval.

Comment creation accepts a replay-safe `commentId`, optional ordered
integer-millisecond range inside the episode, 1–4,000 characters of normalized
plain text, an explicit blocker boolean, and an optional active show-team
assignee. Review and comment state changes accept `mutationId` plus
`baseRevision`; D1 advances each base once. Approval or reopening an approved
review requires Admin+, and approval fails while that exact target has an open
blocker. Audit metadata records IDs, revisions, state, blocker, range-presence,
and assignment-presence only—never comment text.

The list response marks exact current versus historical targets and summarizes
current approvals/open blockers. `reviewReady` requires one approved review
for every exact current target, zero open blockers, and complete bounded
evidence; a partial or truncated set fails closed. `publishingEnforced` remains
false.

### Publication readiness snapshot

`GET /v1/admin/episodes/{id}/readiness` is a show-scoped, private/no-store,
read-only projection. The Worker first applies the same DRY prerequisite
function used by `POST .../publish`, returning that unchanged result as
`legacyGate`. It then derives 14 bounded nodes across core release metadata and
audio; access timing; primary and bilingual transcript approvals; matching
word alignment; optional chapter and clip evidence; complete exact-revision
production review; conditionally required dynamic-ad evidence; canonical News
and RSS contracts/current jobs; YouTube applicability; and one-time directory
setup. For a scheduled or published episode, the core metadata node recomputes
the same publication fingerprint used by Publish and becomes `stale` when the
current content no longer matches that revision.

Each node has a stable ID/group, `ready|missing|pending|stale|failed|
not_applicable` status, `blocker|warning|info` severity, plain summary, and
non-secret evidence. Audio object keys, transcript/chapter/recipe digests,
review text, job errors, credentials, and listener data are not returned. The
top-level `snapshotDigest` is SHA-256 over schema version 1, the publication
revision, monotonic episode/show/global evidence versions, the legacy and
candidate results, and ordered node evidence. `generatedAt` is excluded, so
identical evidence produces an identical digest. The Worker reads the versions
again after composing the graph and retries a changing snapshot up to three
times before returning `publication_snapshot_busy`.

`candidateGate.ready` means no blocker node is unresolved. It is an
explanation in `legacy` and `shadow`; `publishingEnforced` becomes true only in
`enforce`. `overrideAvailable` is true only for a show-scoped Admin or
Super-admin in enforcement mode. The endpoint performs only D1 reads and never
heads R2, calls a provider, queues work, mutates a review, or changes
publication state. Current release jobs replace preflight contract state only
for the exact `publicationRevision`. The shared planner identifies a premium
bonus News node as a media-free `premium_teaser`; it makes YouTube not
applicable for that access mode and for audio-only episodes.

For non-idempotent Publish, `shadow` and `enforce` clients send the fresh
`snapshotDigest` and `basePublicationRevision`. Shadow records whether they
match but preserves the legacy readiness decision. Enforcement rejects a
missing/stale snapshot and unresolved candidate blockers. An Admin or
Super-admin may override blockers only with a fresh snapshot, a newly issued
operation ID, the literal confirmation `PUBLISH_WITH_BLOCKERS`, a normalized
1–500 character private reason, and a login within the preceding 15 minutes.
The full reason is stored only in `publication_gate_overrides`; the general
audit log receives its hash/length and evidence counts, never its text.

Every mode uses monotonic episode/show/global evidence versions in the final
conditional update. A checked D1 batch guard converts a zero-row update into a
transaction failure, so a conflict cannot commit jobs, directory rows, a site
publication, an override, or an audit event. Unknown gate configuration fails
safely to `legacy`; staging is `shadow` and production remains `legacy`.

### Clip recipes and private render evidence

Clip recipes reference an exact approved transcript revision and immutable
delivery-audio key/byte/ETag snapshot. The client supplies stable clip and
mutation IDs, an optimistic base revision, title, language, aspect ratio,
template, and start/end cue IDs. The Worker derives segment timing from those
cues; it does not trust client milliseconds. Ranges must be 1–180 seconds
inside the reviewed episode. Word-boundary requests additionally require
matching passed alignment evidence and aligned/editor-adjusted boundary words
with non-interpolated provenance in the selected cues.

`POST /v1/admin/clips/{clipId}/render` accepts a stable render ID and exact
expected clip revision. It rechecks that source audio and the currently
approved transcript still match the recipe, then returns a
`clip-render-v1` manifest containing bounded relative caption cues, output
dimensions/safe areas, a private revision/render-specific R2 key, and a staging
callback URL. The manifest SHA-256 is persisted before processing. Callback
identity uses the configured canonical staging `FEED_ORIGIN`, not a request
host, so retries rebuild the same digest.

Ready output stays private. `GET` and `HEAD`
`/v1/admin/clip-renders/{renderId}/media` require an active Analyst-or-higher
admin session with access to the render's show. The route rechecks ready D1
evidence plus R2 byte count, MIME type, native SHA-256, custom SHA-256, and
manifest digest before returning headers. It supports one bounded byte range,
ETag/If-Range/If-None-Match, credentialed allowlisted CORS for the admin
player, and `?download=1` attachment delivery. Responses are private,
no-store, noindex, and never expose the R2 key.

`GET /v1/admin/shows/{showId}/clips` supplies the Marketing clip library
without issuing one request per episode. Results are ordered by immutable
updated-time/ID keyset, default to 24 and cap at 100, and may be filtered by
episode, `9:16|1:1|16:9`, and the current revision's
`queued|rendering|ready|failed` render state. The opaque next cursor is a
show-scoped clip ID. Returned ready actions reuse the private media route
above; no object key or public media URL is included.

### Controlled YouTube clip test

The YouTube test routes exist only when `ENVIRONMENT=staging`; production
returns the same private `404` contract as an unknown resource. Draft creation
requires CSRF, Producer-or-higher access to the render's show, one current
`ready` revision, complete render evidence, an immutable publication ID, and
an exact confirmation of both the show's current `youtube_channel_url` and the
runtime's configured launch channel. The only accepted privacy values are
`private` and `unlisted`.

One render has at most one provider-publication record. With the committed
`YOUTUBE_PUBLISH_MODE=dry_run`, a recently authenticated super-admin approval
re-heads private R2 evidence and records an audited `dry_run` without a
provider request. That same immutable record may later be promoted once to
`controlled_test`; it is not copied into a second provider attempt.

Controlled mode additionally requires Worker secrets
`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, and
`YOUTUBE_CHANNEL_ID`. Approval records the expected channel ID and queues a
plain serializable job; no provider upload happens in the request. The consumer
rechecks D1 revision state, R2 bytes/MIME/native checksum/custom checksum and
manifest digest, conditionally streams the exact private object into a
hard-pinned Google resumable-upload session, then verifies the returned video
channel and privacy through the YouTube API before atomically recording D1
provider evidence and the admin audit.

Provider JSON is streamed through a 64 KB response cap and OAuth/metadata/media
requests have explicit timeouts with redirects disabled. Credentials, access
tokens, upload-session URLs, private object keys, and provider bodies are
never returned or logged. Restoring dry-run mode before consumption marks a
queued test `youtube_mode_disabled` without reading R2 or calling Google.
Queue/provider failures become terminal state rather than automatic duplicate
uploads. If Google accepts a video but verification or the D1 commit fails,
operators must reconcile the unlisted/private item manually; automatic retry
is intentionally disabled at that boundary.

The staging processor surface is private and purpose-bound:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/processor/clip-renders/{renderId}/manifest` | Return the persisted render's rebuilt manifest after an HMAC-signed `manifest` request |
| `POST` | `/v1/processor/clip-renders/{renderId}/source` | Stream only the manifest-pinned private MP3 after an HMAC-signed `source` request |
| `PUT` | `/v1/processor/clip-renders/{renderId}/output` | Stream a signed, bounded MP4 into private R2 with native SHA-256 verification |
| `POST` | `/v1/processor/clip-renders/{renderId}/complete` | Commit bounded failed or ready evidence idempotently |

Manifest/source/complete signatures bind
`{timestamp}.{exact request body}`. Output uploads sign a compact base64url
descriptor containing the action, render ID, manifest digest, byte count, and
SHA-256; the MP4 body must have that exact declared length. Authentication and
bounded header validation happen before D1, the source is conditionally read
at the snapshotted ETag, and the upload uses the Worker's R2 binding rather
than exposing R2 credentials to the renderer.

The signed staging callback is
`POST /v1/processor/clip-renders/{renderId}/complete` using the same timestamp
and HMAC headers as the isolated media processor. Failure evidence is bounded
and replay-safe. Successful evidence must match the render/manifest identity,
exact 1080×1920, 1080×1080, or 1920×1080 dimensions, recipe duration within
250 ms, `video/mp4`, the predetermined R2 key, byte count, and private R2
custom metadata for both output SHA-256 and render-manifest SHA-256. An old
revision may retain historical evidence but cannot mark a newer clip ready.
No public URL or YouTube upload is produced by the render-processor boundary;
the separately authorized controlled test above consumes only its verified
ready evidence.

### Source-audio quality control

The source-audio QC boundary is non-destructive and staging-only for its first
processor slice. Queueing requires a completed `source_audio` upload that is
still the episode's current source. The Worker heads private R2, snapshots
object key/bytes/ETag/MIME plus the current show-policy revision, and returns a
non-secret workflow/run/digest descriptor for a stored SHA-256-bound
`audio-qc-job-v1` manifest. The full manifest is available only through the
signed processor route. A second active or successful run for the same source
ETag and policy revision is rejected.

The shared `@dustwave/media-core/audio-qc` contract is used by both Worker and
processor. It defines bounded mono/stereo LUFS targets, tolerance, maximum true
peak, DC offset, channel imbalance, silence thresholds, normalized media
measurements, ordered findings, resource evidence, and manifest/report
digests. The Worker recomputes findings from returned measurements; it does
not trust processor-supplied blocker or warning totals.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/processor/audio-qc/{runId}/manifest` | Return the rebuilt exact manifest after a signed `manifest` request |
| `POST` | `/v1/processor/audio-qc/{runId}/source` | Stream only the ETag-pinned private source after a signed `source` request |
| `POST` | `/v1/processor/audio-qc/{runId}/complete` | Commit one signed bounded success report or failure code idempotently |

All three processor routes are absent outside staging. Success re-heads R2,
validates the shared report, recomputes its SHA-256 and findings, and writes
summary/report state plus content-minimized audit metadata. The source object
key is not included in the workbench response or audit metadata.

### Working master and enhancement previews

A working-master approval is an immutable, revisioned boundary separate from
source upload and delivery audio. Only a Super-admin can approve. The request
must carry the current state revision, exact successful QC run ID, a bounded
reason, and an explicit exact-source acknowledgement. At commit time D1
rechecks that the QC run has zero blockers, still matches the current
`source_audio` upload and ETag, and uses the current show-policy revision; the
Worker re-heads R2 first. A stale or competing revision returns `409`.

Changing the current master increments publication evidence and removes
current transcript/chapter approvals while returning clips to draft. Authored
content and immutable approval history remain. Production reviews use the
approved master SHA/revision—not delivery-audio ETag—as their working-audio
target, and readiness has a blocking `core.working_master` node.

Enhancement queueing accepts only the two shared curated presets, an integer
start, and a 5–90 second duration bounded by the QC-measured source duration.
The shared `@dustwave/media-core/audio-enhancement` contract binds source
bytes/ETag/SHA, QC report SHA, recipe, predetermined A/B keys, callback, and
manifest digest. Both outputs are 48 kHz 192 kbps MP3 so an A/B comparison
does not confound the preset with a codec change.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/processor/audio-enhancements/{jobId}/manifest` | Return the rebuilt exact manifest after a signed `manifest` request |
| `POST` | `/v1/processor/audio-enhancements/{jobId}/source` | Stream the ETag-pinned private source after a signed `source` request |
| `PUT` | `/v1/processor/audio-enhancements/{jobId}/outputs/{original\|enhanced}` | Stream one signed, length-bound, native-SHA-verified private MP3 |
| `POST` | `/v1/processor/audio-enhancements/{jobId}/complete` | Re-head both outputs and commit one shared-contract report or bounded failure |

These processor routes exist only in staging. The workflow receives no R2
credential, uses argument arrays rather than user-supplied filters, retains no
audio artifact, and uploads through the Worker binding. The admin response
contains authenticated media URLs rather than R2 keys. A preview cannot be
approved as a working master; a future full-length derivative must pass a new
QC run before a separate approval.

### Sponsor decision preview

`POST /v1/admin/ads/preview` also requires the current CSRF token. Its JSON
body is:

```json
{
  "episodeId": "episode_example",
  "position": "mid",
  "deviceType": "mobile",
  "appName": "apple_podcasts",
  "streamProfile": "mp3-44100-stereo-cbr128-frame-v1",
  "at": "2026-07-24T12:00:00.000Z"
}
```

The response evaluates current D1 campaign/rule/creative rows without creating
a decision, incrementing a counter, or changing public delivery. It reports
feature flags, approved-marker and program-segment readiness, an inventory
fingerprint, the proposed selection or full-file fallback, and explicit
activation blockers. `runtime_not_connected` remains present until the signed
manifest, qualification, virtual-audio, privacy, and real-client gates pass.

Campaign creation requires an explicit show, date window, campaign type, and
one initial targeting rule. Direct campaigns also require an active sponsor;
house campaigns cannot carry sponsor billing metadata. New and edited
campaigns are drafts. Approval fails closed until there is an active show rule,
active sponsor when applicable, and active creative whose validated byte,
MIME, and exact stream-profile metadata is ready. The kill endpoint is
irreversible for that campaign row; operators create a new campaign rather
than silently resurrecting revoked inventory. Every mutation writes an admin
audit event, while approval still cannot affect playback until the separate
runtime and show/episode feature gates pass.

Creative audio is a separate, bounded streaming workflow rather than a copy of
the episode multipart uploader. Create metadata first, then send an
`audio/mpeg` body of at most 25 MiB with the exact byte count in
`x-podcast-upload-bytes`, and call the returned validation route. Validation
parses every MPEG frame, permits bounded ID3 metadata outside the frames,
requires MPEG-1 Layer III at 128 kbps/44.1 kHz/stereo, verifies complete frame
boundaries and object size, checks declared versus measured duration, and
records a SHA-256 digest and review evidence. Creating, replacing, or
revalidating audio returns the campaign to draft. Upload and validation
failures remain non-ready and are audited.

### Episode ad plans and processor evidence

Submitting an episode ad plan records 1–3 unique pre/mid/post positions against
the exact ready delivery MP3 key, byte size, ETag, and reviewed duration. It
does not edit the currently approved marker/segment rows. The response includes
a non-secret `processorManifest` for the isolated staging workflow.

The `Process staging Podcast ad plan` GitHub workflow downloads the private
source through authenticated Wrangler, normalizes it once to the launch MP3
profile, splits that normalized stream only on complete MPEG frame boundaries,
uploads full private program objects under the plan-specific R2 prefix, and
submits its evidence to
`POST /v1/processor/ad-plans/{id}/complete`. That internal callback is not a
browser API: it requires a five-minute timestamp and HMAC-SHA256 signature over
the exact request body. The Worker checks immutable source evidence, contiguous
sequence, object prefix, exact R2 sizes, frame-derived duration, 128 kbps frame
byte bounds, the mid-roll boundary, whole-episode duration, and per-segment
SHA-256 before changing the plan to `needs_review`.

A Producer/Admin/Super-admin must then approve. Approval rechecks the manifest
digest, source identity, and current R2 objects and replaces active
marker/segment rows in one D1 batch. It does not set either dynamic-ad feature
flag, create a decision, change the public file, or count an impression.

### Signed staging decisions

With `AD_DECISION_MODE=staging_validate` and a staging-only signing secret, an
authenticated Producer/Admin/Super-admin may issue a deterministic decision
exercise. It requires a published revision, current approved marker/program
plan, complete validated creative snapshots for every marker, one exact stream
profile, and matching private R2 sizes/ETags. The response contains an expiring
`GET|HEAD /v1/ads/decisions/{id}/audio` URL whose HMAC covers the decision ID,
expiry, and manifest SHA-256. Signature validation occurs before D1 lookup.
During a planned key rotation, issuance uses `AD_DECISION_SIGNING_SECRET` while
validation also accepts `AD_DECISION_SIGNING_SECRET_PREVIOUS`; remove the
previous value only after the two-hour maximum decision lifetime.

The signed route reloads and hashes the stored manifest and preflights every
private object size/ETag before response headers, then uses the existing
bounded virtual range streamer. It is available only on isolated staging.
Production sets the mode to `disabled`; the permanent episode enclosure never
calls this route and both dynamic-ad feature flags remain false.

Every newly issued staging decision also selects a deterministic house
fallback for each slot. A house creative is eligible only when its validated
byte count, duration, MIME type, and stream profile exactly match the selected
sponsor creative. The decision snapshots those fallback campaign, creative,
hash, duration, object-key, size, ETag, and profile fields. When every slot is
covered, the fallback manifest reuses the same program segments with the
matching house creatives and reports `fallbackType: "house_fill"`.

If any slot lacks an exact house rendition, the staging decision instead
snapshots one validated `fallbackType: "full_file"` manifest from the current
immutable delivery-audio key, size, and ETag. The signed manifest records a
derived `equal-byte-length-v1` contract containing primary bytes, fallback
bytes, and their equality result. The Worker recomputes that contract before
presenting or serving a decision, so a missing or altered declaration fails
closed. An unequal full-file diagnostic reports
`deliveryLengthReady: false`; production activation requires complete
same-length house/filler coverage plus every other documented launch gate.

On the signed URL's first `GET` or `HEAD`, the Worker preflights the primary
virtual manifest. If primary evidence is unavailable, it preflights the
fallback and atomically commits exactly one `primary` or `fallback` delivery
variant in D1 before emitting headers. Concurrent first requests use the
committed winner. Later range/retry requests may never switch variants; if the
committed objects change, the route fails closed instead of returning
different bytes under one signed URL. This staging safety path does not attach
the permanent enclosure or enable either dynamic-ad feature flag.

### Trusted staging qualification and reconciliation

`POST /v1/internal/ad-qualifications` is a server-to-server staging contract,
not a browser telemetry route. It requires
`AD_QUALIFICATION_CALLBACK_SECRET`, `application/json`, a five-minute
`x-podcast-qualification-timestamp`, and
`x-podcast-qualification-signature` containing HMAC-SHA256 over
`{timestamp}.{exact raw body}`. Signature validation and the 20 KB body bound
run before D1. The body contains only `decisionId`, `decisionSlotId`, and
`creativeBytesServed`; it does not accept an IP address, user agent, listener
identity, or caller-supplied qualification time.

The callback counts at most one completed delivery per immutable decision
slot, only while its qualification window is open and only after the
snapshotted creative byte threshold is met. D1 triggers enforce the campaign
hard cap and counter increment atomically. Retries resolve by immutable slot
identity, so callback-secret rotation cannot duplicate or strand an already
recorded qualification.

The admin reconciliation endpoint defaults to 50 campaigns, caps each page at
100, and uses a campaign cursor. It is show- and role-scoped, reports its
`trusted-download-v1` methodology, and compares trigger-maintained counters
with durable qualification rows. Supporting indexes cover show targeting,
created-time pagination, and campaign qualification history.

## Provider modes

`GITHUB_PUBLISH_MODE` and `YOUTUBE_PUBLISH_MODE` default to `dry_run`. A dry-run
publication exercises state transitions without an external write. The only
implemented non-dry YouTube mode is the staging-only, recent-super-admin
`controlled_test` for an immutable private/unlisted ready clip described
above; `public` is not accepted and production routes remain unavailable.
Podcast Checkout remains inert until the explicit global gate,
accountant-approved manual tax configuration, isolated Stripe bindings, and
request-time security checks all pass.
