# Codex project handoff

Last verified: 2026-08-08 in `America/Los_Angeles`
Audience: the next Codex task opened in the `dust-wave-podcast` project

This is a continuation snapshot, not a second readiness database. D1, provider
evidence, and the executable gates remain authoritative. Re-run the commands in
this document before acting on a status below, then replace stale snapshot data
instead of appending a parallel log.

## Resume here

Open the `dust-wave-podcast` repository as the project root, read `AGENTS.md`
and this document completely, and start from current `main`:

```sh
git switch main
git pull --ff-only origin main
git submodule update --init --recursive
npm ci
git status --short --branch
```

Use Node 22 for parity with CI. Before changing code, establish the current
source, deployment, schema, and gate state:

```sh
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
npm run db:migrations:staging:list
npm run db:migrations:production:list
npm run gate:stripe:staging

LAUNCH_EPISODE_ID="$(gh variable get PODCAST_LAUNCH_EPISODE_ID --env podcast-staging)"
npm run gate:launch:staging -- "$LAUNCH_EPISODE_ID"

npm run gate:public:staging
npm run gate:public:production
```

The composed launch command must receive exactly one episode ID. The GitHub
environment variable is the durable, content-free pointer to the private
launch fixture; do not copy the ID into another configuration store.

Useful browser surfaces:

- staging Admin, English:
  <https://dust-wave-website-staging.pages.dev/admin/podcasts/>
- staging Admin, Spanish:
  <https://dust-wave-website-staging.pages.dev/es/admin/podcasts/>
- staging Worker: <https://dust-wave-podcast-staging.jogo.workers.dev>
- public show, English interface:
  <https://dustwave.xyz/podcasts/opera-en-la-selva/>
- public show, Spanish interface:
  <https://dustwave.xyz/es/podcasts/opera-en-la-selva/>
- production feed: <https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml>

## Verified repository and deployment snapshot

| Surface | Verified state |
|---|---|
| Podcast source | Release `v0.2.26`; the zero-touch launch-monitor restoration and refreshed handoff are tracked in [PR #94](https://github.com/aindaco1/dust-wave-podcast/pull/94) and were validated at `a7c9f96` |
| Podcast CI | Main CI run [31244532249](https://github.com/aindaco1/dust-wave-podcast/actions/runs/31244532249) passed |
| Handoff verification | Tracked-secret scan passed over 502 text files, audit reports zero vulnerabilities, 169 test files / 712 tests passed, and both deployment dry runs passed |
| Podcast staging | Worker version `7a952579-0d7f-4bbf-9eb3-1332bcb5e026`, deployed 2026-08-06 with the `0.2.26` guarded-mode configuration |
| Podcast production shell | Worker version `1774f68a-3a89-487f-8f99-dc2c37615132`, deployed 2026-08-06; schema is current and public zero-item feed is reachable, but provider capabilities remain fail-closed |
| D1 | Staging and production both report no pending migrations through `0088` |
| Public release contract | Staging and production gates pass RSS, artwork, cache/security, ETag, and conditional-request checks; both feeds contain zero items |
| Website source | `dust-wave-new` `main` is `ed83995497f9c45c20503fb395fde6824348d8d6`; release `v1.3.0`. [PR #19](https://github.com/aindaco1/dust-wave-new/pull/19) merged the patched transitive `nanoid` resolution and signed-out readiness invalidation fix; production run [31244517201](https://github.com/aindaco1/dust-wave-new/actions/runs/31244517201) passed build, GitHub Pages deploy, Cloudflare header enforcement and cache purge, response-header verification, and federation |
| Website podcast UX | Six-section workflow and bilingual interface merged in [dust-wave-new PR #13](https://github.com/aindaco1/dust-wave-new/pull/13); listener/admin locale propagation merged in [Podcast PR #84](https://github.com/aindaco1/dust-wave-podcast/pull/84) |
| Website staging | Stable Pages alias points to immutable deployment `be66e546`, source `ed83995`, exactly matching website `main`. Six deployed bilingual surfaces pass exact i18n validation; English and Spanish Admin probes have zero console errors and exact document/viewport widths |
| Shared Platform | Podcast pins Platform `v0.23.0` at `a0006c3e0c3f8ab814387491753989956adbbe94` and retains domain policy behind adapters |
| Alignment runner | Submodule remains pinned at `32111c2a8dd62d891c4309f7638a86c31a789dc3`; launch no longer depends on transcript/H1 completion |

Website [PR #19](https://github.com/aindaco1/dust-wave-new/pull/19) was promoted
with explicit owner approval. The public deploy and its edge checks passed, all
four English/Spanish show and Admin URLs return `200`, signed-out Admin browser
probes have zero console errors, and staging was rebuilt from the exact merge
commit. Public and staging now use the same immutable asset version.

## Live launch posture

The composed read-only gate was run on 2026-08-08 by the durable GitHub
monitor against the configured
private launch fixture. It reported **9 pass, 5 block, 0 wait, and 0 fail**.

| Gate | State | Meaning |
|---|---|---|
| Read-only boundary | Pass | Every launch-state statement reported zero writes |
| Launch Lab isolation | Pass | The selected show is not a synthetic Launch Lab show |
| Staging modes | Pass | Fourteen staging provider modes match the fail-closed contract |
| Production modes | Pass | Seventeen production provider modes match the fail-closed contract |
| Staging secret names | Pass | All 18 required Worker secret names are installed; values were not inspected or recorded here |
| Show configuration | Pass | Premium, RSS, canonical site, and YouTube show settings exist |
| Episode launch scope | Pass | Eight pass, zero block/wait/fail, with transcript alignment and chapters explicitly deferred post-launch |
| Stripe | Block | Fourteen checks pass; the exact Podcast subscription tax policy is still unapproved |
| Directories | Block | `0/10` destinations have all setup, feed validation, ingestion, and failed-to-recovered evidence |
| YouTube | Partial | Current OAuth refresh reaches the exact configured channel; one controlled, inspected unlisted publication is still absent |
| Resend | Block | One consented send, matched delivery transition, unsubscribe/suppression exercise is still absent from launch evidence |
| Dynamic ads | Block | Durable evidence still needs an approved episode ad plan, selected decision, and one qualified native-client direct-sponsor download |
| D1 integrity | Pass | `PRAGMA foreign_key_check` returned no rows |

The separate Stripe gate reported **14 pass, 1 block, 0 fail**. Test Product,
monthly `$5` Price, annual `$50` Price, hardened Portal, webhook event set,
installed secret posture, provider-event journal, and disabled Checkout posture
all pass. The only Stripe block is the unapproved tax-policy version.

The daily GitHub launch monitor is active. The `podcast-staging` environment
holds a dedicated account-scoped Cloudflare token with only `D1 Read` and
`Workers Scripts Read`, plus a dedicated Stripe restricted test key with only
Products, Prices, Customer Portal, and Webhook Endpoints read access. The
workflow installs a pinned Stripe CLI archive only after checksum verification;
neither credential is copied into the repository or retained in its bounded
artifact. On-demand run
[31274035980](https://github.com/aindaco1/dust-wave-podcast/actions/runs/31274035980)
passed and retained the authoritative 9-pass / 5-block / 0-wait / 0-fail JSON
report for 30 days. The daily schedule can now detect drift without owner
intervention.

## Product decisions that must survive the handoff

- Keep a multi-show-ready architecture with a single-show launch UI for
  **Ópera en la Selva**. A show page exists even with no episodes.
- Every episode receives one canonical Dust Wave News page and appears on its
  show aggregate. News body content remains in its authored language.
- Interface and operational copy are English/Spanish and use the same footer
  language switch as the rest of Dust Wave.
- Reuse the existing Dust Wave Digest/Podcast player, including download.
- Launch premium at configurable per-show USD prices; Ópera en la Selva starts
  at `$5/month` and `$50/year`, no trial, with at most one free mini-episode.
- Premium starts with ad-free listening, seven-day default early access with a
  per-episode override, and bonus episodes. Early episodes reach YouTube only
  at public release; premium-only bonuses never reach YouTube.
- Podcast subscription is primary. Pool may grant the same entitlement through
  a future show-scoped tier/add-on redemption policy.
- Use the Store-derived versioned tax calculator and manual Stripe Tax Rates;
  do not enable automatic Stripe Tax.
- Restrict launch ads to Dust Wave house promos and directly sold sponsors.
  Select in real time by show, episode, position, date, device, and app.
- Publish native video when present and generate an audio-only YouTube
  rendition otherwise. YouTube must share the root public-release timing.
- The public “10+ platforms” promise remains behind ten real directory
  certifications; one-click Publish cannot bypass one-time provider ownership,
  terms, review, or ingestion latency.
- Keep Pool, Store, Podcast, and the website as separate runtimes with a common
  versioned Admin shell. Extract a shared primitive only after at least two
  consumer contracts prove equivalent behavior.
- Multiple Super-admins can perform all administrative actions. Staging Admin
  Turnstile is disabled for usability; listener and Checkout Turnstile remain
  required, and production Admin Turnstile remains required.
- Archive.org is out of scope.
- Public transcript review, bilingual H1 word alignment, public chapters, and
  alignment-dependent captioned clips/audiograms are post-launch. Their
  existing gates remain fail-closed until completed.
- There is no rights-cleared publishable Ópera en la Selva episode yet. The
  Dust Don't Settle source-test episode is private, marked `Do not publish`,
  and must never be repurposed for public, directory, or YouTube evidence.

## What is already built

The detailed implementation inventory belongs in
[`ROADMAP.md`](ROADMAP.md), while the cross-repository acceptance matrix lives
in the website's
[Podcast Platform Execution Plan](https://github.com/aindaco1/dust-wave-new/blob/main/PODCAST_PLATFORM_EXECUTION_PLAN.md).
At handoff, these major boundaries are implemented:

- D1/R2/Queue multi-show data model, ordered migrations, public/private RSS,
  byte-range media, canonical publication identity, idempotent root jobs, and
  rollback-oriented deployment modes;
- six-section episode-centered Admin, compact workflow submenu, linked
  blockers, progressive technical evidence, automatic readiness refresh,
  responsive spacing, accessibility, and bilingual i18n contracts;
- source upload, audio QC/enhancement, delivery MP3/player peaks,
  transcription, alignment, chapter/clip proposals, audiogram rendering, and
  approval handoffs through automatic GitHub processor dispatch;
- Stripe Checkout/Portal/webhook architecture, direct subscription and
  independent Pool/manual entitlement sources, private feed issue/rotation,
  expiry reconciliation, and an isolated 11-scenario real-provider Launch Lab;
- Resend magic links, admin action links, consent-safe announcement outbox,
  signed webhook reconciliation, unsubscribe, and suppression primitives;
- YouTube exact-channel OAuth health, revision-bound resumable/unlisted upload
  contracts, native-video/audio-rendition paths, reconciliation, release-timing,
  and premium-bonus exclusion;
- directory registry, credential-free packet, canonical feed preflight,
  evidence model, polling/recovery contracts, and the hard 10+ claim gate;
- real-time ad targeting, immutable plan/creative evidence, equal-byte house
  fallback, guarded enclosures, privacy-minimized qualification, protocol/load
  gates, and a network-free Dust Wave sponsor rehearsal;
- privacy-minimized download/player/subscriber/YouTube/publication analytics,
  bounded CSV, audit evidence, dead-letter incidents, and safe retries;
- shared, characterized Admin, timed-text, media, tax, HTTP, validation,
  Resend, session, GitHub, and provider primitives without merging runtime or
  business-policy ownership.

## Remaining work, in priority order

### 1. Clear the non-content launch evidence

- Import and approve the exact versioned Podcast tax policy through the
  existing recent-auth Super-admin flow only if the recorded registration,
  taxability, jurisdiction, rate, evidence reference, approver, and effective
  date all match. Re-run Stripe and composed gates. Do not enable Checkout.
- Complete one consented staging listener journey: human Turnstile, magic-link
  return, entitlement/account page, one announcement delivery, unsubscribe,
  signed suppression, and no-resend reconciliation. Keep the recipient outside
  Git and restore announcement mode to `dry_run`.
- Select the Pool tier/add-on and entitlement duration only when the business
  policy is decided. The seven synthetic grant/redeem/overlap/expiry/revoke
  contracts already pass and should not be reimplemented.

### 2. Prepare everything that can precede a real episode

- Keep the Launch Lab's 41-scenario reconciliation and the virtual-audio gate
  current through scheduled workflows. On 2026-08-07, scheduled Launch Lab run
  [31192270607](https://github.com/aindaco1/dust-wave-podcast/actions/runs/31192270607)
  tracked 33 passed, seven pending, and one running scenario and completed
  after its Stripe cleanup; expected real-provider proofs remain non-passing. Scheduled
  virtual-audio run
  [31187012789](https://github.com/aindaco1/dust-wave-podcast/actions/runs/31187012789)
  passed 24 protocol probes and 10,000 paired requests with zero request
  failures or content mismatches, 71.9 ms p95 added time, and complete lease
  and object cleanup.
- Generate and inspect a dry-run publication snapshot with only private or
  synthetic inputs; assert zero public item, upload, email, charge, directory
  submission, or qualified ad outcome.
- Keep the directory registry, entry URLs, owner-setup checklists, packet, and
  public-listing pollers current. Do not submit the zero-item feed or claim
  certification.
- Keep YouTube channel health current and validate resumable-upload ambiguity,
  reconciliation, timing, bonus exclusion, and audio-rendition tests without
  uploading the private source-test episode.
- Keep the Dust Wave sponsor demo and native-client qualification negative
  cases in CI. Synthetic success must remain ineligible for the durable pilot.

### 3. Execute the first publishable episode automatically when it exists

The irreducible input is one rights-cleared Ópera en la Selva episode with
final title, Spanish-primary summary, English translation, public/premium
intent, and release time. Once it exists, the platform should:

1. ingest and process media to the next approval;
2. freeze one exact publication revision;
3. validate canonical News, show, public/private RSS, existing player/download,
   premium timing, bonus leakage, artwork, and enclosure ranges;
4. complete one controlled, inspected unlisted YouTube test and reconcile its
   exact video ID;
5. generate the directory packet, browser-assist submissions where permitted,
   and poll listings without storing passwords or verification codes;
6. record setup, feed validation, ingestion, and a real failed-to-recovered
   sequence for at least ten destinations;
7. approve the exact Dust Wave ad plan and observe one qualified native-client
   direct-sponsor download while negative cases remain unqualified;
8. keep every external effect idempotent and reconcile ambiguity before retry.

### 5. Promote capabilities independently

Only after the composed staging gate has no block, wait, or fail node, produce
one immutable evidence snapshot and rollback plan. A Super-admin approval must
name that exact snapshot. Promote and canary one capability at a time: public
feed/media, News, YouTube, Resend, Checkout, Pool redemption, then dynamic ads.
Automatically revert the flag or Worker version when its focused gate fails.

### 6. Post-launch work

Resume public Spanish/English transcript review, H1 corpus/resource evidence,
exact alignment approval, public chapters, captioned clips/audiograms, and
word-level player controls only after core hosting is stable. Then consider the
already-modeled multi-show UI, saved/scheduled reports, richer sponsor pacing,
live/video clips, collaboration, listener Q&A, and transcript discovery.

## Automation rules for the remainder

1. Extend existing D1 jobs, Queue processors, scheduled Actions, readiness
   nodes, and Admin surfaces; do not add a second scheduler, provider ledger,
   identity store, or readiness model.
2. Give every external mutation a stable idempotency key, immutable input
   revision, stored provider identity, bounded retry, reconciliation query,
   terminal recovery state, and audited callback.
3. Treat timeouts and ambiguous provider responses as `unknown` until
   reconciled. Never blindly repeat a YouTube upload, charge, email, submission,
   or publication.
4. Automate objective preparation and verification. Send subjective or legal
   decisions through the existing bilingual, expiring, single-use Resend links
   to the exact Admin control.
5. Keep proposals private and current-revision-only. Automation may prepare an
   editor but may not silently approve, publish, charge, email, or upload.
6. Feed one structured gate into Admin, CI, alerts, and promotion. Documents
   describe the result but never become the result.
7. Add success, stale-input, duplicate, timeout, retry, reconciliation,
   permission, privacy, responsive-overflow, accessibility, and post-commit
   metadata tests for every new automated path.
8. Keep secrets, subscriber addresses, private-feed tokens, provider payloads,
   and rights-restricted media/transcripts out of Git, logs, artifacts, and
   this document.

## Fail-closed configuration that must not regress

Staging currently uses test, dry-run, preview, probe, or shadow modes:

- Stripe test mode with Checkout and Pool redemption disabled;
- YouTube and GitHub publishing `dry_run`;
- announcement delivery `dry_run`;
- dynamic ads `staging_validate`;
- clip publication `staging_preview`;
- directory observation `staging_probe`;
- RSS import `staging_copy`;
- publication gate `shadow`;
- automated processor dispatch enabled only through the signed GitHub pull
  boundary;
- Admin Turnstile off only in staging, with listener and Checkout Turnstile on.

Production keeps Checkout and Pool redemption disabled, provider publication
dry or disabled, processor dispatch disabled, and Admin/listener/Checkout
Turnstile required. A deployed Worker, current schema, attached feed domain, or
passing zero-item public gate is not permission to promote any capability.

## Authoritative documents

- [`ROADMAP.md`](ROADMAP.md): product scope, implementation sequence, and
  promotion gates.
- [`OWNER_ACTIONS.md`](OWNER_ACTIONS.md): only the remaining human/provider
  facts; never put secrets or subscriber identities there.
- [`STAGING_RUNBOOK.md`](STAGING_RUNBOOK.md): backup, migration, controlled
  provider exercises, smoke tests, and rollback.
- [`SECURITY.md`](SECURITY.md): trust boundaries, privacy, secret posture, and
  failure behavior.
- [`API.md`](API.md): HTTP, authentication, authorization, and cache contracts.
- [`PROCESSOR_DISPATCH_AUTOMATION.md`](PROCESSOR_DISPATCH_AUTOMATION.md):
  automatic media job discovery, dispatch, reconciliation, and incidents.
- [`DYNAMIC_ADS_GATE.md`](DYNAMIC_ADS_GATE.md),
  [`VIRTUAL_AUDIO_GATE.md`](VIRTUAL_AUDIO_GATE.md), and
  [`CLIP_RENDER_GATE.md`](CLIP_RENDER_GATE.md): media-specific evidence.
- [`ALIGNMENT_GATE.md`](ALIGNMENT_GATE.md): unchanged post-launch transcript and
  word-alignment quality boundary.
- [Cross-repository completion plan](https://github.com/aindaco1/dust-wave-new/blob/main/PODCAST_PLATFORM_EXECUTION_PLAN.md):
  full product acceptance matrix and repository ownership.

## Suggested prompt for the next Codex task

> Read `AGENTS.md` and `docs/CODEX_PROJECT_HANDOFF.md` completely, then re-run
> the source, deployment, migration, launch, Stripe, and public-gate checks in
> the handoff. Continue the autonomous queue in priority order, staying DRY and
> reusing the shared Platform only where consumer contracts match. Keep
> production provider capabilities fail-closed, never publish the private
> `Do not publish` source-test episode, and stop only for a genuinely
> irreducible rights, legal, provider-login, or exact-snapshot approval.

## Maintaining this handoff

Update the verified date, implementation commits, immutable deployments, gate
summary, and priority list whenever any of them changes. Prefer links to the
authoritative code, gate, run, or runbook over copied narrative. Remove
completed blockers instead of leaving an accumulating diary.
