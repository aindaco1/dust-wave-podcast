# Prelaunch readiness

This boundary proves that the Podcast platform is ready to receive the first
rights-cleared episode without pretending that content-dependent launch work
has already happened. D1 and the executable gates remain authoritative; this
document is an operating model, not a second readiness store.

## Two truthful readiness signals

Run the content-free composed report against the existing private launch
episode pointer:

```sh
LAUNCH_EPISODE_ID="$(
  gh variable get PODCAST_LAUNCH_EPISODE_ID --env podcast-staging
)"
npm run gate:prelaunch:staging -- "$LAUNCH_EPISODE_ID"
```

The report exposes two independent booleans:

- `platformReady` is true only when every safety, configuration, provider
  access, payment, email, integrity, episode-pipeline, and private-canary node
  is current and has no `FAIL`, `BLOCK`, or `WAIT` result.
- `launchReady` preserves the strict launch gate. It remains false until the
  real content-dependent directory, YouTube publication, and dynamic-ad pilot
  evidence passes.

Only the following strict launch nodes may become `DEFER` in the prelaunch
view:

| Node | Why it is deferred before content | Evidence required later |
|---|---|---|
| Directory certification | A zero-item feed cannot prove ingestion or recovery | Current item-bearing feed plus owner setup, observed ingestion, and failed-to-recovered evidence at ten or more destinations |
| Controlled YouTube publication | The private source-test episode cannot be uploaded | One rights-cleared, reconciled, manually inspected unlisted publication |
| Dynamic-ad durable pilot | Synthetic traffic cannot become a qualified listener download | Approved real episode plan, selected direct campaign decision, and one privacy-minimized qualified native-client completion |

No other `FAIL`, `BLOCK`, or `WAIT` result is softened. In particular, unsafe
provider modes, missing secret names, a fixture selected as the launch show,
failed Stripe or episode gates, stale provider access, canary failures, writes
during the read boundary, and D1 integrity failures remain platform blockers.

Use `--require-ready` to make a local or CI invocation exit nonzero unless
`platformReady` is true. It does not require the three content deferrals to be
complete. The strict final promotion command remains:

```sh
npm run gate:launch:staging -- "$LAUNCH_EPISODE_ID" --require-ready
```

## Private golden canary

The prelaunch report adds one `Private golden-canary rehearsal` node. It
reuses existing durable evidence instead of building another fixture system:

1. the newest isolated Launch Lab run must pass the selected 25 contract
   scenarios for ads, directory preflight, Pool, Resend, RSS, Stripe webhooks,
   and YouTube identity/timing/exclusion; and
2. the newest signed virtual-audio gate must pass at least 5,000 pairs and
   10,000 measured requests with complete lease and object cleanup.

Both sources must be no more than seven days old and have no relevant source
drift. The newest Launch Lab run is authoritative: an older green run cannot
hide a newer incomplete or failed rehearsal. An explicit scenario failure is
`FAIL`; missing, incomplete, stale, or source-drifted evidence is `BLOCK`.

The canary intentionally excludes the real directory-ingestion, unlisted
YouTube-object, and native-client-qualified scenarios. Launch Lab fixtures
remain hidden from public feeds and normal show selectors, and
`launchGateEligible: false` remains mandatory. A canary pass is never
publication, billing, directory, listener, or campaign evidence.

Refresh the two inputs through the existing protected workflows documented in
the staging runbook. The daily readiness monitor only reads their bounded D1
evidence; it does not send email, charge a card, upload media, submit a feed,
or create a qualified ad outcome.

## First-content activation

When the first episode or optional trailer is actually ready, use the existing
Admin workflow rather than creating a parallel release packet:

1. Confirm rights, final title, Spanish-primary summary, English translation,
   release intent, premium/public timing, artwork, and source media.
2. Ingest and process the immutable source through the existing episode,
   production-review, publication-snapshot, and exact-revision gates.
3. Run the prelaunch gate and clear any platform regression before allowing an
   external exercise.
4. Complete and reconcile one tightly controlled unlisted YouTube publication.
5. Generate the directory packet, perform owner steps where required, and let
   the existing pollers collect real ingestion and recovery evidence.
6. Approve the exact Dust Wave ad plan and collect one truthful qualified
   direct-sponsor download from a real client; keep every synthetic request
   ineligible.
7. Run the strict launch gate with `--require-ready`, freeze its exact evidence
   snapshot and rollback plan, then request Super-admin promotion approval for
   that named snapshot.

A trailer is optional. If used, it must be genuinely rights-cleared and
intended for publication; a private processor fixture must never be renamed or
repurposed to manufacture launch evidence.

## Interpretation

| Platform ready | Launch ready | Meaning |
|---|---|---|
| No | No | Fix the first platform action before accepting content |
| Yes | No | The platform is ready; the listed content actions are truthfully deferred |
| Yes | Yes | Platform and real-content evidence pass; exact-snapshot approval may begin |
| No | Yes | Invalid state; treat the report as failed |

Production provider capabilities remain fail-closed in every state. Neither
boolean authorizes a public route, live Checkout, YouTube upload, directory
submission, email delivery, Pool redemption, or ad activation by itself.
