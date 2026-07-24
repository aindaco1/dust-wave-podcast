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
orchestration, a dry-run GitHub News publisher, a dry-run YouTube adapter, and
the signed Stripe webhook/readiness boundary. Draft/approval/kill sponsor
operations, deterministic targeting preview, bounded creative validation, and
the signed processor/producer-review boundary for frame-aligned episode ad
plans are implemented without connecting public audio assembly. The bilingual word-alignment
storage contract and executable launch-quality evaluator are also implemented;
running a real transcription/alignment adapter and producing its human-reviewed
benchmark evidence remain gated. Checkout, dynamic audio assembly, clips, and
live YouTube/GitHub publishing remain roadmap work.

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

The public show and episode pages remain canonical on `dustwave.xyz`. Episode
publishing creates or updates a News page in the website repository.

The permanent feed and media origins are reserved as `feeds.dustwave.xyz` and
`media.dustwave.xyz`. Both will terminate at the Podcast Worker; R2 remains
private so premium access, dynamic ad decisions, byte ranges, and telemetry
cannot be bypassed. No DNS record is attached before the applicable staging
routes pass.

## Local setup

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
- [`docs/ALIGNMENT_GATE.md`](docs/ALIGNMENT_GATE.md) — English/Spanish
  word-alignment evidence and launch thresholds
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
```

Remote migrations and deploys are intentionally separate commands. Apply and
exercise staging first; production promotion requires an explicit release
decision.
