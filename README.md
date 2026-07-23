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

## Verification

```sh
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
```

Remote migrations and deploys are intentionally separate commands. Apply and
exercise staging first; production promotion requires an explicit release
decision.
