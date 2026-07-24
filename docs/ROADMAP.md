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
- Process source audio, validate delivery files, extract duration/loudness, and
  generate player peaks.
- Transcribe Spanish and English, expose confidence, and block approval unless
  the word-alignment quality gate passes or a super-admin records an audited
  override.
- Generate captioned clips and audiograms locally or on existing Cloudflare
  infrastructure, with templates and safe-area previews.
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
- Reuse Pool Marketing primitives for tagged URLs, QR codes, embeds, share
  previews, and Resend announcements.
- Reuse Pool/Store reporting patterns for public and premium delivery, player
  engagement, sponsors, subscriptions, YouTube, and publication health.
- Keep raw delivery data privacy-minimized, methodology-versioned, deduplicated,
  filterable, and exportable.

### Post-launch

- Expose the multi-show/network interface already supported by the data model.
- Add saved and scheduled reports, richer campaign pacing, live/video clips,
  collaboration workflows, listener Q&A, chapters, and deeper transcript
  discovery.
- Treat remote multitrack recording as a separately gated product after a
  browser/device recovery spike.

## Promotion gates

No production route, paid checkout, live GitHub write, live YouTube upload,
directory submission, sponsor campaign, or public “10+ platforms” claim is
enabled without its documented staging evidence and owner/provider setup. See
`STAGING_RUNBOOK.md` for the operational gate and the comprehensive execution
plan deliverable for the full acceptance matrix.
