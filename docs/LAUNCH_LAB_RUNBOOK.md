# Launch Lab staging runbook

Audience: operators refreshing isolated provider-contract evidence.

Use the [staging runbook](STAGING_RUNBOOK.md) for deployment, credentials, backup,
and rollback. Inspect [current state](CURRENT_STATE.md) before selecting a refresh:
local CLI or provider-access failures must be diagnosed through their existing
workflow. The [prelaunch contract](PRELAUNCH_READINESS.md#private-golden-canary)
owns freshness and the distinction between report safety and platform readiness.

For an existing environment, reconcile its current run and exact stored provider
objects before a refresh. Initial setup below applies only to missing configuration
and identified pending migrations; preserve completed evidence and the reusable
test catalog. These workflows can mutate isolated staging/provider test state.

## Choose a procedure

- [Initial setup and recurring rehearsal](#initial-setup-and-recurring-rehearsal)
- [Resend reconciliation](#resend-reconciliation)
- [Stripe lifecycle, refund, and webhook replay](#stripe-lifecycle-refund-and-webhook-replay)
- [Hosted Checkout](#hosted-checkout)
- [Customer Portal](#customer-portal)
- [Accept a run](#accept-a-run)

## Initial setup and recurring rehearsal

The Launch Lab turns provider-dependent prelaunch blockers into repeatable
staging rehearsals without requiring a publishable episode or broad provider
credentials in GitHub Actions.

1. Install the same random `LAUNCH_LAB_CALLBACK_SECRET` in the staging Worker
   and the `podcast-staging` GitHub environment. Never install it in production.
2. Deploy migration `0080` and the matching Worker to staging.
3. Run `Rehearse staging provider contracts`, or locally invoke:

   ```text
   npm run launch-lab -- reconcile
   npm run launch-lab -- record /absolute/path/to/observations.json
   npm run launch-lab -- resend
   npm run launch-lab -- stripe
   npm run launch-lab:stripe-lifecycle
   npm run launch-lab -- status
   ```

The protected workflow derives one stable run ID from the exact source commit,
reuses the existing ad selector, Pool bridge, Stripe client, Resend adapter,
webhook verification, and public routes, and retains only aggregate scenario
state. It is safe to rerun: passed scenarios are immutable, failed observations
may recover to the checked-in expectation, Resend uses stable idempotency keys,
and run/source collisions fail closed.

The protected [provider-contract workflow](../.github/workflows/launch-lab-staging.yml)
owns the complete execution and unconditional cleanup sequence. The local commands
above expose individual phases; consult that workflow when recovering a run.
Validate the relevant [migration contracts](MIGRATION_VALIDATION.md#automation-and-launch-lab)
as part of a schema change.

## Resend reconciliation

Resend terminal evidence normally arrives through the signed webhook adapter.
The special `suppressed@resend.dev` address does not support labeling. If its
signed event arrives without the Launch Lab scenario tag, a rerun correlates
the content-free webhook journal by the exact stored provider ID and gives a
terminal suppression event precedence over earlier/later delivery events.
Migration `0083` adds the partial covering lookup index for that bounded read.
When a synthetic message remains accepted, a rerun may retrieve that exact
already-sent provider object through the bounded read-only adapter. This
fallback does not resend, follow redirects, or retain recipient identity.
Complaint rehearsal may legitimately report `delivered` before the later
`complained` event; that intermediate state must remain running. A same-commit
rerun may recover an older premature mismatch only after the exact stored
provider object reports the expected normalized suppression state.

## Stripe lifecycle, refund, and webhook replay

### 0084 — Test-clock lifecycle

Migration `0084` adds the resumable Stripe provider lifecycle and one reusable
test-only Product/Price identity. Replay every migration, run
`tests/launch-lab-stripe-lifecycle.test.mjs`, and confirm the adapter cannot
call Stripe outside staging test mode; does not advance before the signed
webhook source matches; records only renewal, payment failure, recovery, and
cancellation; deletes the test clock; restores zero Launch Lab checkout,
listener, source, and aggregate rows; and leaves foreign keys clean. The
provider catalog fixture remains active only in Stripe test mode so later
rehearsals can reuse it without unbounded Product/Price creation.

### 0085 — Refund verification

Migration `0085` adds only the test-mode refund identifier required to resume
refund verification. Replay every migration and confirm the lifecycle resolves
one exact paid recovery Invoice Payment, creates one idempotent full refund,
waits while the refund is pending, records `refund` only after a terminal
`succeeded` response, and still leaves refund webhooks unable to alter access.
The test asserts that no PaymentIntent, email, address, or card value is stored
in D1 or returned through the Launch Lab response.

### 0087 — Duplicate and out-of-order webhooks

Migration `0087` adds the exact subscription/event-order index used by the
test-clock lifecycle. After recovery and before refund, the adapter retrieves
the bounded journal candidates through the shared Stripe client, verifies the
current `active` and older `past_due` events against the exact fixture attempt,
and requests test-mode redelivery to the checked-in staging endpoint. The
signed duplicate callbacks record `duplicate_webhook=idempotent` only when the
current source remains unchanged and `out_of_order_webhook=reconciled` only
when the older provider second is below the still-active source second. Stable
idempotency keys make reruns safe; production has no endpoint identifier or
execution path.

## Hosted Checkout

Use the on-demand [hosted Checkout workflow](../.github/workflows/launch-lab-hosted-checkout-staging.yml).

Migration `0086` adds the isolated hosted Checkout phase machine. Run the
on-demand `Rehearse staging hosted Checkout` workflow only while an authorized
operator or browser controller is ready to complete the test Session. The
workflow reconciles the hidden fixture, verifies Stripe readiness, creates the
Session without changing `SUBSCRIPTION_CHECKOUT_ENABLED=false`, and waits at
`session_open`. From a current staging Super-admin session, request the private
CSRF-protected handoff and complete the $1 test-card checkout. Confirm the
provider-signed `checkout.session.completed` projection activates the exact
fixture source before the workflow records `checkout_success`. Stripe returns
the browser to `/admin/podcasts/?checkout=launch-lab-success`; the cancellation
URL uses the same admin route. The workflow then cancels the subscription,
waits for the signed cancellation projection, records `cancellation`, deletes
the Customer, removes local fixtures, and retains only content-free status. Its
unconditional cleanup expires the Session and deletes the Customer if the
browser window is missed or any step fails.

## Customer Portal

Migration `0088` adds a separate content-free Customer Portal rehearsal. The
scheduled provider-contract workflow creates one isolated test Customer with a
stable idempotency key, retrieves it to re-attest the exact Launch Lab
metadata, and creates a session through the configured Podcast-only Portal
profile. It verifies Stripe's echoed Customer, configuration, staging account
return URL, test-mode flag, and hosted origin without persisting or returning
the Portal URL. The next phase deletes the Customer and records only bounded
state; an `always()` cleanup deletes the same exact Customer and marks an
interrupted run aborted. Production and live mode reject before D1 or Stripe.

## Accept a run

Super-admins can inspect the same content-free evidence through
`GET /v1/admin/launch-lab`. Loading this view does not refresh or otherwise
mutate the ledger, and the fixture stays absent from normal show selectors.

The initial matrix contains 41 scenarios across Resend, Stripe, YouTube, RSS,
directories, ads, and Pool. The scheduled real-schema lifecycle replay may
mark Stripe's synthetic `webhook_contract` and Pool's seven synthetic
grant/redeem/duplicate/revoke/expiry/overlap/feed-rotation scenarios, plus the
RSS enclosure HEAD/range and approved transcript/chapter contracts, only after
their exact production route tests pass in the same workflow. It may also mark
the credential-free directory packet, canonical feed validation, early-access
YouTube hold, and premium-bonus YouTube exclusion only after their production
contract tests pass in that workflow. The root publication plan carries an
explicit `public_release` timing and Publish derives `scheduled_at` from it;
the policy rehearsal therefore exercises the same timing source as the admin.
The workflow runs these local adapters before fixture reconciliation. That
reconciliation may then advance YouTube channel identity only from the
existing provider-health row when it exactly matches the configured channel,
is less than 24 hours old, and has no active lease; it performs no provider
call and returns no account reference.
Real test-clock renewal, payment failure, recovery, and cancellation now pass
only after their provider subscription state and the production signed-webhook
projection agree. The full recovery-payment refund additionally requires an
exact paid Invoice Payment and terminal successful provider refund. Scenarios
needing a native client, an unlisted YouTube object, or directory ingestion
remain `pending` until their adapters produce truthful evidence. A pending or
passing synthetic scenario never counts as listener, billing, publication,
directory, native-client, or durable campaign evidence. The only narrow
exception is the fresh, passed Resend `suppressed` scenario: the composed
launch gate may use it for the technical provider-suppression subcheck because
the designated test address cannot complete listener authentication. It
cannot satisfy the separate consented-delivery or post-delivery-withdrawal
checks, and the Launch Lab response remains `launchGateEligible: false`.

Before accepting a run, confirm the public probe returns `404` for both the
fixture show API and fixture RSS URL, the private fixture feed emits
`<itunes:block>yes</itunes:block>`, and the status artifact says
`launchGateEligible: false`.
