# Processor dispatch automation

This document is the single operational contract for automatically starting
Podcast media processors. It replaces the repeated instruction to copy an ID
from the admin and manually run one of eight GitHub Actions workflows.

The business state remains in each processor's existing D1 table. Automation
does not create a competing job model. Migration `0067` exposes those tables
through `processor_dispatch_sources` and stores only dispatch identity, the
exact processor-manifest digest, lease/retry state, and the accepted GitHub run
ID in `processor_dispatches`.

## Scope

The staging dispatcher covers the ID-based workflows for:

- source-audio QC;
- enhancement previews;
- full enhancement derivatives;
- delivery audio;
- large-source transcription chunking;
- word alignment;
- captioned clip renders; and
- YouTube audio renditions.

Ad-plan processing remains outside this dispatcher because its current
workflow accepts a complete manifest rather than an immutable D1 job ID. Move
it behind an ID-only manifest endpoint before registering it here.

Production is deliberately disabled. The public launch gate and owner actions
remain unchanged.

## Trust and execution flow

1. The Worker cron projects newly queued source jobs into the durable dispatch
   ledger and reconciles source jobs that became running or terminal.
2. Every five minutes, `.github/workflows/dispatch-processors.yml` uses its
   built-in, short-lived `GITHUB_TOKEN` to request at most four leases from the
   isolated staging Worker.
3. Claim, acknowledgement, and rejection bodies use the existing
   `MEDIA_PROCESSOR_CALLBACK_SECRET` HMAC boundary. No Cloudflare credential,
   R2 credential, listener data, media URL, or episode content enters the
   dispatcher.
4. The dispatcher maps each closed processor type to one checked-in workflow
   and one checked-in input name in
   `config/processor-dispatch-registry.json`.
5. GitHub accepts the exact workflow and target ID and returns a run ID. Only
   then does the dispatcher acknowledge the lease in D1.
6. The existing processor workflow fetches its exact private manifest, source,
   and upload contracts from the Worker. Those boundaries continue to validate
   manifest digests, object evidence, size limits, and callbacks.
7. Every signed claim returns content-free counts for all durable dispatch
   states. The scheduled Action writes those counts to its run summary and
   emits a GitHub warning when terminal dispatch failures exist, so routine
   health no longer requires an operator D1 query.

The Worker receives no long-lived GitHub token. The scheduled workflow has only
`actions: write` and `contents: read`. All external actions are commit-SHA
pinned; every processor uses the shared local Node setup action.

## Retry and idempotency rules

- A conditional D1 update grants one lease for one queued ledger row.
- Each source job can have only one ledger row.
- Failed GitHub requests return the row to a bounded, increasing backoff.
- No row can exceed five dispatch attempts.
- A GitHub-accepted workflow is never immediately rejected if the Worker
  acknowledgement is temporarily unavailable. The source job's running state
  reconciles the lease; otherwise lease expiry provides bounded recovery.
- A dispatched run that never starts the exact source job is eligible for
  bounded recovery after eight hours.
- Source terminal state always wins over dispatch transport state.
- Processor workflows retain their per-target GitHub concurrency group with
  `cancel-in-progress: false`, and their Worker claim/callback contracts remain
  idempotent.

## Configuration

Staging requires:

- Worker variable `PROCESSOR_DISPATCH_MODE=github_actions_pull`;
- Worker and GitHub environment secret `MEDIA_PROCESSOR_CALLBACK_SECRET` with
  the same value;
- GitHub environment `podcast-staging`; and
- the checked-in staging origin and workflow mapping in
  `config/processor-dispatch-registry.json`.

Production must retain `PROCESSOR_DISPATCH_MODE=disabled` until a separately
reviewed promotion explicitly changes this contract.

The GitHub workflow uses the repository's built-in token; do not add a
personal access token or GitHub App private key to the Worker.

## Verification

Before applying migration `0067` or deploying staging:

```sh
actionlint .github/workflows/*.yml
npx vitest run \
  tests/processor-dispatches.test.mjs \
  tests/processor-dispatch-script.test.mjs \
  tests/processor-dispatch-registry.test.mjs
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
```

Back up staging D1, apply migrations to staging only, and deploy the staging
Worker. The scheduled GitHub workflow must exist on the repository's default
branch before GitHub will accept automated dispatches.

Run the dispatcher manually once with no pending work and confirm its summary
reports zero claimed jobs and the aggregate durable ledger. Then queue one
rights-cleared, staging-only fixture
through the admin. Confirm:

1. one `processor_dispatches` row is created;
2. one GitHub run ID is stored;
3. a second dispatcher invocation does not start another run;
4. the source processor reaches its normal terminal state;
5. cron reconciles the dispatch row to the same terminal state; and
6. no media URL, secret, listener identifier, or request body appears in logs
   or retained dispatcher artifacts.

Use only aggregate/content-free inspection queries in shared evidence:

```sql
SELECT processor_type, status, COUNT(*) AS total
FROM processor_dispatches
GROUP BY processor_type, status
ORDER BY processor_type, status;
```

## Failure handling

- `401` from claim or acknowledgement: verify the GitHub environment and
  Worker contain the same callback secret; rotate both together if needed.
- `404` from claim: confirm the request targets isolated staging and the
  dispatch mode is enabled there. Production should return `404`.
- GitHub `403`: verify workflow permission is `actions: write`, organization
  policy permits Actions, and the call uses `${{ github.token }}`.
- Missing GitHub run ID: fail the dispatch attempt; do not accept an older
  `204`-style response because it cannot be reconciled safely.
- Repeated queued rows: inspect `failure_code`, `last_error`, attempt count,
  source state, and GitHub Actions status. Never edit source processor state
  directly to force a retry.
- Emergency stop: disable the scheduled dispatcher workflow or set staging
  `PROCESSOR_DISPATCH_MODE=disabled`, then deploy staging. Existing processor
  runs remain governed by their source-table and callback contracts.

Rollback code before rolling back data. Migration `0067` is additive and does
not change any source processor table. Retain its ledger for evidence even when
automation is disabled.
