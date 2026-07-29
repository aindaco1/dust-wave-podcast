# Podcast roadmap

The platform is multi-show-ready from the first migration while the initial
public interface launches with one show, **Ópera en la Selva**. Every show page
exists before it has episodes. Every published episode receives one canonical
Dust Wave News page and appears on its show page.

## Product promise

**Streamlined publishing**

> With just one click, we send your episodes live to 10+ platforms like
> Spotify, Apple and other major platforms.

**Publicación simplificada**

> Con un solo clic, publicamos tus episodios en más de 10 plataformas, como
> Spotify, Apple y otras plataformas principales.

This promise becomes public only after at least ten configured destinations
have passed owner verification, feed validation, ingestion observation, and
failure-recovery checks. The Publish action commits one immutable publication
revision and fans out idempotent work for public and premium RSS, the canonical
News page, the show aggregate, YouTube, announcements, and directory health.
It does not bypass a directory's one-time submission, review, or ingestion
delay.

The launch registry is Spotify, Apple Podcasts, YouTube Music, Amazon
Music/Audible, Pocket Casts, Overcast, Castbox, Podcast Addict, Player FM,
iHeartRadio, and Deezer.

## Delivery sequence

### H0 — shared foundations and safe staging

- Extract versioned worker authentication, provider, validation, admin-shell,
  rich-editor, table/filter, marketing-link, and analytics primitives only
  where Pool and Store behavior can be preserved behind adapters.
- Keep the responsive-tab extraction complete and narrow: one shared
  dependency-free controller owns option rebuilding, selection mirroring, and
  accessibility; Podcast, Pool, and Store retain their labels, activation,
  classes, spacing, breakpoints, routes, and session state through thin
  adapters.
- Converge editors in two independently reversible layers. First, move only
  the already-characterized Markdown/HTML conversion, safe-link validation,
  paste sanitization, and emphasis-boundary rules behind a classic-script
  bridge backed by the same `@dustwave/admin-shell` codec used by Podcast.
  Then evaluate block-editor chrome separately. Pool's campaign/announcement
  blocks support underline and multiple inline/block policies; Store's product
  descriptions additionally admit validated first-party images and use a
  different product-save schema. Keep those domain adapters local until
  consumer-owned fixtures prove byte-equivalent round trips, paste behavior,
  undo/selection behavior, image handling, and save payloads. Do not replace
  either block editor with Podcast's smaller timed-text editor merely because
  their toolbars look similar.
- Keep Pool, Store, and Podcast as separate runtimes and sessions.
- Create isolated Cloudflare staging bindings and dry-run provider modes.
- Add passwordless super-admin authentication, audit records, R2 multipart
  uploads, canonical episode identity, RSS, byte-range media delivery, and
  retry-safe publishing.

### H1 — launch production workbench

- Build the common admin shell at `/admin/podcasts/` with Shows, Episodes,
  Production, Distribution, Marketing, Sponsors, Analytics, Subscribers,
  Premium, and Settings. The single-show launch UI now keeps the show catalog
  and safe RSS-import planning in Overview while one separate bilingual
  Settings tab owns the existing show editor. Episodes and Settings reuse
  synchronized show selectors and one save form/state path; no settings
  payload or update route is duplicated. That single form now covers the
  Worker-supported primary language, lifecycle, author, category, artwork,
  explicit-content policy, premium benefits, early-access default, and
  YouTube destination. Canonical-page and RSS addresses are visible but
  read-only, and entering the archived lifecycle requires an explicit
  confirmation. RSS author identity is read from that per-show record rather
  than a network-wide environment override, so adding another show cannot
  silently inherit Ópera en la Selva's author. Artwork and channel
  destinations are enforced again at the
  Worker boundary as credential-free, port-free, fragment-free HTTPS; the
  latter accepts only canonical YouTube channel hosts and paths.
- Keep show pages and feeds DRY through an explicit site-catalog projection.
  Preview reads the configured Git ref, reports only Worker-owned field drift,
  and preserves site-owned local artwork variants, wordmark, social card,
  source link, benefit copy, and episode fallback. Publish is recent
  Super-admin-only, requires the reviewed Git blob SHA and exact typed
  confirmation, defaults to dry-run, and uses one optimistic GitHub Contents
  write only when the environment is deliberately live.
- Make the launch monthly and annual USD prices genuinely configurable per
  show without hiding a Stripe mismatch. A separate recent-Super-admin action
  requires the exact current pair and typed show confirmation, applies both
  values atomically, clears only provider Price links made stale by the
  change, and records one audit event. It is intentionally pre-launch-only:
  checkout must be off and any subscription or checkout history locks the
  mutation. Provider provisioning remains a separate reviewed Stripe step.
- Add a migration path comparable to established podcast hosts. The first
  boundary is a recent-Super-admin, explicit-rights, no-write RSS preview:
  bounded public-HTTPS fetches and safe XML reduction report which source
  items are real migratable audio without exposing the owner email. The
  reviewed-plan boundary freezes up to 25 selected source identities, exact
  feed/metadata digests, query-stripped display URLs, and the source
  Podcasting 2.0 channel UUIDv5 or explicit absence. The bilingual admin
  compares that identity with the destination show before selection; invalid,
  conflicting, or valid-but-unassigned identity blocks planning. No migration
  route silently replaces show identity. A separate recent-Super-admin action
  can adopt the exact previewed UUIDv5 once only while a future destination is
  empty and `coming_soon`; immutable source provenance, explicit rights, and
  irreversible-action confirmation are required, and the action cannot import
  or publish. The plan then requires a
  recently authenticated Super-admin to re-enter and re-fetch the exact feed
  before review. Preparing, reviewing, listing, or canceling this immutable
  evidence performs zero media copies and zero episode mutations. The next
  boundary is now implemented only in isolated staging: one more exact
  reconciliation plus explicit per-item slug/language mapping queues bounded,
  retry-safe streaming copies into private R2 and creates unpublished draft
  episodes with stable source identities and post-copy byte/SHA-256 evidence.
  Production execution stays disabled, protected source URLs are encrypted and
  short-lived, and the boundary has no News/RSS/YouTube/directory/provider
  publication path. An isolated-staging reconciliation gate now verifies and
  immutably freezes the exact private R2 copy, draft identity, completed
  source-upload evidence, and zero-publication state. It cannot change an
  episode or object. Working-master review and publication remain later gates,
  and the old-host checklist is deliberately non-activating until imported
  episodes are public, the canonical feed is revalidated afterward, 10+
  directories are re-observed, and the owner separately attests the redirect.
  The owner-control attestation is now implemented in isolated staging as an
  immutable hash-only record tied to the old feed, new feed, copy digest, and
  either a provider-managed permanent redirect or self-managed HTTP 301. It
  stores no credential, contacts no host, and cannot activate anything. Never
  activate a 301 redirect during preview, plan review, private copy,
  reconciliation approval, or owner attestation.
  The next isolated-staging boundary now freezes one immutable cutover packet
  only after every imported current revision completes RSS and canonical News,
  the exact canonical feed validates afterward, at least ten directories
  retain owner/ingestion/recovery certification and are observed again after
  that validation, and the owner-control attestation remains current. The
  packet is hash/count/version evidence only: it cannot contact the old host,
  submit a directory, change DNS, or activate a new-feed tag or HTTP 301.
  A final isolated-staging approval now binds one still-fresh packet to the
  attested redirect method after explicit final review, manual-action,
  rollback, and zero-activation confirmations. It is immutable, idempotent,
  and becomes stale with the packet. The boundary prepares only an auditable
  owner handoff: automatic activation remains unavailable, production remains
  closed, and no host, DNS, provider, R2, episode, publication, directory,
  email, ad, or billing state changes.
- Reuse the Pool/Store WYSIWYG editor for episode notes and transcript editing.
- The initial Hilite-value show-notes assistant now reuses that editor and the
  existing Workers AI binding without a new SaaS or credential. Producer+
  generation requires the latest immutable, speaker-confirmed, checksum-
  verified approved English/Spanish transcript, bounds long input to
  deterministic head/middle/tail cue evidence, validates a strict bilingual
  JSON/Markdown response, and audits only content-free digests/counts. The
  separate review card never saves or publishes; “Replace editor notes” is
  still only an unsaved local edit, with confirmation when notes already
  exist. Staging is rate-limited and enabled; production remains disabled.
- The companion Hilite-value chapter assistant reuses the same verified
  transcript, Workers AI, audit, language, and rate-limit primitives without a
  new provider. It requires complete bounded cue coverage, accepts only ordered
  exact cue identities, derives times server-side, and reruns the normal
  chapter contract. The bilingual review card can replace only unsaved editor
  state; versioned save and Admin approval remain separate. Staging is enabled
  and production remains disabled.
- The first Hilite-value social discovery assistant now reuses that same
  verified-transcript and Workers AI core. It proposes at most six
  chronological, non-overlapping 15–90 second ranges using exact cue
  identities; the Worker derives every timestamp and audits no generated text.
  A bilingual review card can fill only a new unsaved vertical segment recipe.
  Existing versioned save, H1 word alignment, private rendering, approval, and
  publication controls remain the only state-changing path. Staging is enabled
  and production remains disabled.
- The first transcript-review slice now reuses its restricted timed-text mode
  for versioned English/Spanish cues, optimistic/idempotent saves, confirmed
  speaker labels, Admin approval, and matching-alignment readiness. Canonical
  News pages now fetch the latest immutable, hash-verified approved revision
  per language, render it as safe plain timed text, and seek the shared Digest
  player from accessible timestamps. Draft/future/premium-only content stays
  outside the public projection; word-linked controls remain alignment-gated.
  Producer+ review now also has one page-bounded speaker-range aid for long
  transcripts. It changes only visible speaker inputs in the local draft,
  requires a separate explicit confirmation before marking names confirmed,
  and reuses the existing versioned Save path; it cannot alter caption
  text/timing, call the Worker, or approve a revision. The same workbench now
  accepts bounded WebVTT and SubRip files through a browser-local, review-only
  parser. It caps the normalized review at 1 MB and 10,000 ordered,
  non-overlapping cues, enforces episode and per-cue duration bounds, keeps
  explicit VTT voice labels unconfirmed, preserves ambiguous SRT prefixes as
  caption text, and requires confirmation before replacing existing work. It
  performs no upload or API call and reuses the existing versioned Save path.
  A companion browser-local search navigator reuses the same visible-text
  reducer and paginated cue focus path across at most 10,000 loaded cues. It
  finds caption or public-speaker text with English/Spanish case and accent
  folding, excludes hidden Markdown link destinations, stores nothing, calls
  no API, and changes no cue or approval state.
  The review workbench also shares the `@dustwave/admin-shell` 0.8.2 lifecycle
  guard characterized from Pool. Podcast retains transcript/chapter dirty
  baselines and localized policy while show, episode, language, chapter,
  logout, and browser-exit transitions fail closed against accidental loss.
  Transcript and chapter Save actions now also use Pool/Store's shared
  dirty-action primitive: clean drafts are disabled, dirty drafts receive the
  established focus-ring signal and `data-dirty-state`, and labels remain
  localized by Podcast.
  The same backward-compatible client boundary keeps credentialed admin/member
  requests as the default while the public show checkout explicitly omits
  cookies, matching the Worker's credential-free public CORS policy without
  changing Pool or Store behavior.
  The same workbench also
  exports the exact current saved revision as private checksum-verified WebVTT
  or SubRip while excluding unsaved edits and unconfirmed speaker labels; no
  export persistence or provider is introduced. The same approval now
  projects speaker-aware WebVTT and one Podcasting 2.0
  discovery tag per approved English/Spanish language, with tokenized
  entitlement-checked VTT for private early/bonus feeds. The v3 feed validator
  rejects malformed transcript metadata, requires the immutable Podcasting 2.0
  channel UUIDv5, and deliberately makes older valid evidence stale before
  launch or RSS cutover.
- The bilingual admin now also provides a deterministic, review-only transcript
  quality panel over the already loaded draft. It reports text-free counts for
  invalid timing, cues shorter than 0.5 seconds or longer than 10 seconds,
  reading speed above 25 visible characters per second, and public-speaker
  confirmation. Each category now keeps a bounded content-free cue-index list
  and exposes labeled previous/open/next controls, so a producer can traverse
  every matching cue across pagination rather than repeatedly returning to the
  first. Position survives the existing 100-cue page render and every action
  reuses the same focus path. These product review thresholds do not approve,
  reject, upload, retain, or export transcript content and do not replace
  listening or the separate word-alignment gate. A bounded opt-in browser
  fixture supports up to 10,000 synthetic cues; the 1,300-cue English/Spanish
  desktop/mobile regression passed without horizontal overflow, enforced CSP
  violations, or browser console errors.
- The first source-audio QC slice now snapshots a completed private source and
  show policy, fully decodes it in the pinned staging FFmpeg workflow, and
  records normalized codec/duration/sample/channel/bitrate, LUFS/LRA,
  sample/true-peak, clipping, DC-offset, channel-balance, silence, checksum,
  and resource evidence through the shared `@dustwave/media-core` contract.
  It remains non-destructive. The next completed boundary adds a revisioned
  Super-admin approval of the exact zero-blocker source as working master,
  private codec-matched A/B previews for curated enhancement presets, and a
  strict publication-readiness node. Replacing a master preserves authored
  material and immutable history while making transcript, chapter, and clip
  approvals stale. A preview is explicitly ineligible as a master.
- The first rights-cleared full-length staging source now passes that
  non-destructive boundary: its private R2 snapshot matched the authorized
  source byte-for-byte and completed with zero blockers. Three measured
  loudness/peak warnings intentionally keep normalization and limiting in the
  private enhancement-review path; the draft remains unpublished and outside
  News, RSS, distribution, and YouTube.
- The full-length enhancement boundary now snapshots a selected ready A/B
  preview and the exact current master, renders only its curated preset,
  uploads through checksum-verified multipart Worker streams, and creates an
  ordinary source-audio QC run for the completed candidate. It remains
  staging-only and private. A zero-blocker, current-policy result still needs
  an explicit Super-admin promotion before it becomes a new immutable master;
  it cannot replace delivery audio by itself.
- The delivery boundary now snapshots that exact current master into one
  deterministic 44.1 kHz stereo 128 kbps MP3 and bounded
  `dustwave-player-peaks-v1` document. The staging-only workflow fully decodes
  the output, validates every complete MPEG frame, verifies checksum-bound
  multipart uploads, and keeps both objects private until recent Super-admin
  approval atomically selects them for the episode. News/RSS publication now
  fails closed unless the selected audio and player peaks still descend from
  the current master. The bilingual workbench uses the existing Digest player
  for authenticated waveform preview and download.
- Keep operator launch checks content-free and replayable. The staging episode
  gate now reads only bounded statuses, revisions, counts, and D1 integrity;
  rejects an episode that has already escaped the isolated-draft boundary;
  verifies Cloudflare reported zero writes for every statement; and orders a
  ready enhanced-master decision ahead of delivery rendering so avoidable work
  cannot immediately become stale. It never returns transcript/caption text,
  object identity, hashes, review comments, email, or admin identity and cannot
  replace authenticated human approval.
- Transcribe Spanish and English and expose bounded confidence/provenance. The
  signed staging alignment bridge now binds the exact approved transcript,
  working master, normalized projection, adapter, and pinned runner; validates
  every returned word; and stops at human review. Approval has no override:
  it requires a matching real English/Spanish benchmark and clean-environment
  reproduction, with the same rule enforced by D1 triggers. Real
  rights-cleared corpus/model evidence remains the promotion gate. The
  operational import path now requires recent Super-admin authentication,
  re-evaluates the closed pinned-runner submission server-side, stores raw
  evidence privately by input digest, and exposes only replay-safe,
  content-free summaries. The parent now pins the green runner `release/0.2.0`
  benchmark-bundle assembler while the staging workflow separately verifies,
  fetches, and detaches at the exact reviewed model-execution commit selected
  by the Worker; updating benchmark tooling cannot silently change execution
  identity.
- Generate captioned clips and audiograms locally or on existing Cloudflare
  infrastructure, with templates and safe-area previews.
- The first responsive safe-area preview is now live in the bilingual clip
  recipe editor. It reuses the exact `captioned-waveform-v1` aspect,
  high-contrast caption, waveform, and 8%/18% safe-area contract for 9:16,
  1:1, and 16:9 without creating another media template or persistence path.
  Only the current approved transcript revision can populate it; authored cue
  content is inserted with DOM text nodes, and the UI labels the preview as
  layout-only because the private checksummed FFmpeg render remains
  authoritative.
- The first clip contract now versions approved-transcript cue selections,
  locks word cuts behind matching passed alignment, and accepts only signed
  checksummed private-R2 MP4 evidence. The deterministic staging FFmpeg
  workflow now renders and fully decodes all three aspect ratios, with
  purpose-bound Worker streams and native R2 SHA-256 verification. Ready
  outputs now have an authenticated, show-scoped, range-safe admin preview and
  MP4 download path. Each exact ready render also has private WebVTT and
  SubRip sidecars rebuilt from the same approved relative caption cues only
  after output, source, transcript, and manifest evidence revalidate; no
  second caption record or provider is introduced. The Marketing tab now adds one bounded,
  keyset-paginated cross-episode library with episode, aspect, and
  current-render-state filters while reusing those exact download boundaries.
  The staging-only Shorts
  path now supports an immutable Producer draft, recent-super-admin dry run,
  and explicitly gated private/unlisted queue with provider channel/privacy
  verification and terminal duplicate prevention. A remote clip workflow run,
  installation of launch-channel OAuth secrets, and one tightly controlled
  unlisted production-channel test remain evidence gates.
- The first public clip boundary now lets Producer+ prepare one exact current
  ready render and requires recent Super-admin approval/withdrawal. Its
  staging-preview metadata and range-safe MP4 routes repeat the canonical
  episode visibility gate and exact D1/R2 checksum/manifest evidence, expose
  no object identity, and point canonical ownership back to the episode News
  page. The canonical page consumer now has an executable bilingual DOM
  contract and a 320 px browser exercise covering 48 px actions, canonical
  copy/share state, zero horizontal overflow, and complete concealment for an
  empty/withdrawn response. Public metadata and MP4 responses now require
  revalidation on every reuse; a withdrawal changes the metadata ETag to an
  empty selection and makes the media route return no-store `404` without a
  second R2 read. The owner included captioned clips/audiograms in the initial
  launch scope. Keep production delivery disabled until the reviewed release
  is merged and the same controlled staging exercise passes against a real
  canonical episode.
- Publish public RSS and canonical News pages; keep stable GUID and enclosure
  identity across retries.
- Keep public release, early-access/bonus, subscription-expiry, assigned-tax,
  and publication-job schedules on one millisecond UTC RFC 3339 SQL clock so
  same-day ISO timestamps become due exactly and remain indexable.
- Publish audio-only or native-video episodes to the configurable YouTube
  channel at the public release time. Early-access episodes wait for public
  release; premium-only bonuses never publish to YouTube. The first
  full-episode boundary is now implemented as a staging-only, unlisted
  controlled test: its recent-super-admin approval pins the publication
  revision, distribution job, completed MP4 upload, R2 key/bytes/ETag, and
  launch channel before Queue consumption. Controlled approval now refreshes
  OAuth and requires YouTube's authenticated channel list to contain that
  exact channel ID before either D1 record or Queue job can become queued.
  Ordinary Publish remains a provider-free dry run, production mode remains
  inert, and any interrupted or provider-ambiguous upload is quarantined for
  reconciliation instead of replayed. The implemented reconciliation path requires a recent
  Super-admin either to verify the exact unlisted provider video and channel
  or to attest explicitly that no channel video remains; both outcomes are
  audited and neither replays an ambiguous upload. The audio-only fallback is
  now implemented behind the same staging boundary: it snapshots first-party
  show artwork, pins the current working-master and delivery-audio evidence,
  renders a fully decoded 1920×1080 H.264/AAC MP4 in a protected manually
  dispatched workflow, verifies every 32 MiB multipart checksum, and pins the
  completed R2 object into the existing approval contract. Delivery-audio,
  working-master, or artwork changes invalidate selection automatically.
  Native video remains the preferred source, production stays inert, and
  premium-only bonuses remain ineligible.

### H1 premium and revenue

- Sell per-show monthly and annual USD Podcast subscriptions through Stripe.
- Start Ópera en la Selva at $5/month or $50/year, no trial.
- Offer ad-free listening, configurable early access, bonus episodes, and at
  most one free mini-episode per show.
- Provide a Resend magic-link member page, one-time HMAC-backed private feed
  creation/rotation, and Stripe customer-portal access.
- Accept single-use Pool benefit codes for explicitly configured shows and
  benefit periods.
- Reuse the versioned Store tax calculator and manual Stripe Tax Rates only
  after accountant approval; Stripe Tax automatic calculation remains off.
- Keep Checkout behind an explicit kill switch. Use idempotent Stripe
  Customer/Checkout calls, webhook-projected source entitlements, and a scoped
  Customer Portal; retain only email/destination HMACs and immutable tax
  evidence in Podcast D1. The staging provider preflight now confirms the
  exact inactive test Product, $5 monthly and $50 annual Prices, hardened
  Portal profile, required signed-webhook event set, installed test API
  credential, and two processed provider-signed expiration events with no
  failed journal entry. Checkout and every provider object remain inactive
  pending the accountant-approved manual tax matrix and controlled purchase.
- Preserve independent Stripe, Pool, and manual entitlement sources beneath
  one access projection so cancellation/revocation of one source cannot remove
  access granted by another.
- The first Subscribers workbench boundary now exposes only Super-admin,
  private/no-store, keyset-paginated aggregate/source state, feed and consent
  booleans, and bounded formula-safe CSV. It intentionally excludes every
  email/address/token field while retaining provider references needed for
  owner support.
- The first renewal boundary now re-evaluates a transient `customer.updated`
  address through the shared Store-derived calculator, stores only an HMAC and
  rate-change outcome, reconciles each recognized subscription invoice event
  to its immutable Checkout snapshot, and exposes a bounded non-PII
  Super-admin JSON/CSV accountant export. Keep it preview-only until the
  accountant-approved rate-change and renewal policy authorizes provider
  mutation and a Stripe test-clock matrix passes.

### H1 sponsors and dynamic audio

- Limit inventory to Dust Wave promos and directly sold sponsors.
- Separate producer marker intent, FFmpeg/frame-validation evidence, and human
  approval; never let browser input directly mark program segments ready.
- Normalize each episode once to the versioned delivery profile and split only
  on complete MPEG frame boundaries under a plan-specific private R2 prefix.
- Issue expiring HMAC-bound decision URLs over immutable manifest/object
  evidence; deduplicate qualifications and enforce hard caps atomically.
- Select approved pre-, mid-, and post-roll creative at request time by show,
  episode, position, campaign date, and normalized device/app.
- Require raw-frame creative audio and an immutable, recomputed equal-byte
  contract between sponsor and house/filler renditions before activation.
- Select deterministic house fallback per slot only from approved inventory
  with an exact validated byte, duration, MIME, and profile match; snapshot its
  immutable campaign/creative/object evidence with the decision.
- Preserve a validated preassembled-file fallback until request-time assembly
  passes compatibility, latency, caching, disclosure, and measurement gates.
- The guarded enclosure boundary now reuses the same immutable selector for
  admin diagnostics and runtime requests, normalizes app/device from the user
  agent without persistence, and issues a no-store signed redirect only when
  the environment mode, both show/episode flags, qualification secret, exact
  house coverage, and equal-byte contract are ready. Completed direct-ad byte
  windows qualify atomically; partial, canceled, HEAD, house-fallback, or
  failed streams do not. Staging remains `staging_validate` and production
  remains `disabled` until the recorded client/load/pilot evidence passes.

### H1 distribution, marketing, and analytics

- Track setup, submission, ingestion, observation, and failure state for each
  directory rather than implying direct file upload to RSS-following apps.
- Keep a credential-free owner-action checklist per show/directory: responsible
  account label, verification state, submission date, provider receipt or
  dashboard URL, public listing, and bounded notes. Never store provider
  passwords or verification codes.
- Keep the public “10+ platforms” promise behind the implemented certification
  gate: Publish validates and fingerprints the exact generated RSS before its
  root job succeeds; every non-idempotent directory observation/failure becomes
  immutable evidence; and a destination counts only after owner setup, feed
  validation, observed ingestion, and a real failed-to-observed recovery
  sequence. At least ten enabled destinations must pass all four proofs.
- Reuse the versioned Pool/Store Marketing boundary for policy-injected tagged
  URLs and accessible PNG/SVG QR generation. The Dust Wave adapter now saves
  show-scoped tagged links in audited D1 state with optimistic updates and
  bounded keyset reads while retaining the shared normalizer and QR engine.
- Keep announcements consent-safe: the implemented WYSIWYG review counts only
  explicitly opted-in, currently entitled listeners and returns pseudonymous
  revision hashes without recipient identities. The durable outbox now freezes
  that exact audience behind recent Admin approval, rechecks consent,
  entitlement, destination HMAC, and suppression at delivery, exposes a
  one-click unsubscribe path, consumes signed Resend events idempotently, and
  retains only count-level admin evidence. Staging is dry-run and production is
  disabled. The dedicated staging webhook now rejects unsigned requests and
  has passed a signed unmatched-event plus exact-replay deduplication exercise
  with its active rotated secret. A tightly controlled consented staging live
  send, matched delivery transition, and suppression exercise remain promotion
  gates before enabling the Resend sender.
- Keep the implemented portable embeds and build-time share-card previews
  read-only. Add scheduling only after its storage, accessibility, privacy,
  cancellation, and cache contracts are characterized.
- Reuse Pool/Store reporting patterns for public and premium delivery, player
  engagement, sponsors, subscriptions, YouTube, and publication health. The
  implemented audience slice now exposes show-scoped 7/30/90-day qualified
  downloads, first-party engaged plays, point-in-time active premium listeners,
  daily trends, top episodes, normalized breakdowns, daily first-party
  web-player 25/50/75/100 completion, and a formula-safe CSV. Completion uses
  cumulative foreground playback rather than playhead position and is never
  represented as third-party-app retention.
- Keep raw delivery data privacy-minimized, methodology-versioned, deduplicated,
  filterable, and exportable. `dustwave-analytics-v1` stores no raw IP or user
  agent: an HMAC daily uniqueness key expires after 35 days, exact aggregate
  rollups expire after 400 days, and Analytics Engine receives only normalized
  best-effort telemetry. The method is deliberately labeled provisional and
  not IAB-certified.
- Reuse the original normalized chapter rows behind a versioned review header,
  immutable approvals, Podcasting 2.0 public/private JSON, RSS tags, and the
  existing Digest/Podcast player. Keep draft/future/premium visibility
  fail-closed and remote chapter artwork out of the first-party page runtime.
- Add private exact-revision production review across current audio,
  transcripts, chapters, clips, and ad plans: timestamp/range notes,
  assignment, open/resolved blockers, four simple review states, historical
  staleness, and non-enforcing readiness before a later publication gate.
- Keep the implemented read-only publication snapshot DRY with the current
  Publish prerequisites while explaining strict launch-candidate state across
  release timing, bilingual transcript/alignment, chapters, every current
  review target, clip/ad freshness, News/RSS/YouTube, and directory setup.
  Preserve stable evidence hashing and no external I/O.
- Keep the implemented exact-snapshot gate behind `legacy|shadow|enforce`:
  staging observes digest/revision matches in shadow; production remains
  legacy. Bind the final D1 batch to monotonic episode/show/global evidence,
  abort every side effect on conflict, and allow only a recently authenticated
  show Admin/Super-admin to store a bounded private override reason.
- Keep Publish, readiness, and contract tests on one root-publication planner.
  RSS and canonical News apply to every episode; YouTube applies only to a
  video-bearing non-premium-bonus episode. Publish premium bonuses through the
  versioned media-free News teaser contract and render the same discriminator
  on the canonical page, show aggregate, and noindex embed without player,
  enclosure, transcript, chapter, duration, token, or premium-time leakage.
- Advance publication revisions only after any older running provider work is
  terminal; atomically cancel retryable superseded jobs and revalidate every
  Queue message against its durable revision, show, and destination before a
  provider adapter can run.

### Post-launch

- Expose the multi-show/network interface already supported by the data model.
- Add saved and scheduled reports, richer campaign pacing, live/video clips,
  collaboration workflows, listener Q&A, and deeper transcript
  discovery.
- Treat remote multitrack recording as a separately gated product after a
  browser/device recovery spike.

## Promotion gates

No production route, paid checkout, live GitHub write, live YouTube upload,
directory submission, sponsor campaign, or public “10+ platforms” claim is
enabled without its documented staging evidence and owner/provider setup. See
`STAGING_RUNBOOK.md` for the operational gate and the comprehensive execution
plan deliverable for the full acceptance matrix.
