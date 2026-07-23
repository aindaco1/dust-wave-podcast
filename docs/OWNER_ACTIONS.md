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
| Accountant-approved registrations, taxability, rates, evidence, and effective dates | Purchasable Stripe prices | Awaiting professional approval |
| Sponsor contract/disclosure/creative for the first direct campaign | Direct campaign activation | Not yet required |

Do not put credentials or personal identifiers in this file. Provider secret
presence will be tracked as booleans in the private admin diagnostics.
