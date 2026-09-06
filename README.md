# Dust Wave Podcast

Cloudflare Worker for Dust Wave's podcast hosting, media processing, premium
feeds, and publishing. The launch show is **Ópera en la Selva**. The schema and
Admin support multiple shows; the public launch starts with one.

Start with [Current state and next steps](docs/CURRENT_STATE.md) for the dated
verification results and execution queue. The package version is `0.2.26`;
package version alone does not identify the deployed Worker or prove readiness.

## Runtime and ownership

- This repository owns the stateless Worker, D1 schema, R2 media contracts,
  Queue jobs, scheduled recovery, provider adapters, and executable gates.
- D1 owns durable workflow, publication, entitlement, and review state. R2 owns
  private masters and derivatives; Analytics Engine receives bounded telemetry.
- [dust-wave-new](https://github.com/aindaco1/dust-wave-new) owns public show
  pages, canonical News pages, the existing player, member pages, and Admin UI.
- Pool, Store, and Podcast retain separate data, credentials, sessions, and
  deployments. Shared mechanism comes from the pinned Platform submodule.
- Heavy audio/model work runs in signed GitHub processors. The Worker validates
  immutable input revisions, callbacks, and approvals before accepting results.

## Local setup

Use Node 22 for CI parity. Full media tests also need FFmpeg/FFprobe,
ImageMagick, Fontconfig, and a usable font; CI installs these explicitly.

```sh
git submodule update --init --recursive
npm ci
# First setup only; preserve an existing local secret file.
test -e .dev.vars || cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Secrets belong in ignored local files or the relevant Cloudflare environment.
Staging and production bindings are explicit in [wrangler.jsonc](wrangler.jsonc).
Do not copy provider payloads, subscriber addresses, or private feed URLs into Git.

Platform is pinned at `a0006c3e0c3f8ab814387491753989956adbbe94` (`v0.23.0`):

| Package | Version | Use |
|---|---|---|
| `@dustwave/admin-shell` | `0.10.2` | Shared Admin primitives and codecs |
| `@dustwave/media-core` | `0.4.0` | Media and processor contracts |
| `@dustwave/tax-core` | `0.2.0` | Bounded tax-provider transport |
| `@dustwave/timed-text` | `0.5.0` | Transcript and alignment contracts |
| `@dustwave/worker-core` | `0.11.0` | HTTP, sessions, GitHub, and provider primitives |

The alignment submodule is pinned at
`32111c2a8dd62d891c4309f7638a86c31a789dc3`. Its separately pinned model execution
identity and post-launch acceptance requirements live in
[the alignment gate](docs/ALIGNMENT_GATE.md).

## Verification

```sh
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
npm run gate:public:staging
npm run gate:public:production
```

`check` runs the tracked-secret scan, dependency audit, generated types,
typecheck, and tests. Dry runs validate packaging. Public gates read RSS,
artwork, cache/security headers, and conditional requests. Remote migrations,
deployment, provider exercises, and readiness approval are separate operations.
See the current-state report for known checks outside the default suite.

## Documentation map

| Document | Responsibility |
|---|---|
| [Current state](docs/CURRENT_STATE.md) | Dated evidence, blockers, concrete next steps, cleanup record |
| [Roadmap](docs/ROADMAP.md) | Stable product decisions, delivery milestones, definition of done |
| [Owner actions](docs/OWNER_ACTIONS.md) | Outstanding human decisions and provider access requirements |
| [Prelaunch readiness](docs/PRELAUNCH_READINESS.md) | Executable platform/launch distinction and first-content activation |
| [User flows](docs/USER_FLOWS.md) | Listener, member, and Admin journeys with regression ownership |
| [API](docs/API.md) | HTTP, authorization, publication, and cache contracts |
| [Security](docs/SECURITY.md) | Trust, privacy, storage, and provider boundaries |
| [Staging runbook](docs/STAGING_RUNBOOK.md) | Source verification, configuration, backup, deployment, rollback |
| [Migration validation](docs/MIGRATION_VALIDATION.md) | Migration-specific schema checks and rollback constraints |
| [Staging acceptance](docs/STAGING_ACCEPTANCE.md) | Media, editorial, UI, and controlled-provider exercises |
| [Launch Lab runbook](docs/LAUNCH_LAB_RUNBOOK.md) | Isolated provider rehearsals, reconciliation, cleanup, evidence acceptance |
| [Processor dispatch](docs/PROCESSOR_DISPATCH_AUTOMATION.md) | Automatic job discovery, signed dispatch, retries, recovery |
| [Queue failures](docs/QUEUE_FAILURE_AUTOMATION.md) | Content-free terminal incident handling |
| [Dynamic ads](docs/DYNAMIC_ADS_GATE.md) | Sponsor decisions, qualification, pacing, fallback |
| [Virtual audio](docs/VIRTUAL_AUDIO_GATE.md) | Protocol/load and real-client acceptance |
| [Alignment](docs/ALIGNMENT_GATE.md) | Bilingual benchmark and exact word-alignment approval |
| [Clip rendering](docs/CLIP_RENDER_GATE.md) | Private rendering, validation, publication boundaries |
| [Architecture decisions](docs/adr) | Durable runtime and promotion decisions |
| [Changelog](CHANGELOG.md) | Released changes; older history remains in Git |

Keep each fact in its owning document and link to it. Replace dated status in
`CURRENT_STATE.md`; keep API detail out of the roadmap and completed task diaries
out of operating procedures. Older acceptance observations are labeled in the
[historical appendix](docs/STAGING_ACCEPTANCE.md#historical-observations). Keep
`README.md`, `LICENSE`, `AGENTS.md`, and `CHANGELOG.md` at the root; put project
guides in `docs/` and keep submodule documentation with its owning repository.
The old [Codex handoff](docs/CODEX_PROJECT_HANDOFF.md) is a
compatibility link to the current-state report.
