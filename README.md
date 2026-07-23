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

## Verification

```sh
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
```

Remote migrations and deploys are intentionally separate commands. Apply and
exercise staging first; production promotion requires an explicit release
decision.

