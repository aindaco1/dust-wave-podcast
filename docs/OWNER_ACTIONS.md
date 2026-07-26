# Owner action queue

These decisions do not block local or authenticated staging implementation.
They do gate the indicated production action.

| Input | Needed before | Status |
|---|---|---|
| Permanent feed and media hostnames | Directory submission or public feed route | Confirmed: `feeds.dustwave.xyz` and `media.dustwave.xyz`; attach only after the Worker routes pass staging |
| Confirm the Substack blond-profile artwork and wordmark as launch assets | Public Dust Wave show-page promotion | Confirmed |
| Final Spanish or bilingual canonical show description | Public metadata/feed promotion | Confirmed: Spanish primary with English translation |
| `Ópera en la Selva` early-access default | First premium episode schedule | Confirmed: seven days before public release with per-episode override |
| Optional free mini-episode | First-show offer activation | Confirmed: enabled, maximum one |
| At least one additional super-admin identity | Production admin authentication | Confirmed privately; raw address remains outside the public repository |
| Resend sender and staging API key | Staging magic-link delivery | Existing infrastructure is operational; use or rotate a least-privilege key without committing it |
| Resend signed webhook endpoint and secret | First controlled live announcement test | Create a Podcast-specific webhook for delivered, bounced, complained, failed, and suppressed events; keep announcement mode dry-run until its signature/replay/suppression exercise passes |
| Turnstile staging key pair | Staging admin login | Existing infrastructure is operational; configure the secret in the Worker and the site key in the admin shell |
| Accountant-approved registrations, taxability, rates, evidence, and effective dates | Purchasable Stripe prices | Awaiting professional approval |
| Podcast-only Stripe Customer Portal profile with address/rate-changing controls disabled | First controlled Portal session | Staging configured; production profile remains a promotion-time action |
| Pool benefit product/tier mapping and entitlement duration for each podcast | First controlled Pool-code grant | Awaiting selection; the bridge and Dust Wave redemption flow remain mapping-independent |
| Sponsor contract/disclosure/creative for the first direct campaign | Direct campaign activation | Not yet required |

Do not put credentials or personal identifiers in this file. Provider secret
presence will be tracked as booleans in the private admin diagnostics.
