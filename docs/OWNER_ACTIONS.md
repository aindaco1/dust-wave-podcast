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
| First rights-cleared source audio plus final episode title/summary/release intent | First real staging episode, QC, transcript, clip, and YouTube pipeline | Source confirmed: Jay Renteria authorized the Dust Don't Settle appearance for private staging. Source upload and QC passed with zero blockers; a final Ópera en la Selva title, summary, and release intent are still required before publication work |
| Full private listen and promote/reject decision for the ready enhanced derivative | Normalized delivery-audio render | Awaiting human review. Staging now discovers the exact ready/QC evidence and sends one expiring bilingual deep link to the configured Super-admin; the content-free gate still orders this decision before delivery rendering so a master replacement cannot immediately stale the MP3 and player peaks |
| At least one additional super-admin identity | Production admin authentication | Confirmed privately; raw address remains outside the public repository |
| Resend sender and staging API key | Staging magic-link delivery | Existing infrastructure is operational; use or rotate a least-privilege key without committing it |
| Resend signed webhook endpoint and secret | First controlled live announcement test | Staging has a dedicated, rotated Podcast webhook for delivered, bounced, complained, failed, and suppressed events. Unsigned rejection plus signed unmatched-event/replay deduplication passed; keep announcement mode dry-run until one consented live delivery and its matched status/suppression exercise pass |
| Turnstile key pairs | Listener/Checkout staging and first production deploy | Dedicated staging pair remains installed for listener and Checkout flows. At owner request, only isolated staging admin login omits the widget; origin checks, rate limits, and single-use Resend links remain. Production admin Turnstile stays required. Dedicated production widget is created for `dustwave.xyz` and `www.dustwave.xyz`; install its retrievable secret only when the production Worker is first created |
| Dedicated restricted Stripe test API key | First controlled Podcast Checkout | Read-only staging preflight passed with the authenticated CLI key and it is installed behind the disabled Checkout switch. Replace the expiring CLI credential with a Podcast-scoped restricted test key before the controlled purchase |
| Accountant-approved registrations, taxability, rates, evidence, and effective dates | Purchasable Stripe prices | Awaiting professional approval |
| Podcast-only Stripe Customer Portal profile with address/rate-changing controls disabled | First controlled Portal session | Staging profile verified active: address, subscription update, and pause are disabled; cancellation is at period end with no proration. Production profile remains a promotion-time action |
| Pool benefit product/tier mapping and entitlement duration for each podcast | First controlled Pool-code grant | Awaiting selection; the bridge and Dust Wave redemption flow remain mapping-independent |
| Sponsor contract/disclosure/creative for the first direct campaign | Direct campaign activation | Not yet required |

Do not put credentials or personal identifiers in this file. Provider secret
presence will be tracked as booleans in the private admin diagnostics.
