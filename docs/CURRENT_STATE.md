# Current state and next steps

Verified: **2026-09-07** (`America/Denver`). Audience: maintainers and the next
Codex task. Runtime source: `main` / `origin/main` at
`54ec39fd3e11f9aebea8ef3eb42a0d21986d7424`, merged in
[PR #97](https://github.com/aindaco1/dust-wave-podcast/pull/97) and deployed to
staging; package version `0.2.26`. Later documentation commits are separate.

The hosting and Admin foundations are implemented, and **the platform-ready
checkpoint now passes**. The latest bounded monitor report has **12 PASS,
0 BLOCK, 3 DEFER, 0 WAIT, 0 FAIL**: `safe=true`, `platformReady=true`,
`launchReady=false`. Both previously failing evidence workflows pass, the canary
and suppression evidence are current, and YouTube exact-channel access is
restored. Launch still needs the three content-dependent acceptance exercises.
The renewed Google Testing grant has a seven-day lifetime; resolve the shared
consent configuration before treating access as durable.

This is a dated assessment, not a readiness store. Executable gates, D1, and
provider evidence own operational truth. Replace this snapshot when reverified.

## Goals and ownership

Deliver one low-maintenance, episode-centered workflow for Ópera en la Selva:
upload once, review the exact media and release decisions, schedule, publish to
canonical News/show/RSS and eligible providers, and reconcile the result. Premium
adds ad-free access, early release, and bonuses. House/direct sponsorship and
10+ directory distribution require their separate real-world evidence.

[ROADMAP.md](ROADMAP.md) owns settled scope, commercial choices, and milestones.
[OWNER_ACTIONS.md](OWNER_ACTIONS.md) lists the human inputs. Public transcripts,
bilingual H1 alignment, chapters, and alignment-dependent clips remain post-launch.

| Owner | Responsibility |
|---|---|
| This Worker | HTTP/auth, durable D1 state, private R2 media, Queue/scheduled jobs, entitlements, provider reconciliation, gates |
| `dust-wave-new` | Canonical pages, existing player, member/Admin UI, bilingual presentation and website deployments |
| Pinned Platform | Characterized shared mechanism; each consumer retains product policy and deployment authority |
| Pinned alignment runner | Private heavy model execution and benchmark assembly; Worker owns approval |
| Owner / Super-admin | Content rights, subjective review, provider account decisions, exact-snapshot promotion |

The review covered the repository's overview, handoff, roadmap, owner queue,
readiness and user-flow contracts, runbook, API/security references, media gates,
ADRs, workflow/configuration source, submodule documentation, and the sibling
website completion plan. The latter still contains August progress snapshots;
use it for product/ownership context, not current deployment or readiness claims.

## Implemented baseline

| Area | Present in source and existing contracts | Remaining acceptance boundary |
|---|---|---|
| Hosting | Multi-show schema; public/private RSS; immutable show/GUID identity; range-safe private R2 delivery | First intended public item, real-client playback, and exact production promotion |
| Show/Admin lifecycle | Show creation/configuration/archive, guarded empty-show deletion, role/recency/CSRF checks; six-workspace UI contracts | Recheck current rendered website when changing UX; this review made no new visual acceptance claim |
| Media | Multipart source upload, QC, enhancement review, delivery MP3/peaks, signed automatic processor dispatch and terminal incidents | First publishable episode's exact media and production review |
| Editorial | Private transcription, review/export, AI proposals, alignment/chapter/clip contracts | Human-approved transcripts and the real bilingual H1 benchmark before gated public features |
| Publication | One revision and root planner for RSS, News, and eligible YouTube; staleness, supersession, readiness digest and shadow/enforce modes | First-content projection and provider reconciliation; current modes remain guarded |
| Billing/access | Stripe Checkout/Portal/webhook contracts, independent Stripe/Pool/manual sources, private-feed issue/rotation, expiry and manual tax evidence | Production policy/configuration approval and any selected Pool benefit mapping |
| Announcements | Consent-bound outbox, signed events, withdrawal, suppression and idempotency; fresh isolated suppression proof passes | Any new live send remains separately scoped |
| YouTube/directories | Channel-health checks, controlled unlisted/native-video/audio-rendition paths, directory packet/validation/polling/recovery; exact-channel access restored September 7 | Retain current access evidence, a real publishable object, and ten genuine directory certifications |
| Ads/analytics | Deterministic targeting, immutable equal-byte fallback, signed virtual audio, qualified counters, privacy-minimized aggregates/CSV; current synthetic gate passes | Real-client matrix and direct-sponsor pilot |
| RSS migration | Reviewed plan, private copy/reconciliation, channel identity, cutover packet and final approval contracts | Owner-controlled old-host action after the existing migration gates; no automatic redirect activation |

Use [API.md](API.md), [SECURITY.md](SECURITY.md), and
[USER_FLOWS.md](USER_FLOWS.md) for detailed behavior and regression ownership.
Do not rebuild these implemented foundations as new roadmap tasks.

## Verification evidence

| Check | Result on this review | Limit |
|---|---|---|
| Git | Clean starting checkout, matching local/remote main; no open PRs or issues at inspection | Source SHA above identifies the runtime assessed; later documentation commits are recorded separately in Git |
| Shared pins | Platform `a0006c3e0c3f8ab814387491753989956adbbe94` (`v0.23.0`); alignment source `32111c2a8dd62d891c4309f7638a86c31a789dc3`; both submodules clean | Alignment model execution has its own reviewed pin in the alignment gate |
| Local `npm run check` | PASS on Node `22.22.2`: secret scan, zero audit vulnerabilities, generated types, typecheck, **180 files / 790 tests** | Includes two plain-Node CLI subprocess regressions plus immutable-preview and missing-ref coverage |
| Staging and production dry runs | Both PASS with Wrangler `4.115.0` | Packaging evidence; actual staging deployment recorded below |
| Public staging and production gates | Both PASS; artwork, cache/security, ETag and conditional `304`; independent RSS reads confirm **zero items in each feed** | No item/enclosure playback, directory ingestion, or launch claim |
| Repair CI | [PR run 34087172156](https://github.com/aindaco1/dust-wave-podcast/actions/runs/34087172156) and [main run 34087290394](https://github.com/aindaco1/dust-wave-podcast/actions/runs/34087290394), both PASS | Source and bundle verification, not provider readiness |
| Readiness monitor | [Run 34094310174](https://github.com/aindaco1/dust-wave-podcast/actions/runs/34094310174), 2026-09-07 local; retained JSON reports **12 PASS / 0 BLOCK / 3 DEFER**, `safe=true`, `platformReady=true`, `launchReady=false`; `youtube_access` passes | The three deferrals require genuine directory certification, controlled rights-cleared YouTube publication, and a real-client direct-ad pilot. This is current readiness evidence, not public launch or permanent credential validity |
| Virtual-audio refresh | [Run 34087343263](https://github.com/aindaco1/dust-wave-podcast/actions/runs/34087343263), PASS: 24 protocol probes, 5,000 pairs / 10,000 measured requests, zero errors or content mismatches; exact objects and diagnostic lease removed | Synthetic protocol/load evidence, not native-client playback or qualified downloads |
| Launch Lab refresh | [Run 34087344657](https://github.com/aindaco1/dust-wave-podcast/actions/runs/34087344657), workflow PASS: **33 passed / 8 pending / 0 failed**; all 24 required canary contracts current; Resend suppression and Stripe lifecycle/Portal cleanup pass | The full 41-scenario matrix remains incomplete: native-client qualification, three directory cases, hosted Checkout, and three YouTube cases remain pending; fixture evidence is never launch-eligible |
| Processor dispatcher | [Run 34086019335](https://github.com/aindaco1/dust-wave-podcast/actions/runs/34086019335), 2026-09-06, success | Dispatcher execution alone is not completed media processing |
| D1 migrations | Staging migration `0089_admin_show_creation.sql` applied after a verified backup restore and local rehearsal; **89 applied**, preserved show/episode/admin counts, zero foreign-key violations. Production lists no pending migrations | Only staging was migrated; backup and restore evidence remain outside Git |
| Website target | Deployed staging binding pins reviewed website commit `0d3f7ffca11eb163970731eb2a215f49a87fa737`; the exact commit and catalog are readable through GitHub | Publishing remains `dry_run`; the source pin does not deploy a website artifact |
| Staging deployment | Credential revision `11295a7d-0a9c-483f-b27e-5e6877a98901` at 100%, September 7 at 07:02:31 UTC. Script ETag and runtime match source-annotated `37f420fd-cc22-4cf7-b58a-34ccdc893a3b`; only the YouTube client secret and refresh grant were replaced. Binding names and visible values are unchanged; public gate PASS | Keep the renewed credentials during any code rollback: older revisions reference the retired secret. The earlier code rollback target is `3c814720-f78a-4b1e-9c6f-60eae0f1070e`; the additive schema migration remains applied |
| Production deployment | Worker `a2f41ecc-3efc-4c40-8d42-496aa2b73243`; public gate PASS | Inspected only; no production deployment or capability promotion |

The monitor independently passes both fail-closed provider postures (14 staging
modes / 17 production modes), all 18 required staging secret names, show
configuration, the episode gate, all 15 Stripe test-mode checks, fixture
exclusion, the zero-write boundary, and D1 foreign keys. It does not provide a
complete migration/deployment inventory or inspect secret values.

## Completed repair

The extensionless HTTP import in [src/virtual-media.ts](../src/virtual-media.ts)
blocked both CLIs under plain Node while Vitest resolved it successfully.
The repair uses `./http.ts` and permits explicit TypeScript import extensions
in the existing no-emit typecheck. No loader dependency or parallel media logic
was added.

[Subprocess tests](../tests/sponsor-cli.test.mjs) failed on the original source
and now pass under Node 22, checking JSON output and synthetic-evidence
boundaries for both actual entry points. They run in the default suite and
before Launch Lab fixture reconciliation. Full validation, both bundle dry runs,
and the two protected refresh workflows now pass on the deployed repair commit.

The staging website ref now resolves to the reviewed immutable commit in the
evidence table, with exact-ref and missing-ref regressions. Staging migration
`0089` was rehearsed against a restored private backup before remote application;
do not replay it. Deployment retained every binding and all provider modes.
The website pin selects preview source; it does not deploy a website artifact.

## Concrete work queue

### 1. Resolve the consent app's bounded token lifetime

**Owner:** account owner + engineering. Access renewal is complete; durable
consent configuration requires a separate decision covering the shared project.

OAuth follow-up on **2026-09-07** confirmed the dedicated **Dust Wave Podcast
Staging** client in the same Google project as **Film Web**. The shared consent
app remains **External / Testing**, so a renewed YouTube refresh grant has a
seven-day lifetime under [Google's rules](STAGING_RUNBOOK.md#provider-credentials).
The account owner completed consent for the configured Dust Wave brand channel.
The replacement client secret and refresh grant are installed only in staging;
the old secret is disabled and retained for recovery. The existing Worker checker
successfully refreshed OAuth and verified the exact configured channel at
`2026-09-07 07:05:16 UTC`, resetting 484 consecutive failures to zero. A second
real refresh/channel check passed after the old secret was disabled, at
`2026-09-07 07:15:16 UTC`, with zero failures and no active lease; the next normal
check is due at `19:15:16 UTC`. This restores access; it does not establish why
the previous grant stopped working.

Renewal is a bounded recovery, with another grant expected to be needed around
September 14 unless the consent configuration is resolved. Review every client
sharing the Google project and the applicable publishing/verification requirements
before changing the project-wide setting. The Film Web client and consent app's
publishing state were left unchanged.

The existing scheduled checker owns health evidence and normally rechecks a
success after 12 hours or a failure after one hour. During this renewal only its
due timestamp was advanced; status, success timestamps, and failure counters were
written by the real checker. Existing tests cover bounded OAuth errors, recovery,
exact-channel matching, and lease exclusion. No private media was uploaded, and
`YOUTUBE_PUBLISH_MODE` remains `dry_run`.

Acceptance for durable access: the approved consent configuration supports the
intended integration lifetime, and real exact-channel checks continue to pass.
An old success or a freshly renewed testing grant cannot establish that lifetime.

### 2. Preserve the restored platform-ready checkpoint

**Owner:** engineering. **Status:** complete at the September 7 monitor snapshot;
continued readiness depends on current source and provider evidence.

The existing read-only monitor now reports `platformReady=true`, with zero
non-content blocks, waits, or failures and the three content nodes deferred.
Inspect this structured result rather than treating workflow success as readiness.
Before activation, rerun the existing prelaunch gate with `--require-ready` and
inspect its summary. If an alert is needed for `BLOCK`, derive it from the existing
report/monitor; do not add another scheduler or relax gate policy.

Acceptance: keep `platformReady=true` and zero non-content blocks/waits/failures
at the next intended operation, with each content deferral explicit until its
own real evidence exists.

### 3. Complete first content and the strict launch gate

**Owner:** content owner + engineering/operator. **Dependency:** rights-cleared
publishable source and step 2.

Follow [first-content activation](PRELAUNCH_READINESS.md#first-content-activation):
review rights/metadata/release intent; process and approve exact audio; freeze a
publication revision; validate News/show/RSS/player/premium visibility; reconcile
and inspect one unlisted YouTube test; certify real ingestion/recovery at ten
or more destinations; and prove the exact direct-sponsor plan with a qualified
native-client download and required fallback/client matrix.

For audio-only content, verify that an approved rendition is actually selected:
[src/publication-intent.ts](../src/publication-intent.ts) adds YouTube only when a
video source or selected rendition key exists and the episode is not a premium
bonus. Do not interpret the implemented rendition processor as end-to-end
publication proof. Pool also needs its owner-selected mapping before activation.

Acceptance: the strict `gate:launch:staging -- <configured episode pointer>
--require-ready` passes with real, current, source-bound evidence. Empty feeds and
private/synthetic fixtures cannot satisfy it.

### 4. Prepare exact-snapshot promotion, then post-launch work

**Owner:** engineering prepares; Super-admin approves. **Dependency:** strict
launch evidence and applicable production billing/provider decisions.

Prepare the immutable snapshot, backup/migration order, secret-name posture,
capability canaries and rollback plan. Obtain approval for that named snapshot;
promote one applicable capability at a time and verify its actual external state.
Resume the gated editorial/network roadmap only after core hosting is stable.

Acceptance: the intended first release and premium access reconcile across all
applicable destinations, rollback is proven, and no guarded capability is enabled
merely because its source or packaging checks passed.

## Verification commands for the next task

Use Node 22, inspect `git status` before switching branches or installing, and keep
unrelated website work intact. Start with local checks:

```sh
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
npm run gate:sponsor-demo
npm run launch-lab:contracts
npm run gate:public:staging
npm run gate:public:production
```

The standalone CLIs now pass and have subprocess regression coverage. With the
correct scoped credentials, these commands read operational state:

```sh
npm run db:migrations:staging:list
npm run db:migrations:production:list
npm run gate:stripe:staging
LAUNCH_EPISODE_ID="$(gh variable get PODCAST_LAUNCH_EPISODE_ID --env podcast-staging)"
npm run gate:prelaunch:staging -- "$LAUNCH_EPISODE_ID" --require-ready
npm run gate:launch:staging -- "$LAUNCH_EPISODE_ID" --require-ready
```

Keep the episode pointer in the existing GitHub variable; do not copy private
fixture identifiers into documentation. Follow [STAGING_RUNBOOK.md](STAGING_RUNBOOK.md)
for deployment order, [STAGING_ACCEPTANCE.md](STAGING_ACCEPTANCE.md) for controlled
exercises, and [LAUNCH_LAB_RUNBOOK.md](LAUNCH_LAB_RUNBOOK.md) for protected provider
rehearsals and cleanup.

## Cleanup completed in the earlier documentation review

- Removed **24 remote branches** and **4 local branches**. Twenty remote tips
  were ancestors of current main; four squash-merged branches matched their
  merged patches (PRs #2, #4, #5, #6). Deletion was atomic and conditional on the
  inspected remote SHAs. `main`, tags, and submodule pins were preserved.
- Pruned **2 orphaned worktree registrations** after confirming both directories
  were absent. The current checkout remains the sole worktree.
- Moved **56 generated/cache/evidence files totaling 3,747,533 bytes** out of the
  checkout: old UX screenshots, runner distribution/test/lint/bytecode output,
  Vitest cache, Wrangler temporary state, and macOS metadata. The screenshots
  remain recoverable evidence. Installed Node/Python dependencies, local secrets,
  migrations, source assets, and tracked generated Worker types were preserved.
- Saved a verified Git recovery bundle, original branch SHAs/merge proofs,
  moved-file manifest, and restore instructions in the private local
  `Documents/Codex/Cleanup Reviews/dust-wave-podcast-20260906T152031` directory.
  Moving files reduces checkout clutter; it does not reclaim disk capacity until
  the owner discards the recovery copy.
- Consolidated the README into setup/navigation, the roadmap into stable goals,
  the owner queue into unresolved inputs, and this file into the dated status and
  next-step authority. The old handoff remains a short compatibility pointer.
- Removed obsolete deployment checkpoints and private-fixture diaries; corrected
  retired manual-dispatch refs and kept API, security, migration validation,
  ADR decisions, user-flow tests, and media acceptance contracts.
- Separated the staging deployment sequence from migration validation, feature
  acceptance exercises, and Launch Lab operations. Preserved the existing
  procedures and moved older acceptance observations into a labeled historical
  appendix. Updated navigation without rerunning or changing the dated runtime
  evidence above.

That earlier cleanup changed no application code, binding value, migration,
dependency pin, provider state, or deployment. The repair and staging migration
described above are subsequent work. Remote branch removal is complete; Git history records
the documentation consolidation separately from runtime changes. Future cleanups should inventory ignored output,
retain needed evidence outside Git, prove branch merges, preserve active worktrees,
and use exact ref checks before remote deletion.
