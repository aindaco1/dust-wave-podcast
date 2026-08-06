# Dust Wave Podcast

Cloudflare Worker runtime for Dust Wave's multi-show podcast platform. The first
release keeps a single-show public UI while the schema and API remain
multi-show-ready.

## Responsibilities

- public and premium RSS orchestration;
- podcast media metadata in D1 and media objects in R2;
- premium subscriptions, benefits, redemptions, and private feed tokens;
- real-time house-promo and direct-sponsor ad decisions;
- transcript, word-alignment, clip, and YouTube publishing jobs;
- privacy-conscious first-party analytics.

The current vertical slice implements the public show API, public RSS,
entitlement-gated private RSS and R2-backed range delivery, passwordless admin
and listener authentication, one-time private-feed creation and rotation, show
and episode editing APIs, multipart uploads, one-click idempotent publication
orchestration, a dry-run GitHub News publisher, a dry-run YouTube adapter plus
staging-only immutable clip/full-episode controlled tests, and
the fail-closed manual-tax quote and Stripe Checkout/Customer Portal boundaries,
webhook-projected multi-source entitlements, and the signed Stripe
webhook/readiness boundary. Draft/approval/kill sponsor
operations, deterministic targeting preview, bounded creative validation, and
the signed processor/producer-review boundary for frame-aligned episode ad
plans are implemented without connecting public audio assembly. The bilingual
word-alignment storage contract, executable launch-quality evaluator, signed staging
processor bridge, and normalized stable-ts/WhisperX runner are also
implemented. The source-language Workers AI transcription adapter is now implemented behind
an immutable working-master snapshot, Queue recovery, private R2 evidence, and
versioned transcript review. The first rights-cleared private transcription
run completed; human transcript review and the alignment adapter's
human-reviewed benchmark evidence remain gated. Checkout remains disabled
pending accountant-approved tax/provider evidence. Dynamic
audio now has a guarded public-enclosure runtime in code. Its isolated
synthetic protocol and 10,000-request paired-load gates pass with exact
cleanup, but both deployed modes remain non-automatic until the native-client,
inventory/fallback, and sponsor-reconciliation gates pass. Public clip
selection and verified range delivery are implemented as a staging preview
with production disabled; production-live YouTube/GitHub publishing remains
roadmap work.

Exhausted staging Queue jobs now move to an isolated dead-letter queue and are
automatically reduced to durable, content-free D1 incident evidence. The
consumer stores a payload digest plus bounded internal job identity, never raw
content, and deliberately cannot replay work or repeat provider side effects.
Production queue behavior remains unchanged.

Staging also discovers exact enhanced-master decisions, ready delivery audio,
source-language transcripts, and benchmark-qualified word alignments that need human review, then sends one
bilingual Resend action message to a configured Super-admin. Each link signs in
once, selects the authorized show and episode, and focuses the existing exact
review control. Stable idempotency digests support three bounded delivery
attempts; D1 retains only content-free action state and a login-token hash.
Approval, rejection, editing drift, benchmark drift, or stale evidence resolves
the relevant reminder automatically. Alignment mail appears only after the
same structural, current-input, final-master, and private bilingual benchmark
evidence required by the approval transaction. Downstream reminders remain
blocked until the shared master decision is final, and production delivery
remains disabled.

Public release, premium-window, subscription-expiry, tax-rate, and publication
job boundaries compare canonical millisecond UTC RFC 3339 timestamps against
one shared SQL clock. This avoids SQLite TEXT ordering drift between
`YYYY-MM-DDTHH:mm:ss.sssZ` application/provider values and
`YYYY-MM-DD HH:mm:ss` database timestamps while preserving due-time indexes.

An existing-show RSS migration preview, reviewed-plan boundary, and isolated
staging execution boundary are also implemented. A recently authenticated super-admin
must confirm import rights; the Worker performs a bounded,
redirect-controlled public-HTTPS fetch, sanitizes RSS metadata, hides the
owner address, and reports which items have valid audio enclosures and stable
import identity. It also discovers the source Podcasting 2.0 channel UUIDv5
under any correctly declared namespace prefix and presents it beside the
destination identity. A selected plan freezes the exact feed, source channel
GUID or explicit absence, source episode identities, metadata, and
query-stripped display URLs. Invalid, conflicting, or valid-but-unassigned
channel identity fails closed; migration never silently replaces show
identity. For a future empty `coming_soon` show, a separate recent-super-admin
action can re-fetch the exact preview and adopt a valid source UUIDv5 once,
with immutable query-stripped provenance and a second irreversible-action
confirmation. Review requires the exact source URL to be re-entered and
re-fetches the feed before accepting byte-identical identity and content evidence.
Preparing and reviewing remain zero-copy.

Only `RSS_IMPORT_EXECUTION_MODE=staging_copy`, a dedicated
`RSS_IMPORT_URL_SECRET`, another exact feed reconciliation, recent
Super-admin authentication, and an explicit item-to-slug/language mapping can
queue execution. Each item streams directly into private R2 while calculating
SHA-256, verifies the reviewed MIME type and byte count, and creates only an
unpublished draft episode plus completed private source-upload evidence.
The protected source URL is AES-GCM sealed, never enters Queue or audit data,
and is erased after completion or seven days. Production keeps execution
disabled. This boundary cannot create News/RSS/YouTube/directory jobs, contact
a provider, change billing/email/ads, or configure the old-host redirect;
working-master review and publication stay separate. Staging can now hash and
immutably approve a complete post-copy snapshot only after D1 draft identity,
completed source-upload evidence, private R2 size/ETag/type/metadata, and
zero-publication state all agree. The old-host checklist remains
non-activating. Staging can record an immutable, hash-only owner-control
attestation after exact URL re-entry, but stores no old-host credential and
contacts no provider. Later public-episode, revalidated-feed, 10-directory,
and final activation approval evidence remain required. Once exact current
RSS and canonical-News publication, post-publication feed validation, ten
directory recovery certifications plus later re-observations, and the owner
attestation all agree, staging can freeze an immutable cutover packet. That
packet is evidence only and cannot contact or configure the old host, change
DNS, or activate a redirect.

A final staging-only activation approval can then bind one fresh cutover
packet, the immutable owner-control method, current show/episode evidence, and
explicit final-review, manual-action, rollback, and zero-activation
acknowledgements. The approval is append-only and becomes stale with its
packet. It authorizes only a later owner-controlled manual handoff: the Worker
still cannot contact the host, change DNS, configure a provider, or activate a
new-feed tag or HTTP 301, and production remains closed.

The delivery boundary now derives one fixed-profile MP3 and bounded player
waveform from the exact approved working master through a staging-only,
credential-minimized workflow. Full decode, complete-frame validation,
checksummed multipart upload, private existing-player review, and recent
Super-admin approval are required before the episode enclosure can satisfy
News/RSS publication. Master changes make unapproved delivery work stale, and
the public waveform exists only for the exact published approval. Once the
enhanced-master decision is final, the staging scheduler now creates the first
eligible delivery render automatically and the existing dispatcher sends it
to the pinned processor. Deterministic IDs, one-active-job constraints, and a
three-attempt ceiling make retries bounded; production remains disabled.

Audience reporting now combines provisional qualified downloads, daily
60-second engaged Dust Wave web-player listens, app/device/country breakdowns,
and daily 25/50/75/100 completion milestones. Completion uses cumulative
foreground playback rather than playhead position and cannot represent
third-party podcast-app retention. Exact HMAC-deduplicated aggregates remain in
D1; raw IP addresses, user agents, elapsed seconds, and seek history are never
stored.

The transcript review workbench stores versioned English/Spanish cue records,
uses optimistic revisions and idempotency keys, and keeps word-linked controls
off unless a matching alignment revision passed the launch gate. Producer
edits always return an approved transcript to review; Admin/Super-admin
approval requires every visible speaker label to be explicitly confirmed.
Caption text uses the shared timed-text editor representation and the Worker
independently rejects HTML, invalid/overlapping timing, stale revisions, and
out-of-bounds cues. The public transcript projection now serves only the
latest immutable, hash-verified approved revision per language for published,
due, public/free/early-access episodes with ready media. It emits plain timed
text with wildcard read-only CORS, short cache validators, and no internal
transcript/admin identity; premium bonuses and non-public episode states remain
indistinguishable `404`s. Public clip distribution remains staging-only and
requires exact render approval plus the same episode visibility boundary.
The private workbench can also download the exact current saved revision as
WebVTT or SubRip after recomputing its D1 digest; unsaved edits and unconfirmed
speaker labels never silently enter those files.
The workbench consumes `@dustwave/admin-shell` 0.10.2 for one fail-closed
unsaved-change lifecycle boundary. Transcript and chapter dirty state remains
Podcast-owned; show, episode, language, chapter, logout, and browser-exit
transitions cannot silently discard a local review draft. The same shared
primitive used by Pool and Store now marks each dirty review action, exposes a
machine-readable state, and disables Save while its draft is clean.
The shared API client remains credentialed by default for admin/member
sessions, while the public show checkout injects `credentials: "omit"` to
match the Worker's credential-free public CORS contract.

Producer+ episode editing now includes a bilingual, review-only show-notes
assistant on the existing shared Pool/Store WYSIWYG path. It reuses only the
latest immutable, speaker-confirmed, SHA-256-verified approved transcript,
passes a bounded deterministic head/middle/tail excerpt to the existing
Workers AI binding, and strictly validates the returned JSON and Markdown.
Generation is rate-limited and audited without transcript or draft text.
Results stay in a separate review card until the producer explicitly places
them in the unsaved editor; no episode, News, RSS, distribution, or provider
publication state changes. After the same final-working-master decision used
by transcription and alignment, staging now prepares the primary-language
proposal automatically. An exact transcript/master/model/prompt fingerprint,
short lease, three-attempt ceiling, and strict response validation make the
private D1 proposal replay-safe. The Admin loads the newest validated proposal
without applying it and keeps manual generation inside secondary controls.
Production discovery exits before D1 and both automation and AI remain
disabled there.

The chapter workbench has a separate bilingual, review-only proposal assistant
on the same verified-transcript and Workers AI boundary. Chapter drafting
requires complete coverage within the 48,000-character prompt limit; it never
silently proposes a table of contents from a partial transcript. Provider
output may select only exact cue IDs, which the Worker maps back to immutable
cue start times before the normal chapter validator runs. Applying a proposal
only replaces unsaved chapter-editor state. Saving and Admin approval remain
separate explicit actions. In staging, the scheduler now prepares the missing
primary/show-language proposals only after the same final-master predicate and
the exact approved transcript have passed human word-alignment review. The
shared private AI-draft ledger pins that alignment revision, bounds recovery to
three attempts, and never writes chapter state. Production exits before D1 and
both chapter automation and AI are disabled.

The clip factory also has a bilingual, review-only social-candidate assistant
on that shared boundary. It requires complete approved-transcript coverage and
accepts only chronological, non-overlapping exact cue ranges. The Worker
derives and enforces 15–90 second timing from immutable cues, while generated
titles and editorial reasons remain review text. Choosing a candidate fills a
new unsaved vertical segment recipe; the existing versioned save, alignment,
render, approval, and publication gates remain unchanged. Staging now prepares
primary/show-language candidates automatically only after the exact final
master, approved speaker-confirmed transcript, and human-approved passing word
alignment exist. Chapters and clips share one aligned-editorial eligibility
query plus the private AI-draft lease/retry ledger; clip fingerprints also bind
episode title and duration. The Admin reads only current proposals and never
applies one. Production exits before D1 and both clip automation and AI remain
disabled.

Source-language transcription accepts an explicit English/Spanish episode
language and only the current approved working master. The job fingerprint
binds the master SHA-256, model, language, and versioned settings; duplicate
inputs reuse one stored job. Once the enhanced-master decision is final,
staging creates the missing source-language job automatically through the same
queue primitive used by the Admin API. Provider responses, normalized
timed-text JSON, WebVTT, SRT, and plain text remain private in R2. Workers AI
segment timing is normalized through `@dustwave/timed-text`; provider word records and speaker
guesses are not imported. Direct Worker processing is capped at 16 MiB to
bound base64 memory. Larger masters use the credential-minimized
`process-transcription-chunks.yml` staging workflow: it verifies the immutable
source, fully decodes it once, chooses bounded silence-aware cuts with a
1.5-second overlap, and uploads only checksummed private 16 kHz mono MP3
transcription intermediates. The Queue processes one chunk per message, stores
each raw response immutably for retry reuse, and merges segment timing by
non-overlapping core ownership with conservative boundary-token deduplication.
The working master and public enclosure are never changed. Production
processor routes remain absent until the owner-controlled large-source gate
passes.

Forced alignment is a separate immutable job after transcript approval.
Staging discovers each approved English/Spanish transcript only after the
shared final-master decision, queues the exact job with a system-owned audit,
and lets the existing durable processor dispatcher claim it; the Admin queue
action remains break glass. It binds the exact approved transcript
content/projection hashes, current working-master bytes,
adapter/model/settings, and pinned runner revision. The
credential-minimized `process-alignment.yml` workflow receives no Cloudflare
or R2 token: signed purpose-bound Worker routes provide the exact private
source and accept one bounded result. The Worker independently validates every
stable word ID, cue, lexical value, interval, omission, confidence,
provenance, resource record, and digest before storing private evidence and
moving the revision only to `needs_review`. Interpolated or unexplained timing
never unlocks word controls. Final approval requires an exact matching
English/Spanish benchmark that passed in a clean environment; D1 triggers
enforce the same rule even if application code is bypassed. Production
processor routes remain `404`, and no candidate is represented as having
passed real audio yet.

The benchmark evidence boundary is operational without weakening that claim.
A recent Super-admin can import a closed, pinned-runner JSON submission; the
Worker re-evaluates it, stores canonical raw evidence privately by input
SHA-256, exposes only content-free summaries, and records replay-safe D1/audit
evidence. Synthetic integration fixtures prove the path, but no real
rights-cleared corpus has been imported.

`npm run prepare:alignment-benchmark-source -- ...` prepares an approved local
source without committing media or transcript content. It uses the existing
YouTube JSON3 reference parser, chooses the requested number of non-overlapping
caption-dense two-to-five-minute windows, writes deterministic 16 kHz mono PCM
fixtures and clipped unreviewed references, and records source ranges, hashes,
rights scope, FFmpeg identity, and explicit human-review requirements. It
fails closed when duration or speech density is insufficient and never turns
automatic captions into reviewed transcript or H1 gold evidence.

Stripe staging readiness has a repeatable read-only operator gate:
`npm run gate:stripe:staging`. It compares the exact D1 show/Price projection
with test-mode Stripe Product/Price metadata, the hardened Customer Portal,
the dedicated webhook event set, installed secret names, the webhook journal,
the Checkout kill switch, and accountant tax state. It never reads a Worker
secret value or creates a Stripe object. The command succeeds when the posture
is safe and reports expected activation blockers; add `-- --require-ready` to
make any remaining blocker fail a promotion check.

The chapter workbench wraps the original normalized `episode_chapters` rows
with optimistic mutations, immutable revision snapshots, Admin approval, and
content digests instead of introducing a second editable chapter model.
Approved chapters are projected as Podcasting 2.0 `application/json+chapters`
documents for public or entitled private feeds. Public chapter reads share the
canonical News visibility gate; private early-access/bonus reads recheck the
bearer token and show entitlement. RSS emits one `<podcast:chapters>` tag only
when an approved revision exists. The canonical News page renders the same
document as accessible seek controls through the existing Digest/Podcast
player—there is no second audio runtime.

The same immutable transcript approval now projects checksum-verified,
speaker-aware WebVTT for public and entitled private feeds. RSS emits one
Podcasting 2.0 `<podcast:transcript>` tag per approved English/Spanish
language only after the same bounded canonical parse and SHA-256 check used by
the VTT route; malformed or tampered rows are omitted instead of advertising a
dead URL. Private-only episodes keep tokenized transcript URLs and recheck
entitlement on every request. Feed validator v3 rejects unsafe transcript
metadata, requires one immutable Podcasting 2.0 channel UUIDv5, and treats
older validation evidence as stale before launch/cutover.

Production review is a separate private collaboration layer over the same
versioned audio, transcript, chapter, clip, and ad-plan targets. Timestamped
plain-text notes, open/resolved blockers, assignment, and the four review
states retain the exact target revision/digest and become historical when that
target changes. A separate read-only publication snapshot now combines the
unchanged legacy Publish prerequisites with strict launch-candidate evidence
for timing, bilingual transcripts, word alignment, chapters, every current
review target, clip/ad freshness, News, RSS, YouTube applicability, and the
10+ directory certification. The directory node is ready only after at least
ten enabled destinations have owner setup, a validated exact canonical feed,
an evidence-backed ingestion observation, and a recorded failed-to-observed
recovery sequence. One typed read-only certification primitive now supplies
both the Distribution response and publication-readiness node, so disabled
historical evidence and proof counters cannot diverge between screens. Its
digest is stable for the same evidence. A
three-mode publication gate now keeps production on legacy checks, compares
the exact snapshot without blocking in staging shadow mode, and can later
enforce it through a configuration-only rollback switch. Enforcement supports
only a recently authenticated, show-scoped Admin/Super-admin override with a
private bounded reason and content-free audit metadata.

The first clip-factory boundary now turns an approved transcript cue range
into a versioned 9:16, 1:1, or 16:9 `captioned-waveform-v1` recipe. Producer
writes are optimistic/idempotent and snapshot the exact transcript plus source
audio; word boundaries remain unavailable without a matching passed alignment.
A render request returns a checksummed private processor manifest. The pinned
staging GitHub workflow retrieves the exact source through a signed streaming
Worker route, produces deterministic H.264/AAC MP4s with FFmpeg and
ImageMagick-rasterized captions, fully decodes them, and streams the result
back through the Worker with an R2-verified SHA-256. The callback accepts ready
evidence only when MP4 dimensions/duration and private-R2 checksum metadata
match that manifest. The complete source/render/upload/callback path has passed
the local Worker+D1+R2 runtime gate; the remote GitHub workflow still requires
the reviewed workflow to exist on the default branch and a queued staging
render. Ready renders have authenticated range-safe preview/download plus
checksum-bound WebVTT and SubRip sidecars rebuilt from the same approved cues,
plus a bounded, filterable cross-episode Marketing library; none of those
routes exposes an R2 key or creates a second caption record. A separate
public-selection record now snapshots exact current
render/R2 evidence, requires recent-super-admin approval or withdrawal, and
serves only a due public episode through short-cache metadata and range-safe
MP4 routes. Production keeps that mode disabled. A separate staging-only
Shorts boundary now lets Producer+ prepare one
immutable private/unlisted draft for the current ready render. Approval
requires a recently authenticated super-admin. The committed mode records only
a dry run; an actual upload additionally requires explicit `controlled_test`
mode and launch-channel OAuth secrets. Before queueing, approval exchanges the
refresh token and requires YouTube's authenticated `mine=true` channel list to
contain the exact configured channel ID. Public visibility is structurally
rejected. No production public clip route or production Shorts upload is
enabled.

Full-episode video now has a parallel staging-only boundary. Its draft pins the
current publication revision, YouTube root job, completed MP4 upload, private
R2 bytes/ETag, and exact launch channel. A recent super-admin approval records
a provider-free dry run or, only under explicit `controlled_test`, queues one
unlisted upload at public release. The same authenticated-channel preflight
must pass before either the publication or root job can be queued. Committed
provider evidence is replay-safe; interrupted or ambiguous uploads are
quarantined for manual reconciliation. Production and public visibility remain
disabled.

Pool supporter benefits use a separately gated, signed grant/revoke bridge and
email-bound one-time codes redeemed through the authenticated Dust Wave member
site. The existing scheduler reconciles fixed-duration expiry and aggregate
access, and private-feed rotation atomically invalidates the prior bearer URL.
The bridge is disabled in every environment by default.

The first Marketing boundary reuses the versioned Pool/Store tagged-link and
QR primitives without creating a second implementation. Producer+ can now
save show-scoped tagged links through a bounded, keyset-paginated, audited D1
adapter; URL and referral normalization still come from that exact shared
module, and the admin API exposes no actor identity. An authenticated listener
may explicitly opt into or out of one show's English or Spanish announcements;
subscription access never implies consent. Producer+ can review a normalized
WYSIWYG announcement against the count and pseudonymous revision of explicitly
opted-in, currently entitled listeners. A recently authenticated Admin can
freeze that exact review into a durable, audited, suppression-aware outbox.
Staging records dry-run deliveries without contacting Resend and production
remains disabled. Recipient addresses are encrypted at rest, rechecked only at
send time, and never exposed to the admin API.

Migration `0012` adds an isolated staging decision exercise: an authenticated
Producer can persist one deterministic immutable manifest and receive an
HMAC-bound, expiring URL that streams only that snapshotted rendition. The
permanent enclosure does not call it. Production hard-codes the mode disabled,
and qualification is still a trusted internal contract rather than a public
telemetry endpoint.

The staging ad-plan processor is intentionally a manual workflow until a new
least-privilege Podcast R2 token is installed:

```sh
gh workflow run process-ad-plan.yml \
  -f plan_manifest="$(jq -c . /absolute/path/to/podcast-ad-plan.json)"
```

The manifest is downloaded from the authenticated Episode workbench. The
workflow can only target the isolated staging bucket and staging callback.

The clip processor needs only the existing staging-only
`MEDIA_PROCESSOR_CALLBACK_SECRET` in the Worker and the `podcast-staging`
GitHub environment. It does not receive R2 credentials: signed source and
output routes stream through the Worker's private R2 binding. See
[`docs/CLIP_RENDER_GATE.md`](docs/CLIP_RENDER_GATE.md).

Source-audio QC uses the same isolated secret and credential-free streaming
pattern with separate `audio-qc` request purposes. The pinned manual workflow
fully decodes the current immutable source, submits a shared-contract report,
and retains no audio artifact. A zero-blocker run against the current source
and current show policy can now be explicitly approved by a Super-admin as a
revisioned working master. Private A/B enhancement previews reuse the same
signed streaming pattern and `@dustwave/media-core` contract; their original
and enhanced excerpts use the same MP3 profile and can never become a master.
A selected ready preview can now queue one staging-only full-length derivative
bound to the exact current master. The pinned processor fully decodes a 48 kHz
192 kbps MP3, uploads checksum-verified multipart parts through the Worker,
and queues the same source-audio QC contract against that completed private
candidate. Only a zero-blocker, current-policy result can be explicitly
promoted by a Super-admin. Replacing a master invalidates current transcript,
chapter, and clip approvals, and the publication-readiness graph now blocks
without an exact approved master. Peaks and delivery rendering remain
separate downstream boundaries.

The public show and episode pages remain canonical on `dustwave.xyz`. Episode
publishing creates or updates a News page in the website repository.
Publish and readiness now share one pure root-publication planner: RSS and News
always apply; YouTube applies only to a video-bearing, non-premium-bonus
episode. The versioned News snapshot is discriminated as `full_episode` or
`premium_teaser`. A teaser contains public identity, title, summary, canonical
and subscription links, public release time, and publication revision only;
it cannot carry an enclosure, download, transcript, chapters, duration,
private-feed token, or premium-release time.

The 11-platform directory registry is now show-scoped. One reviewed publish
action updates the canonical feed/News/YouTube job graph and creates monitored
per-directory ingestion states, while preserving the truth that Spotify,
Apple Podcasts, and the other launch directories require one-time owner setup
and normally follow RSS rather than accepting a direct Dust Wave upload.
The same role-scoped episode view reports the immutable RSS, canonical News,
and YouTube root-job revision/status separately, including bounded failure
evidence, so directory lag cannot hide a failed publication channel.
Producer, Admin, and Super-admin roles can explicitly retry one failed root job
for the exact current revision. Conditional audit/requeue state, atomic worker
claims, Cron fallback, and a bounded stale-running lease keep recovery
idempotent without creating a new episode revision.
After owner setup, Producer+ operators can reconcile a current episode revision
as observed only with a bounded HTTPS listing/dashboard evidence link, or as
failed with a bounded detail. Stale revisions, incomplete setup, and disabled
directories fail closed. Each non-idempotent transition also creates an
append-only launch-evidence event, so recovery is derived from an actual later
observation rather than a checkbox. Publish independently validates the exact
generated RSS document, its strong ETag, required podcast metadata, unique
GUIDs, and every enclosure under a 5 MiB bound before the RSS root job can
succeed. The admin renders all four certification states in English or Spanish;
the audit trail stores only evidence-presence booleans, not evidence text or
URLs.

The permanent feed and media origins are reserved as `feeds.dustwave.xyz` and
`media.dustwave.xyz`. Both will terminate at the Podcast Worker; R2 remains
private so premium access, dynamic ad decisions, byte ranges, and telemetry
cannot be bypassed. No DNS record is attached before the applicable staging
routes pass.

Each show has one stored Podcasting 2.0 channel UUIDv5. Ópera en la Selva's
identity is assigned from its permanent public feed URL; public and private RSS
emit the same immutable value so later host moves do not split the show across
the open podcast ecosystem.

## Local setup

This consumer pins Dust Wave Platform `v0.23.0` at commit
`a0006c3e0c3f8ab814387491753989956adbbe94`. Package links are exact and the
pin contract fails when the gitlink, local manifests, or lockfile drift. The
Podcast Worker retains its D1/R2/Queue bindings, sessions, provider keys,
publishing rules, deployment, and one-commit rollback authority.

Podcast consumes Platform's bounded raw-body Resend/Svix verifier while
retaining its templates, recipients, consent, delivery journal, suppression,
provider transport, retry policy, credentials, routes, and webhook effects.
It also consumes Platform's bounded request validation, managed provider-fetch
timeout, and policy-injected CORS/JSON response primitives. Podcast retains its
request schemas, route authorization, exact allowed origins, CSRF header,
private cache/indexing policy, provider retry decisions, and deployment.

Podcast also consumes Platform's bounded, timeout-enforced GitHub Contents API
transport for public reads and credentialed publication. Podcast retains live
publish mode, repository and branch selection, publication schemas, commit
messages, authorization, credentials, effects, deployment, and rollback.

```sh
git submodule update --init --recursive
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Provider credentials belong in `.dev.vars` locally and Cloudflare Worker secrets
outside local development. Do not put secrets in `wrangler.jsonc`.

Architecture and promotion decisions live in [`docs/adr`](docs/adr). The
non-secret human inputs that gate production are kept in
[`docs/OWNER_ACTIONS.md`](docs/OWNER_ACTIONS.md).

- [`docs/ROADMAP.md`](docs/ROADMAP.md) — implementation sequence and public
  positioning gates
- [`docs/API.md`](docs/API.md) — current HTTP surface and authentication
  contract
- [`docs/SECURITY.md`](docs/SECURITY.md) — trust boundaries and secret handling
- [`docs/PROCESSOR_DISPATCH_AUTOMATION.md`](docs/PROCESSOR_DISPATCH_AUTOMATION.md)
  — staging processor discovery, GitHub dispatch, retries, and rollback
- [`docs/ALIGNMENT_GATE.md`](docs/ALIGNMENT_GATE.md) — English/Spanish
  word-alignment evidence and launch thresholds
- [`docs/CLIP_RENDER_GATE.md`](docs/CLIP_RENDER_GATE.md) — staging clip
  processor trust boundary, execution, evidence, and rollback
- [`docs/VIRTUAL_AUDIO_GATE.md`](docs/VIRTUAL_AUDIO_GATE.md) — request-time
  audio assembly and real podcast-client evidence gate
- [`docs/DYNAMIC_ADS_GATE.md`](docs/DYNAMIC_ADS_GATE.md) — deterministic
  house/direct sponsor decisions, privacy, pacing, and fallback gate
- [`docs/STAGING_RUNBOOK.md`](docs/STAGING_RUNBOOK.md) — backup, migration,
  deployment, bootstrap, smoke test, and rollback procedure

## Verification

```sh
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
npm run gate:public:staging
```

Remote migrations and deploys are intentionally separate commands. Apply and
exercise staging first; production promotion requires an explicit release
decision. After an authorized production migration or deploy, run
`npm run gate:public:production`. The public gates are read-only and verify the
canonical RSS body, artwork response and size budget, security/cache headers,
and conditional ETag behavior.
