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
- Process source audio, validate delivery files, extract duration/loudness, and
  generate player peaks.
- Transcribe Spanish and English, expose confidence, and block approval unless
  the word-alignment quality gate passes or a super-admin records an audited
  override.
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
  release; premium-only bonuses never publish to YouTube.

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
- Before live recurring billing, add renewal/address-change tax
  re-evaluation, invoice-to-tax-snapshot reconciliation, rate-change preview,
  and accountant export evidence.

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

### H1 distribution, marketing, and analytics

- Track setup, submission, ingestion, observation, and failure state for each
  directory rather than implying direct file upload to RSS-following apps.
- Keep a credential-free owner-action checklist per show/directory: responsible
  account label, verification state, submission date, provider receipt or
  dashboard URL, public listing, and bounded notes. Never store provider
  passwords or verification codes.
- Reuse the versioned Pool/Store Marketing boundary for policy-injected tagged
  URLs and accessible PNG/SVG QR generation. The first Dust Wave share kit is
  browser-only and does not persist campaign state.
- Keep announcements consent-safe: the implemented WYSIWYG review counts only
  explicitly opted-in, currently entitled listeners and returns pseudonymous
  revision hashes without recipient identities. Add a durable
  suppression-aware outbox, unsubscribe path, audited approval, and an
  independently gated Resend sender before any delivery route exists.
- Add saved tagged links, portable embeds, share-card previews, and scheduling
  only after their storage, accessibility, privacy, and cache contracts are
  characterized.
- Reuse Pool/Store reporting patterns for public and premium delivery, player
  engagement, sponsors, subscriptions, YouTube, and publication health.
- Keep raw delivery data privacy-minimized, methodology-versioned, deduplicated,
  filterable, and exportable.
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
  Preserve stable evidence hashing, no external I/O, no override, and
  non-enforcement until the exact-snapshot publication gate is separately
  designed and tested.
- Keep Publish, readiness, and contract tests on one root-publication planner.
  RSS and canonical News apply to every episode; YouTube applies only to a
  video-bearing non-premium-bonus episode. Publish premium bonuses through the
  versioned media-free News teaser contract and render the same discriminator
  on the canonical page, show aggregate, and noindex embed without player,
  enclosure, transcript, chapter, duration, token, or premium-time leakage.

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
