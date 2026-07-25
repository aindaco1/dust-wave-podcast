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
the fail-closed manual-tax quote and Stripe Checkout/Customer Portal boundaries,
webhook-projected multi-source entitlements, and the signed Stripe
webhook/readiness boundary. Draft/approval/kill sponsor
operations, deterministic targeting preview, bounded creative validation, and
the signed processor/producer-review boundary for frame-aligned episode ad
plans are implemented without connecting public audio assembly. The bilingual word-alignment
storage contract and executable launch-quality evaluator are also implemented;
running a real transcription/alignment adapter and producing its human-reviewed
benchmark evidence remain gated. Checkout code remains disabled pending
accountant-approved tax/provider evidence; dynamic audio assembly, public clip
distribution, and live YouTube/GitHub publishing remain roadmap work.

The transcript review workbench stores versioned English/Spanish cue records,
uses optimistic revisions and idempotency keys, and keeps word-linked controls
off unless a matching alignment revision passed the launch gate. Producer
edits always return an approved transcript to review; Admin/Super-admin
approval requires every visible speaker label to be explicitly confirmed.
Caption text uses the shared timed-text editor representation and the Worker
independently rejects HTML, invalid/overlapping timing, stale revisions, and
out-of-bounds cues. Public transcript and clip distribution remain gated.

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
render. Ready renders have authenticated range-safe preview/download plus a
bounded, filterable cross-episode Marketing library; neither route exposes an
R2 key. A separate staging-only Shorts boundary now lets Producer+ prepare one
immutable private/unlisted draft for the current ready render. Approval
requires a recently authenticated super-admin. The committed mode records only
a dry run; an actual upload additionally requires explicit `controlled_test`
mode and launch-channel OAuth secrets, and public visibility is structurally
rejected. No public clip route or production Shorts upload is enabled.

Pool supporter benefits use a separately gated, signed grant/revoke bridge and
email-bound one-time codes redeemed through the authenticated Dust Wave member
site. The bridge is disabled in every environment by default.

The first Marketing boundary reuses the versioned Pool/Store tagged-link and
QR primitives without creating a second implementation. An authenticated
listener may explicitly opt into or out of one show's English or Spanish
announcements; subscription access never implies consent. Producer+ can review
a normalized WYSIWYG announcement against the count and pseudonymous revision
of explicitly opted-in, currently entitled listeners. The endpoint cannot
send, does not expose recipients, writes no outbox, and makes no Resend call.

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

The public show and episode pages remain canonical on `dustwave.xyz`. Episode
publishing creates or updates a News page in the website repository.

The 11-platform directory registry is now show-scoped. One reviewed publish
action updates the canonical feed/News/YouTube job graph and creates monitored
per-directory ingestion states, while preserving the truth that Spotify,
Apple Podcasts, and the other launch directories require one-time owner setup
and normally follow RSS rather than accepting a direct Dust Wave upload.
The same role-scoped episode view reports the immutable RSS, canonical News,
and YouTube root-job revision/status separately, including bounded failure
evidence, so directory lag cannot hide a failed publication channel.

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
```

Remote migrations and deploys are intentionally separate commands. Apply and
exercise staging first; production promotion requires an explicit release
decision.
