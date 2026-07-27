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
  Distribution, Marketing, Analytics, Sponsors, Subscribers, and Settings.
- Reuse the Pool/Store WYSIWYG editor for episode notes and transcript editing.
- The first transcript-review slice now reuses its restricted timed-text mode
  for versioned English/Spanish cues, optimistic/idempotent saves, confirmed
  speaker labels, Admin approval, and matching-alignment readiness. Canonical
  News pages now fetch the latest immutable, hash-verified approved revision
  per language, render it as safe plain timed text, and seek the shared Digest
  player from accessible timestamps. Draft/future/premium-only content stays
  outside the public projection; word-linked controls remain alignment-gated.
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
  content-free summaries.
- Generate captioned clips and audiograms locally or on existing Cloudflare
  infrastructure, with templates and safe-area previews.
- The first clip contract now versions approved-transcript cue selections,
  locks word cuts behind matching passed alignment, and accepts only signed
  checksummed private-R2 MP4 evidence. The deterministic staging FFmpeg
  workflow now renders and fully decodes all three aspect ratios, with
  purpose-bound Worker streams and native R2 SHA-256 verification. Ready
  outputs now have an authenticated, show-scoped, range-safe admin preview and
  MP4 download path. The Marketing tab now adds one bounded, keyset-paginated
  cross-episode library with episode, aspect, and current-render-state filters
  while reusing that exact preview/download boundary. The staging-only Shorts
  path now supports an immutable Producer draft, recent-super-admin dry run,
  and explicitly gated private/unlisted queue with provider channel/privacy
  verification and terminal duplicate prevention. A remote clip workflow run,
  installation of launch-channel OAuth secrets, and one tightly controlled
  unlisted production-channel test remain evidence gates.
- Publish public RSS and canonical News pages; keep stable GUID and enclosure
  identity across retries.
- Publish audio-only or native-video episodes to the configurable YouTube
  channel at the public release time. Early-access episodes wait for public
  release; premium-only bonuses never publish to YouTube. The first
  full-episode boundary is now implemented as a staging-only, unlisted
  controlled test: its recent-super-admin approval pins the publication
  revision, distribution job, completed MP4 upload, R2 key/bytes/ETag, and
  launch channel before Queue consumption. Ordinary Publish remains a
  provider-free dry run, production mode remains inert, and any interrupted
  or provider-ambiguous upload is quarantined for reconciliation instead of
  replayed. The implemented reconciliation path requires a recent
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
  evidence in Podcast D1.
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
  disabled. A signed-webhook exercise plus a tightly controlled staging live
  send remain promotion gates before enabling the Resend sender.
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
