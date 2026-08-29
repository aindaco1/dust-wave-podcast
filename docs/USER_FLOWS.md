# Podcast user-flow authority

This is the canonical inventory for shipped listener, member, and administrator
journeys across the Podcast Worker and the `dust-wave-new` website. It records
the user-visible path, the failure or empty states that must remain usable, the
UX health observed on 2026-08-21, the cross-repository regression contract for
each flow, and the deterministic coverage revalidated on 2026-08-28.

The inventory describes product behavior, not launch authorization. Provider
activation, content readiness, and owner approvals remain governed by
`PRELAUNCH_READINESS.md`, `OWNER_ACTIONS.md`, and `STAGING_RUNBOOK.md`.

## Flow inventory

| ID | Persona and goal | Entry | Successful path | Required alternate states | UX health | Regression contract |
| --- | --- | --- | --- | --- | --- | --- |
| LF-01 | Listener discovers a show | Public show URL or site navigation | Understand the show, language, availability, and next action on desktop or mobile | Coming-soon, no-episode, missing-artwork, and unsupported-language states remain intentional and legible | Healthy | web: `dust-wave-new/scripts/validate-podcast-shows.mjs`; worker: `tests/show-site-projection.test.ts` |
| LF-02 | Listener plays or downloads a public episode | Published episode page or RSS client | Start, pause, seek, change speed, resume, and download the authorized enclosure | Missing media, range requests, non-public access, and stale publication resolve without exposing private state | Healthy | web: `dust-wave-new/scripts/validate-podcast-player.mjs`; worker: `tests/feed-media.test.ts` |
| LF-03 | Listener uses transcripts, chapters, and public clips | Episode supporting-content controls | Navigate timed text, chapters, captions, and approved clips in either supported language | Missing, stale, unapproved, or premium-only artifacts fail closed and remain distinguishable from a broken page only when appropriate | Healthy | web: `dust-wave-new/scripts/validate-podcast-transcript.mjs`; worker: `tests/public-transcripts.test.ts` |
| LF-04 | Listener buys Premium | Enabled show plan selector | Choose plan, enter address in conventional order, review an exact tax-inclusive total, and continue to Stripe Checkout | Checkout disabled, tax not configured, invalid address, cancellation, expiration, and provider failure explain the next safe action | Guarded | web: `dust-wave-new/scripts/validate-podcast-checkout.mjs`; worker: `tests/subscription-checkout.test.ts` |
| MF-01 | Member signs in without a password | Member account page | Request a generic-response magic link, exchange it once, restore the session, and sign out | Unknown email, expired or replayed link, Turnstile failure, and network failure do not leak account existence | Healthy | web: `dust-wave-new/scripts/validate-podcast-member.mjs`; worker: `tests/listener-auth.test.ts` |
| MF-02 | Member manages an active subscription and private feed | Authenticated account dashboard | See plan/status, create or rotate the private RSS feed, and copy the feed URL | No subscriptions, inactive entitlement, an existing feed, and failed rotation have clear non-destructive outcomes | Healthy | web: `dust-wave-new/scripts/validate-podcast-member.mjs`; worker: `tests/private-feeds.test.ts` |
| MF-03 | Member changes announcement preferences | Subscription card notification form | Opt in with a re-entered account email and language, or opt out without an email field | Email field stays hidden and disabled while opted out; invalid destination and delivery failure preserve the preference safely | Fixed | web: `dust-wave-new/scripts/validate-podcast-member.mjs`; worker: `tests/notification-preferences.test.ts` |
| MF-04 | Member opens Stripe billing management | Active Stripe-backed subscription | Open the exact HTTPS Stripe Customer Portal destination | Unavailable billing, inactive subscription, unsafe redirect, and provider failure stay on the account page with actionable copy | Healthy | web: `dust-wave-new/scripts/validate-podcast-member.mjs`; worker: `tests/subscription-portal.test.ts` |
| AF-01 | Administrator signs in and restores a role-scoped session | Podcast admin URL | Request a magic link, exchange it once, restore authorized controls, and sign out | Unauthorized role, expired/replayed link, Turnstile failure, and network failure fail closed without leaking admin data | Healthy | web: `dust-wave-new/scripts/validate-podcast-admin.mjs`; worker: `tests/admin-auth.test.ts` |
| AF-02 | Administrator selects a show and episode and moves between workspaces | Admin header, selectors, tabs, or deep link | Preserve show, episode, tab, workflow step, and exact tool context across navigation | Missing or deleted context falls back predictably; dirty editorial work blocks accidental context loss | Healthy | web: `dust-wave-new/tests/podcast-admin-deep-link.test.mjs`; worker: `tests/admin-shows.test.ts` |
| AF-03 | Super-admin creates, configures, archives, or deletes a show | Settings workspace | Provision a coming-soon show, edit its projection, archive when it has history, or delete only an empty draft after exact confirmation | Duplicate slug, invalid metadata, stale projection, insufficient role, and unsafe deletion explain the blocked action | Healthy | web: `dust-wave-new/tests/podcast-admin-show-delete.test.mjs`; worker: `tests/admin-show-creation.test.ts` |
| AF-04 | Producer creates and edits an episode | Episodes workspace | Create the episode, edit bilingual metadata/access/release fields, save, and reselect it | Validation, stale revision, authorization, unsaved changes, and scheduled/unpublished states preserve recoverable work | Healthy | web: `dust-wave-new/tests/podcast-admin-episode-editor.test.mjs`; worker: `tests/admin-episodes.test.ts` |
| AF-05 | Producer prepares release media | Episode media tools | Upload source, review QC, choose a working master, enhance if needed, render delivery audio, review, and approve | Upload/processor delay, QC failure, stale derivative, retry exhaustion, and rejected audio identify the exact next tool | Healthy | web: `dust-wave-new/tests/podcast-admin-delivery-audio.test.mjs`; worker: `tests/delivery-audio.test.ts` |
| AF-06 | Producer prepares editorial artifacts | Transcript and chapters workflow step | Transcribe or import, edit/search, confirm speakers, approve, draft show notes, align languages, and approve chapters | Missing master, processing, stale revision, overlap/timing error, unconfirmed labels, and optional bilingual work stay explicit | Healthy | web: `dust-wave-new/tests/podcast-admin-transcript-label-review.test.mjs`; worker: `tests/transcripts.test.ts` |
| AF-07 | Producer reviews readiness and publishes | Episode workflow | Follow the first incomplete required step, resolve exact blockers, complete review, and publish one idempotent revision | Automatic waits, incomplete steps without blockers, failed readiness reads, stale approval, and publish retry are described truthfully | Fixed | web: `dust-wave-new/tests/podcast-admin-publish-workflow.test.mjs`; worker: `tests/publication-readiness.test.ts` |
| AF-08 | Producer creates clips and YouTube deliverables | Review and distribution tools | Draft recipe, render, preview captions, approve public selection, prepare audio rendition, and authorize the configured YouTube mode | Private/unlisted safeguards, stale render, provider delay, uncertain upload, disabled mode, and retry remain explicit | Healthy | web: `dust-wave-new/tests/podcast-admin-clip-preview.test.mjs`; worker: `tests/clip-publications.test.mjs` |
| AF-09 | Administrator validates distribution or migrates an existing RSS feed | Distribution workspace | Validate canonical feed/resources, complete directory evidence, review an import plan, reconcile copied drafts, and prepare a manual cutover packet | Invalid feed, redirect loop, stale observation, identity conflict, incomplete directory recovery, and disabled activation fail closed | Healthy with disclosure | web: `dust-wave-new/tests/podcast-admin-distribution-disclosure.test.mjs`; worker: `tests/feed-validation.test.ts` |
| AF-10 | Producer prepares marketing links, assets, and announcements | Marketing workspace | Create canonical tagged links/QR/player/social card and send or schedule an approved bilingual announcement | Missing publication, dry-run mode, suppressed recipient, delivery retry, and stale announcement evidence prevent accidental live sends | Healthy | web: `dust-wave-new/scripts/validate-podcast-admin.mjs`; worker: `tests/marketing.test.ts` |
| AF-11 | Analyst reviews audience and subscribers | Audience workspace | Read qualified downloads/listens/completion, inspect breakdowns, review subscription state, and export authorized aggregate data | Empty series, unsupported retention inference, inactive subscribers, and export authorization remain clear and privacy-preserving | Healthy with disclosure | web: `dust-wave-new/scripts/validate-podcast-accessibility.mjs`; worker: `tests/podcast-analytics.test.ts` |
| AF-12 | Administrator manages sponsors, ads, Premium prices, tax, and billing evidence | Monetization workspace | Configure guarded campaigns/creative/decisions and approve exact Premium price and tax policy evidence | Preview-only ads, kill switches, incomplete tax jurisdiction, provider mismatch, and stale approvals block activation with specific evidence | Healthy with disclosure | web: `dust-wave-new/tests/podcast-admin-tax-policy.test.mjs`; worker: `tests/tax-policies.test.ts` |
| AF-13 | Super-admin rehearses launch dependencies without real content | Launch Lab workspace | Reconcile isolated fixtures, exercise signed provider boundaries in approved modes, inspect durable results, and restore safe defaults | Dry-run, unavailable credentials, stale approval, interrupted resumable run, cleanup, and production isolation are visible and bounded | Healthy | web: `dust-wave-new/tests/podcast-admin-launch-lab.test.mjs`; worker: `tests/launch-lab.test.ts` |

## Cross-flow UX contracts

- English and Spanish routes, controls, validation copy, and generated pages use
  the same semantic structure.
- Desktop, tablet, and mobile layouts must not introduce horizontal overflow or
  hide the primary action.
- Keyboard users receive a visible skip link, visible focus, correct tab roles,
  status announcements, accessible audio controls, and decorative glyphs hidden
  from assistive technology.
- Private feeds, subscriber email addresses, provider payloads, and internal
  identifiers never appear in public error states, analytics, fixtures, or
  screenshots.
- Destructive and provider-facing actions require the role, recency, typed
  confirmation, approval, and kill-switch boundaries documented by the API.

## Audit evidence and limits

The 2026-08-21 audit inspected the production public show at desktop, tablet,
and mobile widths; production member and admin entry states; and deterministic
authenticated fixtures for the six admin workspaces, show creation, and member
account management. The public shell, navigation, form hierarchy, responsive
layout, localization, and disclosure patterns were coherent.

Three confusing states were confirmed and corrected during the audit:

1. The opted-out member notification email control was visually present because
   its component `display` rule overrode the HTML `hidden` contract.
2. The global link color overrode the skip link's black text, producing white
   text on a white focused control.
3. A draft episode with no readiness nodes skipped required not-started steps
   and reported zero blockers instead of directing the producer to the first
   incomplete step.

Premium Checkout is currently guarded off in the inspected production state,
so LF-04 was not treated as a completed live visual exercise. Its page contract,
tax/address behavior, provider redirect boundary, and Worker lifecycle remain
covered by deterministic regression tests; a controlled live purchase remains
separate release evidence.

## Maintenance rule

Every shipped user-visible journey must have exactly one row above before it is
considered complete. Update the row and its website and Worker regression paths
in the same change. `tests/user-flow-registry.test.mjs` rejects duplicate IDs,
missing coverage labels, empty or missing Worker regression files, coverage
files without executable assertions, or flows without a recognized UX health
state. When the sibling `dust-wave-new` checkout is present, it also rejects
empty or missing website regression files; a standalone Worker CI checkout still
validates every website coverage label without depending on a parent-directory
layout. The cross-repository check deliberately validates source-level contracts;
live Stripe, Resend, YouTube, directory, and email-delivery exercises remain
explicit acceptance gates so the default suite cannot cause provider side
effects.

Keep implementation ownership similarly narrow: shared platform packages own
only behavior reused across Dust Wave products; the Podcast Worker owns its HTTP,
processor, editorial, RSS-import, billing, and provider contracts; and the
website owns reusable Podcast presentation primitives. New flow modules should
compose those owners instead of copying their validation, response, formatting,
or browser-integration logic.
