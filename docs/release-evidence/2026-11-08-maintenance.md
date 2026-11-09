# November 8 maintenance evidence

Source assessed: `b010ca1cc983ea7da6d462dcd82bcea286a92b2b`.

## Local dependency repair

The existing Undici override pinned vulnerable `7.30.0`, causing the default
security gate to fail. Advance that exact override and lock entry to `7.30.1`,
the [patched release](https://github.com/nodejs/undici/releases/tag/v7.30.1).
Keep Wrangler, Platform, runtime routes, and provider policy unchanged.

`npm ci` and `npm run check` pass: zero audit vulnerabilities, secret scan,
generated types, typecheck, and 791 tests in 180 files. Staging and production
Worker dry bundles pass. These checks establish source compatibility, not a
provider recovery or deployment.

## Current provider evidence

- [November 6 Launch Lab](https://github.com/aindaco1/dust-wave-podcast/actions/runs/42403810148): portal and cleanup HTTP 500; retained contract observations fail `api_test_mode` and `product_price_contract` with `stripe_api_unavailable`.
- [November 8 monitor](https://github.com/aindaco1/dust-wave-podcast/actions/runs/42510184619): 8 PASS, 3 BLOCK, 3 DEFER, 1 FAIL. Stripe now passes 14 checks but fails the webhook journal; private canary, channel access, and suppression evidence are blocked.
- A read-only staging D1 query for failed event diagnostics and the portal phase returned HTTP 403. No query rows were available; no database/provider writes were attempted. The owner explicitly chose to leave provider investigation pending on November 8. Do not infer the portal's root cause from the general contract failure.

The previous September checkpoint remains historical evidence in
[Current state](../CURRENT_STATE.md#historical-verification--september-7-2026).
Use the existing runbooks to diagnose exact records and obtain real fresh
provider evidence. No gate, failed event, publication mode, or secret was reset.

## Rollback

Revert the override and lockfile together to recover the prior dependency tree;
that restores the known audit failure and is not an acceptable release baseline.
No migration or deployment rollback is required for this source-only change.
