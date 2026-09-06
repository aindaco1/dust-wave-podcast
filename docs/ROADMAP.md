# Podcast roadmap

This document owns stable product scope and acceptance milestones. Dated
implementation evidence and the ordered work queue belong in
[CURRENT_STATE.md](CURRENT_STATE.md); human decisions belong in
[OWNER_ACTIONS.md](OWNER_ACTIONS.md). The website's
[completion plan](https://github.com/aindaco1/dust-wave-new/blob/main/PODCAST_PLATFORM_EXECUTION_PLAN.md)
provides cross-repository detail, but its dated progress table is historical.

## Product outcome

A producer uploads audio or video once, reviews decisions that require judgment,
schedules the release, and lets durable jobs process, publish, and reconcile it.
The first public show is **Ópera en la Selva**. Every show has a page before its
first episode, and every episode has one canonical Dust Wave News page plus a
show-page entry. The existing Digest/Podcast player supplies playback and download.

The architecture and Admin support multiple shows. A single accessible show uses
compact context; additional authorized shows reveal the shared selector. Show
creation, configuration, archive, and guarded empty-draft deletion are implemented
and should be extended through their existing paths.

## Settled launch decisions

| Area | Product contract |
|---|---|
| Language | Spanish-primary show metadata with English translation; English/Spanish interface and operational copy; News bodies retain their authored language |
| Brand | Owner-confirmed Substack blond-profile artwork and wordmark; retain source assets and validated feed derivatives |
| Origins | Canonical pages on `dustwave.xyz`; permanent RSS on `feeds.dustwave.xyz` and private-R2-backed media on `media.dustwave.xyz` |
| Pricing | Configurable per-show USD monthly/annual plans; Ópera starts at $5/month or $50/year, no trial |
| Premium | Ad-free feeds, seven-day default early access with per-episode override, bonus episodes, and at most one optional free mini-episode |
| Access | Podcast subscription is primary; independently tracked Stripe, Pool, and manual sources project into one entitlement without revoking other valid grants |
| Billing | Store-derived versioned calculator and approved manual Stripe Tax Rates; automatic Stripe Tax stays off; staging approval does not authorize production or another jurisdiction |
| YouTube | Native video when available, otherwise an approved audio rendition; public-release timing for early access; premium bonuses excluded |
| Ads | Dust Wave house promotions and directly sold sponsors only; first sponsor is Dust Wave; target show, episode, position, date, normalized device, and app |
| Admin | Episodes, Distribution, Marketing, Audience, Monetization, Settings; episode-centered next action, visible approval waits, progressive technical evidence, accessible responsive controls |
| Identity | Multiple Super-admins; separate listener/Admin sessions; staging Admin Turnstile exception only; production Admin and listener/Checkout protection retained |
| Editorial scope | Public bilingual transcripts, H1 word alignment, chapters, word-level controls, and alignment-dependent clips are post-launch enhancements |
| Private fixtures | The Dust Don't Settle `Do not publish` source remains private processor evidence and cannot become an episode, directory item, or YouTube test |
| Exclusions | Archive.org, programmatic ad marketplaces, and third-party advertiser settlement are outside launch scope |

## Delivery milestones

### 1. Restore and maintain platform readiness

Keep the existing processor dispatcher, Queue recovery, provider-health checks,
Launch Lab, and signed media gate running against current source. Fix regressions
in these paths before adding parallel automation. Evaluate the structured report,
including evidence freshness, instead of treating a successful monitor job as a
ready platform.

Acceptance: `gate:prelaunch:staging -- <configured episode pointer>
--require-ready` passes all non-content nodes. Only directory ingestion,
controlled YouTube publication, and the real-client ad pilot may be deferred.
The private canary must retain 24 current isolated contract scenarios and the
signed 5,000-pair/10,000-request media gate with exact cleanup.

### 2. Process the first publishable content

The owner supplies rights, source media, final title, Spanish-primary summary,
English translation, artwork, access policy, and release timing. Existing Admin
flows then perform upload, QC, master review, delivery MP3/player peaks, exact
production review, and publication snapshot preparation.

Acceptance: current audio and launch-critical reviews pass; canonical News/show,
RSS, premium timing, player/download, artwork, and range responses agree with the
same revision. Premium teasers expose no protected media or transcript metadata.
Unapproved editorial artifacts remain private. See [USER_FLOWS.md](USER_FLOWS.md)
for the existing journey and test owners.

### 3. Prove the content-dependent provider paths

- Reconcile and inspect one rights-cleared unlisted YouTube publication. Verify
  both native-video and approved audio-rendition selection, timing, and bonus
  exclusion through the existing publication planner.
- Generate the directory packet, perform the required ownership/terms steps,
  validate an item-bearing feed, and collect real ingestion and recovery evidence.
- Approve the exact Dust Wave ad plan, validate equal-byte house fallback, and
  record a qualified direct-sponsor download from a real native client. Synthetic
  probes, partial requests, cancellations, and house fallbacks remain unqualified.
- Keep Stripe and consent-safe Resend evidence current. Any Pool activation also
  requires its selected show/tier/duration policy and controlled lifecycle proof.

Acceptance: the strict launch gate has zero `BLOCK`, `WAIT`, or `FAIL` nodes;
provider outcomes reconcile to durable, revision-bound evidence. Media-specific
requirements remain in [DYNAMIC_ADS_GATE.md](DYNAMIC_ADS_GATE.md) and
[VIRTUAL_AUDIO_GATE.md](VIRTUAL_AUDIO_GATE.md).

### 4. Promote reviewed capabilities

Freeze the exact source, deployed versions, schema, provider modes, evidence
hashes, migration/backup order, canaries, and rollback plan. A Super-admin approves
that exact snapshot. Verify the current deployment before changing anything:
the production feed already responds and both origins are configured. Recheck
their actual attachment and behavior instead of recreating them blindly.

Promote applicable capabilities separately: feed/media, News, YouTube, Resend,
Checkout, Pool, and dynamic ads. Re-run focused acceptance after each change;
restore its flag or Worker version on failure. Never roll back immutable public
identity or erase terminal provider evidence to make a gate pass.

Acceptance: the first intended release reconciles across every applicable
surface; entitlement/privacy boundaries, real-client behavior, and rollback are
proven in the promoted environment. A source test, dry run, zero-item feed, or
provider acceptance alone cannot satisfy this milestone.

### 5. Complete post-launch editorial and network work

Review public English/Spanish transcripts, build the rights-cleared H1 corpus,
measure primary/replay and clean resource runs, and import the exact private
benchmark before approving alignments. Then enable the gated word-level,
chapter, captioned-clip, and audiogram flows. Follow
[ALIGNMENT_GATE.md](ALIGNMENT_GATE.md) and [CLIP_RENDER_GATE.md](CLIP_RENDER_GATE.md).

Later work includes richer multi-show/network presentation, saved/scheduled
reports, sponsor pacing, live/video clips, collaboration, listener Q&A, and
transcript discovery. Remote multitrack recording requires a separate
browser/device recovery feasibility study.

## Distribution claim

The proposed English/Spanish “one click to 10+ platforms” copy stays private until
at least ten enabled destinations have verified/not-required owner setup, current
feed validation, observed ingestion, and a real failed-to-recovered sequence.
Publish cannot bypass provider terms, review, or ingestion latency. The registry
lives in D1 and ordered migrations; avoid maintaining another destination list.

## Implementation rules

- Keep the Worker stateless and durable workflow state in its bound services.
- Extend existing jobs, dispatch registry, readiness projection, and Admin tools.
- Give external work stable idempotency, immutable input revisions, bounded
  retries, stored provider identity, reconciliation, and terminal recovery.
- Treat ambiguous provider outcomes as unknown until reconciled; never blindly
  repeat an upload, charge, email, or publication.
- Reuse Platform primitives after matching consumer contracts; keep business
  policy, data, credentials, sessions, and deployment authority product-owned.
- Automation prepares objective evidence and private proposals. Human judgment
  uses existing bilingual, expiring links to the exact review control.
- Keep privacy, stale-input, duplicate, authorization, failure/recovery, bilingual,
  accessibility, and realistic-width UI acceptance with each affected journey.
