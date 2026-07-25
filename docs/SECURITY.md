# Security and privacy boundaries

## Authentication and authorization

- Administrator and listener login are passwordless and
  enumeration-resistant. Their lookup peppers, session secrets, cookies,
  rate-limit tables, Turnstile actions, and URL scopes are independent.
- Login initiation requires the configured site origin and Turnstile action.
  Atomic D1 buckets cap requests per pseudonymous client and normalized-email
  HMAC while preserving the same accepted response for registered and
  unregistered addresses. Token exchange has an independent client cap.
- D1 stores an HMAC lookup value instead of a raw email address.
- Login and session secrets are one-way hashes at rest; login tokens are
  single-use.
- The session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, and path-scoped.
- Mutations require a same-origin check and a session-bound CSRF token.
- Listener session responses expose only internal identity, show/subscription
  status, computed entitlement, and whether a feed exists. They never expose
  email, Stripe customer/subscription IDs, or private-feed tokens.
- Show-announcement consent is an explicit listener mutation with the
  listener-scoped cookie, exact site origin, and current CSRF token. Consent is
  stored per listener/show with a bounded English/Spanish preference and
  withdrawal timestamp. Subscription or Pool entitlement never silently
  enables it.
- Private-feed creation and rotation require the listener session, exact site
  origin, and session-bound CSRF token. A 256-bit bearer value is returned only
  once; D1 stores an HMAC under an independent pepper and enforces one active
  token per listener/show. Rotation revokes the old URL in the same D1 batch.
- Roles are `super_admin`, `admin`, `producer`, and `analyst`, with optional
  show scope. Multiple super-admins are supported.
- Super-admin management must preserve at least two active super-admins before
  production. Lifecycle mutations require a session authenticated within 15
  minutes, CSRF/origin validation, and a global super-admin role. D1 triggers
  preserve the last two active super-admins under concurrent status, role, or
  user deletion attempts; API preflight returns a stable conflict first.
- Every implemented content, media, and publication mutation emits a D1 audit
  event without credentials or raw email addresses.
- Sponsor campaign creation, edits, approval, and the kill switch are
  show-scoped admin mutations with CSRF/origin enforcement and audit events.
  Edits reset approval; direct campaigns require an active sponsor; revoked
  rows cannot be silently reactivated.
- Episode ad plans separate producer marker intent from machine evidence and
  human approval. Browser requests cannot write ready marker/segment rows.
  Processor callbacks use a dedicated staging secret, a five-minute timestamp,
  and an HMAC over the exact body; source identity, output prefix, frame/size
  constraints, manifest digest, and current private R2 objects are rechecked
  before approval.
- Signed ad decisions are available only when the staging-only mode and secret
  are both present. The HMAC binds ID, expiry, and manifest digest and is
  verified before D1; the stored manifest hash and every R2 size/ETag are
  checked before headers. Production hard-codes the mode disabled and the
  permanent enclosure does not call this route.
- Decision-key rotation issues only with the current secret and may validate
  against one previous secret for the bounded two-hour overlap. Retire the
  previous secret after that window; never reuse the production key in staging.
- Creative replacements and program processing use immutable/versioned or
  content-addressed R2 keys so an already issued decision cannot be changed by
  a later upload. Qualification dedupe and hard-cap increments are enforced
  inside SQLite, not by a race-prone application read/modify/write.

## Storage and delivery

- R2 buckets remain private. The Worker mediates public and premium
  access so object URLs cannot bypass entitlement or ad policy.
- Public media is served only for a due, public-eligible, ready episode.
- Private RSS and media recheck active, unexpired show entitlement on every
  request. Due early-access and premium-bonus windows are evaluated in D1;
  invalid, revoked, cross-show, and expired tokens all fail as the same `404`.
  Private responses are no-store, omit public CORS, and carry noindex and
  no-referrer policy.
- Raw private-feed bearer values are never stored or written by application
  logs. Cloudflare automatic invocation URL logs are disabled for the Worker;
  explicit structured logs contain event metadata rather than request URLs.
  Token `last_used_at` is updated at most hourly to bound D1 writes.
- Insertable MP3 creatives must be frame-aligned and free of ID3 metadata;
  decision and fallback byte-length declarations are recomputed from their
  signed manifests before delivery.
- House fallbacks are selected only from approved, currently eligible
  inventory and must exactly match the selected creative's validated byte
  count, duration, MIME type, and stream profile. Their immutable object and
  campaign evidence is snapshotted separately from billable sponsor evidence.
- Byte ranges are validated and bounded; upload kinds, MIME types, object
  sizes, filenames, and part numbers are allowlisted.
- CORS reflects only explicit origins. Admin responses are private/no-store and
  marked noindex.
- Ready clip preview/download remains under the path-scoped admin session.
  The Marketing library returns only bounded show-scoped metadata and those
  same ready media paths; it never returns an R2 object key or public URL.
  Every request rechecks show-scoped Analyst-or-higher access and exact D1/R2
  byte, MIME, native checksum, custom checksum, and manifest evidence before
  serving one bounded MP4 range. The response exposes no private object key,
  reflects credentialed CORS only to an allowlisted admin origin, and remains
  private/no-store/noindex.
- Announcement review is show-scoped to Producer-or-higher and CSRF protected.
  The eligible audience requires both an explicit, non-withdrawn show consent
  and an active, unexpired entitlement. The response includes only a count and
  keyed pseudonymous revision hashes, never email addresses or listener IDs.
  CTA links must remain on the configured Dust Wave site origin.

## Provider boundaries

- The announcement endpoint is structurally review-only: it writes no outbox,
  exposes no send mode, and cannot call Resend. Live delivery remains blocked
  until a durable, idempotent, suppression-aware outbox and unsubscribe path
  pass an independent staging gate.
- Stripe webhooks require a valid signature and matching test/live mode before
  D1 is touched. Event IDs are journaled once; failed/received projections can
  retry idempotently instead of being mistaken for completed duplicates.
- Stripe product and price identifiers are configuration, not credentials.
  Checkout stays disabled behind `SUBSCRIPTION_CHECKOUT_ENABLED` until the
  provider, signed webhook, listener email-HMAC, rate-limit HMAC, Turnstile,
  active price, and approved tax gates all pass.
- Subscription tax estimates reuse Store-characterized destination and
  integer-cent primitives through `@dustwave/tax-core`; provider lookup,
  jurisdiction approval, and subscription policy remain in their owning
  runtimes. Podcast accepts only assigned, effective, accountant-approved
  versions with a manual Stripe Tax Rate mapping, retains no submitted address,
  exposes no Stripe Tax Rate ID, and caps pseudonymous clients at 60 quotes per
  minute. At Checkout, raw email and normalized address go only to Stripe; D1
  retains keyed hashes and an immutable tax evidence snapshot. The fixed
  approved rate is attached to recurring subscription invoices; Stripe Tax and
  country/state-only dynamic rate matching stay off so they cannot override a
  ZIP/location-specific Store result. Provider mappings are mode-bound so test
  data cannot satisfy live billing readiness.
- Checkout customer/session calls use deterministic provider idempotency keys.
  Unknown/network outcomes preserve the attempt and reuse the same key; safe
  provider errors are reduced to codes and no provider body, email, address, or
  Checkout URL is logged or stored. One active attempt per show/email HMAC
  prevents parallel plan sessions.
- Stripe webhook projections store independent Stripe, Pool, and manual
  entitlement sources and recompute one show-access projection. Canceling one
  source cannot revoke another active source. D1 never stores a full Stripe
  event payload.
- Pool benefit grants use a dedicated timestamped HMAC back channel. Raw
  recipient email and redemption code are accepted only in that authenticated
  request and are reduced to independent HMACs before D1. Redemption requires
  the verified listener session/CSRF, exact email binding, two atomic rate
  limits, and a D1 trigger that enforces active, unexpired, single-use state.
- Pool revocation is an irreversible tombstone for one provider grant ID and
  cancels only a matching current Pool source. It cannot mutate Stripe/manual
  sources, and an out-of-order grant cannot revive the tombstoned benefit.
- Customer Portal requires an authenticated listener, same-origin CSRF,
  show-scoped Stripe customer, rate limit, and explicit
  `STRIPE_PORTAL_CONFIGURATION_ID`. The matching Stripe Portal profile must
  keep address/rate-changing controls disabled until renewal-time manual-tax
  re-evaluation is implemented and approved.
- GitHub and YouTube writes are dry-run by default. The only implemented
  YouTube exception is a staging-only controlled clip test: Producer+ may
  prepare immutable evidence, but only a recently authenticated super-admin
  may approve; private/unlisted are the only accepted states and production
  routes return `404`. The consumer requires launch-channel OAuth secrets,
  hard-pins Google origins, disables redirects, bounds provider JSON, streams
  the private R2 body, verifies returned channel/privacy, and fails closed if
  the mode is restored before consumption.
- Resend receives the raw destination only at send time. Delivery failures are
  logged by internal admin/listener ID, never by email address.
- Resend calls have an eight-second timeout and a token-hash idempotency key;
  redirects fail closed. Scheduled maintenance removes expired rate buckets,
  consumed login tokens, and revoked/expired sessions after a one-day
  diagnostic buffer.
- Secrets live only in `.dev.vars` or Cloudflare Worker secrets. Existing
  Cloudflare secrets cannot and should not be read back or copied by the
  application.
- The ad-plan staging processor requires its own least-privilege R2-capable
  Cloudflare token. The clip processor deliberately receives no R2 credential:
  it uses purpose-bound signed source/output routes that stream through the
  Worker's private R2 binding. Both processors use the dedicated staging
  callback secret; Pool/Store deployment secrets are not copied or exposed.
- Forced alignment runs outside the public Worker in the pinned
  `alignment-runner` submodule. It accepts only checksummed, bounded local
  inputs, prevents path/model-reference traversal, rechecks audio after model
  execution, imports heavyweight libraries only inside selected adapters, and
  atomically refuses conflicting result writes. Raw transcripts and audio are
  not included in GitHub Actions or committed benchmark evidence.

## Before production

- Re-run the private-feed threat model and rotation drill alongside real-time
  ad decisions, webhook replays, Pool redemption codes, checkout recovery, and
  transcript/clip file access.
- Verify deployed login, checkout, Portal, and exchange caps and add equivalent
  limits for uploads, publication, and provider callbacks before activation.
- Extend recent-auth requirements from the protected super-admin lifecycle to
  future destructive or live billing-provider mutations.
- Validate logs contain no tokens, raw emails, Stripe payload bodies, media
  source URLs, or transcript content.
- Complete backup/restore, queue replay, secret rotation, incident response,
  and provider revocation drills.

## Transcript review boundary

Transcript review writes use show-scoped Producer/Admin/Super-admin sessions,
site-origin and CSRF checks, stable mutation IDs, and optimistic base
revisions. Full transcript text is never included in audit metadata or logs;
audits retain only episode/language, cue count, revision, content digest, and
speaker-confirmation state. The Worker accepts structured cue Markdown only,
rejects active HTML/control characters, caps cue/text counts and the canonical
payload at one megabyte, enforces
monotonic in-duration timing, and supersedes mismatched alignment evidence.
Only Admin/Super-admin may approve a revision, and approval fails while any
non-empty speaker label is unconfirmed.

Public transcript reads are slug-addressed and fail closed behind the same
published/due/public-or-free-or-early-access/ready-media policy as canonical
News/audio publication. Premium bonuses, drafts, future releases, archived
shows, and unknown records all return the same no-store `404`. The projection
reads only immutable revision+approval rows, re-parses the restricted cue
contract, rejects control and bidirectional direction-override characters,
requires confirmed speaker labels, and recomputes SHA-256 before including a
language. It strips the restricted editor markup to plain text and never
returns internal transcript/admin IDs or word records. Public JSON uses
content-derived ETags, bounded cache freshness, wildcard read-only CORS,
noindex, nosniff, and a deny-all document CSP.

## Chapter boundary

Chapter editing reuses the original normalized episode rows and adds a
revision header, replay-safe optimistic mutations, immutable JSON snapshots,
and exact Admin/Super-admin approvals. Producer+ mutations require a
show-scoped session, allowed origin, and CSRF. Server validation caps count,
duration, title and URL sizes; requires ordered in-duration starts and an
00:00 first marker; rejects control/bidirectional override/markup characters;
and accepts HTTPS URLs without credentials only. Audit metadata contains the
episode, revision, count, and digest—never chapter titles or URLs.

Public chapter documents use the same due/public-access/ready-media boundary as
canonical News. Entitled early-access and premium-bonus documents have a
separate tokenized route that HMACs the bearer before D1 and rechecks active,
unexpired show entitlement on every read. Both projections read immutable
approval/revision pairs and recompute SHA-256; missing, unapproved, malformed,
tampered, or unauthorized records fail closed. Public documents use short
cache/ETag/CORS headers; private documents are no-store, omit wildcard CORS,
and never expose the bearer in D1 or response content. The first-party News UI
does not request remote chapter artwork, avoiding an extra listener-tracking
request; related links are no-referrer and noopener/noreferrer.

## Production-review boundary

Production review is private, show-scoped, no-store admin data. Analyst+ may
read; Producer+ may create notes and change non-approval state; Admin+ is
required to approve or reopen an approved target. All writes require the
allowed site origin and current CSRF token. Assignments resolve only to an
active administrator with a global or matching-show role.

The server, not the client, resolves the exact current media/revision digest.
Every review stores that immutable reference, stale references remain
historical, and stale targets cannot be newly approved. Comment ranges are
bounded by episode duration; text is normalized plain text with body/count and
control/bidirectional-override limits. Optimistic mutations are replay-safe and
content-digested. Audit events intentionally omit comment bodies. Readiness
requires every exact current target, not merely every review record that
happens to exist, and fails closed when its bounded evidence is truncated. It
remains explicitly non-enforcing.

## Publication-readiness boundary

Publication readiness is a role-scoped Analyst+ `GET` with credentialed
allowlisted CORS, private/no-store/noindex headers, and no CSRF exception
because it cannot mutate state. It uses the same prerequisite function as the
legacy Publish route, then composes bounded D1 evidence; it performs no R2
head, GitHub/YouTube request, queue send, audit write, or provider lookup.

The response exposes booleans, counts, statuses, revision numbers, configured
mode labels, and a content digest. It omits object keys, raw ETags, source
digests, transcript/chapter/clip text, review notes, job errors, credentials,
and listener data. The exact publication-fingerprint function is shared with
Publish so post-schedule content drift becomes stale evidence. Snapshot hashing
excludes wall-clock time. Missing,
incomplete, stale, failed, or safety-truncated evidence is never promoted to
ready. The candidate is deliberately non-enforcing and offers no override;
connecting it to publication requires a separate recent-auth, reasoned,
audited, exact-snapshot approval and rollback change.

## Clip-render boundary

Clip recipes are private, show-scoped, CSRF-protected Producer+ revisions.
They snapshot the exact approved transcript digest/revision and source-audio
key/bytes/ETag, derive segment boundaries from stable cue IDs, cap duration,
and keep word cuts unavailable without a matching passed alignment and real
non-interpolated word boundary records. Recipe and render audits contain
digests, dimensions, language, boundary mode, and duration—never caption text.

Render requests are one-per-clip-revision and produce a predetermined private
R2 key plus a checksummed processor manifest at the canonical configured
origin. Purpose-bound manifest and source JSON requests are staging-only,
HMAC/timestamp authenticated before D1, and body-bounded. Source delivery uses
an R2 conditional read against the snapshotted ETag and a private, no-store
stream.

Output uploads carry a signed base64url descriptor, exact Content-Length, and
a maximum of 95 MiB so they remain below Cloudflare's 100 MB Free/Pro request
limit. The Worker streams the body directly to R2 with native SHA-256
verification and fixed content/custom metadata; the processor never receives
an R2 credential. Captions are rasterized without a shell, cue count/density
and total caption bytes are bounded, and GitHub artifacts exclude source,
manifest, caption, and MP4 files. Action dependencies are pinned to full
commit SHAs and the processor secret is scoped only to signing steps.

The completion callback is replay-safe. Ready state re-heads R2 and requires
exact MP4 dimensions/duration, byte count, native checksum, and custom metadata
matching both output and manifest digests. A callback for a stale revision may
preserve historical evidence but cannot change the current clip. There is no
public clip route.

The separately authorized Shorts test stores one publication per render and
revalidates the current revision plus the same D1/R2 evidence before any
provider call. The confirmed URL must match both show metadata and the
configured launch credential. Dry-run evidence may be promoted once to the
controlled queue without creating a second publication. Queue/provider
failures are terminal to prevent at-least-once delivery from silently
duplicating a video. A provider success followed by verification or D1/audit
failure requires manual channel reconciliation before any new attempt; secrets,
OAuth tokens, upload-session URLs, object keys, and provider bodies are never
logged or returned.
