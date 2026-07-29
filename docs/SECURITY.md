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
  enables it. Enabling requires the matching account email HMAC; the normalized
  destination is sealed with listener-bound AES-GCM and is erased after the
  final withdrawal.
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
- The “10+ platforms” state cannot be enabled by owner notes or a single mutable
  status. RSS root work validates the exact generated body under a fixed byte
  limit and records only its SHA-256, item count, version, timestamps, and a
  closed failure code. Directory observation transitions append immutable
  show/episode/destination evidence. Recovery requires a later observed
  sequence after a failed sequence; D1 triggers make that evidence part of the
  show publication epoch. Listing/dashboard URLs stay in private admin state
  and audit metadata retains only presence booleans.
- Podcasting 2.0 channel identity is a stored lowercase UUIDv5 derived once
  from the first permanent public feed URL. D1 validates its version/variant,
  enforces uniqueness, allows at most one assignment, and makes it immutable
  afterward. Public and private RSS share this value; private bearer URLs,
  staging origins, and later host changes never seed or replace it. UUIDv5
  SHA-1 is used only for standards-compatible identity, not authentication,
  authorization, integrity, or secrecy.
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
- Signed ad decisions are available only in an explicit decision mode with a
  signing secret. The HMAC binds ID, expiry, and manifest digest and is
  verified before D1; the stored manifest hash and every R2 size/ETag are
  checked before headers. Automatic enclosure selection additionally requires
  `staging_public` or `live`, the independent qualification secret, both
  show/episode flags, and exact equal-length house coverage. Committed staging
  remains `staging_validate`, production remains `disabled`, and private
  premium media bypasses this path.
- Decision-key rotation issues only with the current secret and may validate
  against one previous secret for the bounded two-hour overlap. Retire the
  previous secret after that window; never reuse the production key in staging.
- Creative replacements and program processing use immutable/versioned or
  content-addressed R2 keys so an already issued decision cannot be changed by
  a later upload. Qualification dedupe and hard-cap increments are enforced
  inside SQLite, not by a race-prone application read/modify/write.
- Runtime client classification persists only normalized app/device codes.
  The full user agent and connecting address remain in request memory for
  daily/hourly keyed hashes and are not stored in decision or audit rows.
  A direct-ad qualification is attempted only after a complete creative byte
  window has streamed successfully; metadata probes, partial/canceled streams,
  and house/full-file fallbacks never count.

## Storage and delivery

- R2 buckets remain private. The Worker mediates public and premium
  access so object URLs cannot bypass entitlement or ad policy.
- Public media is served only for a due, public-eligible, ready episode.
- Private RSS and media recheck active, unexpired show entitlement on every
  request. Due early-access and premium-bonus windows are evaluated in D1;
  invalid, revoked, cross-show, and expired tokens all fail as the same `404`.
  Private responses are no-store, omit public CORS, and carry noindex and
  no-referrer policy.
- Application and provider boundary times are canonical millisecond UTC
  RFC 3339. Release, premium, entitlement-expiry, assigned-tax, and durable
  publication-job predicates use the same shared RFC 3339 SQL clock. They do
  not compare ISO `T...Z` values with SQLite's space-delimited
  `datetime('now')`; the executable contract also proves same-day
  past/present/future behavior and verifies the due-time index remains usable.
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
- JSON, Stripe webhook, and signed processor callback bodies share one
  streaming byte limiter. It rejects an oversized declared length before
  reading and cancels a chunked/undeclared body as soon as it crosses the
  route's byte budget, so the Worker never relies on a post-buffer size check.
- CORS reflects only explicit origins. Staging and production credentialed
  origin allowlists are mutually exclusive: staging trusts the stable Pages
  staging hostname plus the explicit loopback development origin, while
  production trusts only the canonical and `www` Dust Wave origins. Branch and
  immutable Pages preview hostnames are intentionally excluded. CI rejects
  duplicate, cross-environment, credential-bearing, or path-bearing origins.
  Admin responses are private/no-store and marked noindex.
- Ready clip preview/download remains under the path-scoped admin session.
  The Marketing library returns only bounded show-scoped metadata and those
  same ready media paths plus bounded public-selection state; it never returns
  an R2 object key, digest, ETag, or public media URL.
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
- Announcement approval is show-scoped to Admin-or-higher, CSRF protected, and
  requires authentication within 15 minutes. It freezes immutable content and
  pseudonymous recipient evidence in one D1 batch, then recomputes the frozen
  audience revision before any queue side effect. Every delivery rechecks
  consent, entitlement, destination HMAC, timestamps, and global suppression.
  Admin history exposes only aggregate counts.

## Provider boundaries

- Announcement review is structurally side-effect free. Approval writes a
  durable, audited, idempotent outbox. Staging is explicitly `dry_run`,
  production is explicitly `disabled`, and the live sender fails closed unless
  all independent configuration is present. Public one-click withdrawal is
  token-bound to one listener/show, suppresses pending work, and erases the
  sealed destination when no other consent needs it.
- Resend webhooks require a valid, recent Svix signature over the exact bounded
  body. Event IDs are journaled once; complaint, suppression, and permanent
  bounce events create destination-HMAC suppressions without retaining the
  payload or recipient.
- Stripe webhooks require a valid signature and matching test/live mode before
  D1 is touched. Event IDs are journaled once; failed/received projections can
  retry idempotently instead of being mistaken for completed duplicates.
- Stripe product and price identifiers are configuration, not credentials.
  Checkout stays disabled behind `SUBSCRIPTION_CHECKOUT_ENABLED` until the
  provider, signed webhook, listener email-HMAC, rate-limit HMAC, Turnstile,
  active price, and approved tax gates all pass.
- `npm run gate:stripe:staging` is structurally read-only and staging-scoped.
  It uses Wrangler only for bounded D1 reads and secret-name inventory, and
  Stripe only for test Product, Price, Portal, and webhook reads. It emits
  allowlisted posture/count evidence instead of secret values, customer data,
  addresses, provider payloads, or hosted Checkout URLs. Provider drift is a
  failure; inactive objects and the disabled kill switch are required until
  the accountant gate passes.
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
- Migration `0042` implements the first renewal boundary without enabling
  provider writes. Invoice webhooks reconcile observed Tax Rate IDs and
  integer-cent totals to the immutable Checkout snapshot; customer updates
  normalize and HMAC the transient address before recording only a rate-change
  outcome. Raw invoice payloads, customer addresses, and emails are never
  persisted or exported. Dust Wave out-of-order invoice events retry rather
  than becoming permanently ignored.
- The Super-admin evidence export is bounded, indexed, private/no-store,
  content-allowlisted, and formula-neutralized for CSV. It contains provider
  object IDs and accounting evidence but no listener identity or destination.
  Checkout persists Stripe's current `integration_identifier` and continues
  to omit both `automatic_tax` and `payment_method_types`.
- GitHub and YouTube writes are dry-run by default. The only implemented
  YouTube exceptions are staging-only controlled clip and full-episode tests:
  Producer+ may prepare immutable evidence, but only a recently authenticated
  super-admin may approve; clips accept private/unlisted, episodes accept only
  unlisted in controlled mode, and production routes return `404`. The episode
  record additionally snapshots the exact publication revision, root job,
  completed MP4 upload ID, R2 key/bytes/ETag, and channel. The consumer requires
  launch-channel OAuth secrets. Before any controlled D1/Queue mutation,
  approval refreshes OAuth and requires the bounded authenticated `mine=true`
  channel list to contain the exact configured channel ID. The adapter
  repeats that check with the consumer's fresh access token before creating an
  upload session, hard-pins Google origins, disables redirects, bounds provider
  JSON, streams the conditionally read private R2 body, verifies returned
  channel/privacy, and fails closed if the mode is restored before consumption.
- Saved marketing links accept only bounded text and the show's existing
  credential-free HTTPS canonical URL. The Worker rebuilds every tagged URL
  through the exact shared Pool/Store normalizer instead of trusting the
  browser's derived value. Reads are keyset-bounded and private/no-store;
  writes are show-scoped, CSRF-protected, optimistic, and audited without
  returning admin-user IDs.
- Resend receives the raw destination only at send time. Delivery failures are
  logged by internal admin/listener ID, a closed local failure code, and the
  numeric provider HTTP status when available—never by email address,
  provider response body, exception text, or login URL.
- Resend calls have an eight-second timeout; login uses token-hash idempotency
  and announcements use durable delivery-ID idempotency. Redirects fail closed.
  Scheduled maintenance removes expired rate buckets, consumed login tokens,
  and revoked/expired sessions after a one-day diagnostic buffer.
- Secrets live only in `.dev.vars` or Cloudflare Worker secrets. Existing
  Cloudflare secrets cannot and should not be read back or copied by the
  application.
- Local and CI checks scan tracked text for high-confidence Stripe, Resend,
  GitHub, Google, and private-key credential forms without echoing matched
  values, and fail on high-severity dependency advisories. Processor workflows
  receive only the protected environment secret they reference; reusable jobs
  do not inherit the full caller secret set.
- The Worker records bounded structured application events while automatic
  invocation URL logs and automatic traces stay disabled. Private-feed bearer
  values are path-scoped, so URL-bearing telemetry must not be enabled until a
  redacting Tail Worker or token-free routing boundary passes its own security
  gate.
- Audience analytics never persists a raw IP address or user agent. It derives
  a purpose- and day-bound HMAC from an IPv4 address or IPv6 `/64`, user agent,
  episode, event type, and UTC date; uniqueness rows expire after 35 days and
  aggregate rollups after 400 days. App/device/country values use closed,
  non-identifying dimensions. Missing secrets, D1 failures, and Analytics
  Engine failures are best effort and cannot block media delivery.
- The public player event endpoint accepts only configured exact origins,
  bounded JSON, the closed `engaged_play`/`web_player_completion` events, and a
  public, due, ready-media episode. Completion allows only unique ascending
  25/50/75/100 milestones that cumulative foreground seconds can reach against
  the canonical duration. Raw second counts and playhead positions are not
  stored. Daily per-episode/per-milestone deduplication limits replay value.
  The dashboard and exports are show-scoped, credentialed, private/no-store,
  and contain no listener identifiers or HMAC keys.
- The ad-plan staging processor requires its own least-privilege R2-capable
  Cloudflare token. The clip processor deliberately receives no R2 credential:
  it uses purpose-bound signed source/output routes that stream through the
  Worker's private R2 binding. Both processors use the dedicated staging
  callback secret; Pool/Store deployment secrets are not copied or exposed.
- Forced alignment runs outside the public Worker in the pinned
  `alignment-runner` repository. The parent submodule pins the reviewed
  benchmark-bundle release, while the staging workflow accepts only the
  Worker's compile-time execution revision, verifies the expected GitHub
  remote, and performs a shallow exact-SHA detached checkout before installing
  an adapter. The runner accepts only checksummed, bounded local inputs,
  prevents path/model-reference traversal, rechecks audio after model
  execution, imports heavyweight libraries only inside selected adapters, and
  atomically refuses conflicting result writes. Raw transcripts and audio are
  not included in GitHub Actions or committed benchmark evidence.
- Alignment processing is staging-only and uses the existing purpose-bound
  media-processor HMAC secret. The GitHub job receives no Cloudflare/R2 token;
  signed routes expose only one exact private source and accept one bounded
  result. The workflow does not retain source audio, transcript projections,
  callback bodies, or raw results as artifacts.
- The Worker treats alignment output as untrusted. It revalidates exact
  source/transcript/projection/adapter/runner hashes, stable word identity and
  order, cue/source bounds, monotonic intervals, confidence, provenance,
  omissions, resource evidence, R2 native checksum metadata, and a 16 MiB
  result cap. Invalid intervals fail; interpolation and explained omissions
  remain review-only. Completion can produce only `needs_review`.
- Alignment approval requires exact current inputs, structural eligibility,
  and a clean passed bilingual benchmark matching every adapter/model/settings
  and runner identity. D1 triggers enforce the rule and require approval before
  `passed`, so there is no direct SQL or super-admin override. Transcript edits
  and working-master replacement stale or supersede dependent evidence.
- Alignment benchmark import requires a site-origin/CSRF-bound, recently
  authenticated Super-admin session. The Worker enforces a closed 8 MiB schema,
  exact pinned runner/adapter identities, bounded fixture/word/review/resource
  counts, and server-side evaluation. It writes canonical raw evidence only to
  private content-addressed R2, verifies native SHA-256 metadata, and exposes
  only report summaries. D1 stores the private object pointer and digests;
  audit rows omit corpus words, audio, and object keys. Submission/input
  uniqueness makes retries idempotent and changed reuse conflicting.

## Transcription boundary

Only a show-scoped Producer/Admin/Super-admin with a credentialed CSRF-bound
session can queue transcription. Every job snapshots the current approved
working-master ID, object ETag/size, source SHA-256, explicit English/Spanish
source language, model, vocabulary, and settings version. The Queue consumer
rechecks the master pointer, object identity, and byte digest before calling
Workers AI. A replacement master makes queued/running work stale.

Provider output is untrusted. The Worker bounds the raw response, keeps it
private in R2, strips control/bidirectional characters and active angle
brackets from normalized cue text, rejects missing/overlapping/out-of-duration
segments, and writes immutable digest-tagged JSON, WebVTT, SRT, and plain-text
objects. It does not import provider word timing or speaker identity. Transcript
application is optimistic against the snapshotted base revision, so a
concurrent editor wins and the completed provider result becomes stale rather
than overwriting reviewed text. Audit metadata contains only IDs, counts,
versions, and digests.

Direct transcription is limited to a 16 MiB source object because base64
encoding temporarily multiplies Worker memory. A larger approved master creates
one immutable chunk-run manifest instead of entering the provider path. In
isolated staging, the HMAC-authenticated GitHub workflow streams the exact
private source without an R2 credential, verifies its bytes/SHA-256/duration,
fully decodes it, detects bounded silence, and selects the closest safe cut
inside fixed duration windows. When no safe silence exists, the shared planner
uses a deterministic duration boundary. It encodes private, replaceable 16 kHz
mono 64 kbps MP3 transcription intermediates with only a 1.5-second overlap;
the approved master and public enclosure are never modified.

Every chunk upload signs its manifest digest, index, byte count, and SHA-256.
The Worker writes it to a deterministic private key, verifies R2's checksum
and metadata, then accepts a signed plan/report only after rebuilding the
shared contract and rechecking every stored object. Production processor
routes are `404`. GitHub evidence excludes source/chunk audio, provider
responses, transcript text, and credentials.

Workers AI consumes at most one verified chunk per Queue message. Each private
raw response has its own immutable digest so a retry reuses completed provider
work. Merge assigns each segment to one non-overlapping core window, clips only
at that window, and removes only a conservative exact token overlap at adjacent
chunk boundaries. It never fabricates words, speaker identity, or word timing.
The final transcript still requires review, and the separate English/Spanish
word-alignment quality gate remains locked.

## RSS migration preview, reviewed plan, and private-copy boundary

Only a recently authenticated super-admin with same-origin CSRF may preview an
existing show's source feed, and the request must explicitly confirm import
rights. The Worker accepts only public HTTPS hostnames without credentials,
fragments, IP literals, single-label hosts, or reserved/private suffixes. It
disables automatic redirects, independently validates at most two redirect
targets, forwards no authorization, uses a ten-second timeout, allows only XML
feed content types, and streams at most 5 MiB.

The parser rejects DTD/entity declarations, control bytes, invalid UTF-8, more
than 500 items, and malformed RSS structure. It reduces remote titles and
summaries to bounded plain text, revalidates every returned URL, hashes the
exact feed and each GUID/enclosure identity, previews at most 25 items, and
returns only an owner-email presence boolean. External HTML, an owner address,
raw episode GUID, cookies, response headers, and provider bodies never enter
the response, D1, audit metadata, or logs. The canonical source channel GUID is
the exception: the parser discovers one attribute-free lowercase UUIDv5 under
the declared Podcasting 2.0 namespace, and the private preview presents it
beside the destination show's stored identity. Missing is explicit; malformed
or duplicated identity is invalid. The preview performs no import-domain, R2,
directory, redirect, or provider mutation; the normal admin-session last-seen
heartbeat remains unchanged.

Preparing a migration plan is a second zero-copy boundary for recently
authenticated super-admins. It re-fetches the authorized feed and binds one to
25 migration-ready source identities to the exact feed digest and normalized
per-item metadata/enclosure digests. D1 retains hashes for the exact requested,
resolved, and enclosure URLs but only query/fragment-stripped display URLs, so
signed source tokens do not become plan or audit data. Item evidence and plan
identity/count/digest evidence cannot be updated or deleted. Only the
draft-to-reviewed or terminal canceled state may change. A valid source
channel GUID must exactly equal the destination show's already assigned GUID;
invalid, conflicting, or valid-but-unassigned identity fails closed. The plan
freezes the exact source GUID, or explicit absence, and a trigger prevents it
from changing. No import route silently derives, assigns, or replaces show
identity.

An unassigned future show may adopt a previewed source channel GUID only
through a separate recent-super-admin and same-origin-CSRF action. It requires
the exact authorized feed URL, preview feed digest, UUIDv5, rights
confirmation, and a second irreversible-action confirmation. Before any
source fetch the destination must still be an empty `coming_soon` show without
episodes or import plans. After re-fetch, changed, absent, malformed, reused,
or conflicting identity fails closed.

The conditional show update, immutable provenance insert, and hash-minimized
audit insert execute in one D1 batch. Provenance retains SHA-256 values for the
exact requested/resolved URLs and only query/fragment-free display URLs. It
cannot be updated or deleted, and the assigned show GUID is already protected
by the one-way show trigger. The response explicitly reports zero episode,
import, and publication mutations; the route has no R2, Queue, redirect,
directory, provider, YouTube, email, advertising, or billing path.

Review requires the exact feed URL to be supplied again, explicit rights and
selection confirmation, recent authentication, CSRF, and a fresh source
fetch. A changed redirect target, feed byte, selected identity, or metadata
digest fails closed. The source-versus-show channel identity and frozen plan
value are reconciled again before review and execution. Cancellation stores
and audits only a purpose-bound
reason digest. List responses are private/no-store and show-scoped; mutating
routes remain super-admin-only. The APIs explicitly return zero-copy and
zero-episode-mutation flags and have no R2, Queue, provider, redirect, or
episode write path.

Execution is a distinct staging-only capability. Production commits
`RSS_IMPORT_EXECUTION_MODE=disabled`; staging additionally requires
`staging_copy`, a dedicated AES-GCM `RSS_IMPORT_URL_SECRET`, recent
Super-admin authentication, CSRF, an exact complete slug/language mapping, and
another full feed reconciliation. The source URL is sealed with an
execution-specific purpose and additional-data context, retained for at most
seven days, and never copied into Queue payloads, audit metadata, logs, or API
responses. Execution identity, plan/show/feed/selection digests, target
episode identity, source identity, and target object key are immutable and
undeletable. Once execution exists, a D1 trigger prevents plan cancellation.

Every item re-opens the sealed URL, verifies its hash, reconciles the reviewed
source metadata, validates at most two manual HTTPS audio redirects, and
enforces exact MIME and byte evidence with a 1 GiB ceiling. The response body
is counted while it is streamed to private R2 and a SHA-256 `DigestStream`;
remote audio is never buffered in Worker memory. Only after R2 size evidence
matches does one D1 batch create a `draft`/`processing` episode, stable
source-identity GUID, and completed private source-upload record. Failures
delete the deterministic private object where possible, record only a stable
code, and remain eligible for no more than five attempts. Success erases the
source URL as soon as all items finish.

This capability never sets delivery audio, publishes News/RSS, configures a
redirect/directory, creates YouTube/email/ad/billing work, or contacts a
provider other than the explicitly authorized source host.

Owner reconciliation is a distinct staging-only evidence gate. It recomputes
one fixed-schema digest from execution/item evidence, the exact unpublished
draft identity and canonical News URL, completed source-upload evidence, and
private R2 `HEAD` metadata. R2 checks have a five-request concurrency ceiling;
source URLs and private object keys stay out of responses. Any missing or
mismatched object, draft/upload identity drift, assigned delivery audio,
publication revision, or queued publication/distribution work blocks
approval. A recent Super-admin must submit the exact digest and explicit
confirmation; D1 rechecks all database predicates in the conditional insert.
The immutable approval then prevents execution/item edits.

Approval performs no R2, episode, publication, redirect, provider, email, ad,
or billing mutation. Production fails closed before D1 or R2. The returned
old-host checklist cannot activate a redirect and is always blocked on a
separate owner attestation. That staging-only attestation requires exact
old-feed re-entry, the current copy digest, recent Super-admin authentication,
CSRF, three explicit confirmations, and one of two permanent redirect methods.
It retains only purpose-bound old/new URL hashes and immutable evidence; no
credential, signed URL, or provider payload is stored, and no host is
contacted. Public imported episodes, canonical-feed validation after their
latest update, and renewed 10-directory certification are also mandatory.
Working-master approval, publication, and old-host 301 activation remain
separate gates.

The immutable cutover packet makes those later checks exact without widening
authority. It requires every imported current revision to be publicly due
with ready delivery audio and successful RSS plus canonical-News/site work;
the exact canonical feed must then validate; ten enabled destinations must
retain owner, ingestion, and failed-to-observed recovery evidence; and those
ten must be observed again after that feed validation. The existing
owner-control attestation and private-copy reconciliation must still match.
The packet stores hashes, counts, evidence versions, and timestamps only.
Show/episode evidence-version predicates guard its conditional insert, all
rows are append-only, and a later evidence change makes the prior packet
stale. Production returns unavailable before D1/R2, and neither preview nor
creation contacts a host, mutates publication, changes DNS, or activates a
new-feed tag or HTTP 301.

Final redirect authorization is a separate recent-Super-admin,
same-origin-CSRF boundary and is also staging-only. It accepts only the exact
fresh cutover packet and evidence digest plus explicit final-review,
manual-action, rollback-plan, and zero-activation confirmations. D1 rechecks
the packet, attestation, old/new feed hashes, redirect method, and current
show/episode evidence versions in the conditional insert. One approval exists
per packet; rows and their cross-evidence links cannot be updated or deleted.

The response distinguishes a fresh manual-owner handoff from runtime
activation. `activationAvailable` remains false, and approval cannot contact
the old host, change DNS, configure a provider, emit a new-feed tag or HTTP
301, or mutate R2, episodes, publication, directories, email, advertising, or
billing. A later evidence change makes both the packet and approval stale.

## Before production

- Re-run the private-feed threat model and rotation drill alongside real-time
  ad decisions, webhook replays, Pool redemption codes, checkout recovery, and
  transcript/clip file access.
- Verify deployed login, checkout, Portal, and exchange caps and add equivalent
  limits for uploads, publication, and provider callbacks before activation.
- Extend recent-auth requirements from the protected super-admin lifecycle to
  future destructive or live billing-provider mutations.
- Validate logs contain no tokens, raw emails, Stripe payload bodies, media
  source URLs, transcript content, or benchmark corpus words.
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

## AI show-notes boundary

Show-note generation is an authenticated Producer+ review aid, not a content
mutation. It requires trusted-origin CSRF, an exact verified approved
English/Spanish transcript, and the environment kill switch. The same public
projection verifier rejects missing approvals, unconfirmed speaker names,
oversized content, non-canonical serialization, and digest mismatch before the
transcript can enter a prompt.

Episode and transcript text is explicitly marked as untrusted evidence in the
model instructions. Input is bounded to 48,000 characters on cue boundaries;
long transcripts report partial head/middle/tail coverage. JSON schema mode is
not trusted: the Worker reparses and bounds every field, rejects active HTML,
control and bidi-override characters, deduplicates keywords, and returns a
stable private error on any provider or validation failure. The browser again
validates the response contract and uses only `textContent` until an explicit
replace action passes Markdown through the shared sanitized WYSIWYG.

The existing audit table enforces six requests per admin/episode/hour using
content-free metadata. Audits retain transcript and output digests, revision,
cue counts, language, model, usage, and error class only—never transcript,
prompt, provider response, or draft text. The result is not stored server-side
and cannot save an episode, publish News/RSS/YouTube, contact a directory, or
change media, billing, ads, or subscriber state. Staging is enabled for
controlled tests; production is disabled until a separate promotion review.

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

The same immutable approval projects a bounded speaker-aware WebVTT document
for each approved language and its Podcasting 2.0 RSS discovery tag. Public
VTT keeps the JSON visibility, checksum, cache, CORS, noindex, nosniff, and
conditional-request boundaries. Private VTT HMACs the bearer before D1,
rechecks active unexpired show entitlement and release eligibility on every
request, uses tokenized RSS URLs, and is private/no-store without wildcard
CORS. Neither projection logs or returns the raw bearer, internal cue IDs,
editor markup, revision metadata, or word-alignment rows. Launch/cutover
evidence accepts only the current `dustwave-rss-launch-v3` validator contract,
so a previously valid v1 result becomes visibly stale and cannot certify
publication. RSS discovery does not trust approval metadata alone: public and
private feeds reuse the projection parser, speaker-confirmation checks, and
SHA-256 verification before emitting a transcript tag. Oversized or invalid
rows fail closed, and database reads are byte-capped and processed in bounded
episode batches.

The validation row fingerprints one exact public RSS body. D1 removes it when
a show/channel field, public-feed episode field, transcript approval, or
chapter approval can change that projection; the existing deletion trigger
also advances the publication evidence version. Private notes and unapproved
transcript/chapter drafts do not expire the row. Launch and cutover therefore
return to a visible pending state until the canonical feed is validated again.
The manual recovery action is show-scoped to Producer/Admin/Super-admin,
requires trusted origin and CSRF, performs no directory/provider request, and
audits only result, validator version, item count, or stable failure code.

## Show-settings boundary

The show-settings mutation is limited to a show-scoped Admin or Super-admin,
requires credentialed allowlisted origin plus the current CSRF token, and
audits field names rather than submitted values. Browser URL constraints are
only a usability layer: the Worker independently requires artwork to be
credential-free, port-free, fragment-free HTTPS and accepts a channel
destination only when it is a query-free canonical channel path on
`youtube.com`, `www.youtube.com`, or `m.youtube.com`. Empty optional
destinations become SQL `NULL`; invalid metadata cannot reach the update.
Canonical page, feed hostname, feed slug, and Podcasting 2.0 channel identity
are not accepted by this mutation.

## Show-site projection boundary

The show page remains statically rendered for performance and SEO, while D1
is authoritative for operational show metadata. An Admin may preview drift
against the exact configured repository/ref; preview is read-only, bounded to
one two-megabyte GitHub Contents response, rejects redirects, and times out.
Only title, bilingual descriptions, language, lifecycle, canonical/feed
artwork/YouTube destinations, author, category, explicit policy, active USD
prices, premium/free-mini flags, and the early-access default are projected.
Local responsive artwork, wordmark, social card, source link, benefit copy,
episode overrides, and episode fallback remain site-owned and are preserved.

Publishing requires a show-scoped Super-admin session, CSRF, authentication
within 15 minutes, the exact reviewed Git blob SHA, and the typed
`PUBLISH_SHOW_CATALOG {show-id}` confirmation. Missing local presentation
assets or either active USD premium price blocks publication. A fresh read is
performed before every attempt, SHA conflicts return `409`, submitted content
is never accepted from the browser, and GitHub write auth is mandatory.
`GITHUB_PUBLISH_MODE` remains fail-closed as `dry_run` unless explicitly set
to `live`; audit metadata records only SHAs and changed field names.

## Premium-price configuration boundary

Monthly and annual USD configuration is separate from ordinary show settings.
Readiness is Super-admin-only, and mutation additionally requires
authentication within the last 15 minutes, same-origin CSRF, the exact current pair, the typed
`CONFIGURE_SHOW_PRICES {show-id}` confirmation, and an annual discount. Both
rows change in one conditional D1 statement and the audit insert is conditional
on both rows changing; a stale value changes neither row.

This is a pre-launch configuration boundary, not a Stripe provisioning
boundary. It fails closed while the checkout kill switch is on or after any
subscription or checkout-attempt history exists. A changed amount clears only
that row's now-stale Stripe Price identifier, leaves the provider untouched,
and makes checkout readiness fail until a separate reviewed provider step
binds a matching immutable Stripe Price. Responses expose amounts, readiness,
counts, and stable blocker codes but never provider identifiers or secrets.

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
excludes wall-clock time. Missing, incomplete, stale, failed, or
safety-truncated evidence is never promoted to ready.

Publish recognizes `legacy`, `shadow`, and `enforce`, with unknown values
falling back to legacy. Staging observes exact digest/revision matches in
shadow without changing the legacy readiness decision; production remains
legacy. Enforcement rejects missing or stale snapshots and unresolved
candidate blockers. Its override is limited to a show-scoped Admin or
Super-admin authenticated within 15 minutes, requires explicit confirmation,
and stores a normalized private reason separately. General audit metadata
contains only the reason hash/length, counts, IDs, and evidence versions.

Monotonic episode, show, and global epochs cover every readiness dependency.
The snapshot double-reads them to avoid torn evidence, and the final episode
update compares all three. Its immediately following checked `changes()` guard
aborts the entire D1 batch on conflict, preventing partial jobs, directory
state, News publication, override, or audit writes. Show/global epochs avoid
O(all historical episodes) invalidation when show or directory setup changes.
Revision advancement also fails closed while an older root publication job is
`running`; retryable older jobs are canceled by the same D1 transaction that
advances the episode. Queue processing revalidates the durable revision, show,
and destination-derived job type before a claim, and terminal writes require
continued ownership of `running` state. A stale or mismatched message therefore
cannot publish a newer episode through an older root job.

## Publication-intent and News-teaser boundary

Publish, readiness, and tests use one pure planner for root applicability.
Every episode plans RSS and News. YouTube exists only for a video-bearing
non-premium-bonus episode, so inapplicable jobs are absent rather than
immediately succeeding as dry-run placeholders.

The GitHub publication document is a versioned discriminated union. A
`premium_teaser` is constructed from a positive allowlist of public fields and
has no media-shaped optional branch: audio/enclosure/download URLs, byte/MIME
metadata, duration, transcript/chapter endpoints, private tokens, and premium
timing are structurally absent. The website validator rejects unsupported
versions, unknown modes, and any forbidden teaser field before building.
Canonical/show/embed templates branch on `pageMode`; teaser rendering does not
instantiate the shared player or load its scripts, transcript/chapter clients,
or media/connect CSP origins. Dynamic text remains autoescaped, and podcast
JSON-LD uses a shared serializer that escapes HTML-significant characters
before the JSON is placed in a script element.

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
preserve historical evidence but cannot change the current clip.

Public clip selection remains separate from render readiness. Producer+ may
prepare one current render, but only a recently authenticated super-admin may
approve or terminally withdraw it. The approval snapshots exact D1 and R2
identity and repeats the current revision/object checks. Public metadata and
range delivery require an enabled environment mode plus a published, due,
public-eligible, ready-media episode; stale, premium-only, future, withdrawn,
disabled, and tampered records are concealed as the same no-store `404`.
Responses never reveal the private key or evidence digests. Media uses the
same conditional-R2 transport and exact checksum/manifest checks as Admin,
wildcard read-only CORS, one-minute revalidation, a canonical News-page link,
and noindex. Production keeps the mode disabled.

## Source-audio QC boundary

Source-audio QC reuses the clip processor's dedicated staging HMAC secret but
uses separate purpose-bound request bodies and routes. Signature, timestamp,
content type, declared size, and actual body size are checked before D1.
Production exposes none of the manifest, source, or completion routes.

An authenticated Producer queues only the episode's current completed
`source_audio` upload. Before D1 mutation, the Worker checks private R2 bytes,
ETag, and MIME against the upload record. The immutable manifest includes the
source snapshot, show-policy revision, fixed callback path, and SHA-256. The
processor receives audio only through an ETag-conditional no-store Worker
stream and never receives R2 credentials.

The shared media contract validates all measurements and deterministically
recomputes findings. The callback cannot lower warning/blocker totals, change
the snapshotted policy, or substitute a source. Success re-heads R2 before
committing. Stored reports are bounded to 250 KB; failure uses a fixed code,
not free-form processor output. Audit metadata contains IDs, counts, sizes,
policy/manifest/report/source hashes, and duration, but no object key, filename,
raw FFmpeg log, or audio.

The pinned QC processor uses argument arrays rather than a shell, bounds
process output and runtime, fully decodes the source, and retains only the
non-secret callback report as a 30-day GitHub artifact. It cannot write R2,
approve a working master, change delivery audio, or publish.

## Working-master and enhancement-preview boundary

Working-master approval requires a current CSRF token and Super-admin role.
The Worker re-heads R2 and D1 atomically rechecks the expected state revision,
current completed upload, source object/ETag/bytes, zero-blocker successful QC,
and current policy revision. Approval audit metadata contains only IDs,
revisions, hashes, origin kind, and whether prior derived approvals were made
stale. It excludes object keys and free-form approval text.

Master state points to one immutable episode-scoped approval row. A D1 trigger
rejects a cross-episode or wrong-revision pointer. On replacement, triggers
preserve authored transcript/chapter/clip data and immutable history but clear
current transcript/chapter approvals, return clips to draft, and advance the
publication evidence epoch. Production review and publication readiness read
only the exact current pointer.

Enhancement recipes are validated by a shared allowlist; no request can supply
an FFmpeg expression. Manifest/source/output/completion requests have distinct
purpose-bound payloads. Output uploads authenticate a base64url descriptor
before D1, require an exact `Content-Length` and `audio/mpeg`, stream through
the Worker R2 binding, and require native SHA-256 plus manifest/kind metadata.
Completion re-heads source and both outputs before transition to ready.

Private preview playback is role- and show-scoped, credentialed, byte-range
safe, `no-store`, `noindex`, and checksum-verified before streaming. The
workflow retains only callback and upload-response evidence for 30 days; audio
files remain only in private staging R2. Preview state is explicitly
ineligible for master approval or publication.

Full-length derivative queueing additionally binds the selected ready preview
to the exact current master and its successful source-QC report. Production
does not expose its queue or processor routes. The staging processor receives
no R2 credentials; every 32 MiB part carries a purpose-bound signature,
declared length, and SHA-256, and the Worker stores the returned multipart
ETag before accepting the complete ordered set. Completion re-heads the
private object, checks native R2 checksum/metadata and the shared full-decode
report, then registers a deterministic private media/QC candidate. GitHub
retains only content-free IDs, sizes, and digests after the manifest, source,
render, and callback files are removed.

Derivative promotion is a separate CSRF-protected Super-admin operation. D1
requires the derivative output to have a successful zero-blocker QC report
under the current policy and to still descend from the current master. The
Worker also re-heads R2, and the expected master revision is compared before
one atomic batch creates the immutable replacement, advances the pointer, and
writes conditional audit evidence. Neither free-form approval text nor object
keys enter audit metadata.

## Delivery-audio and player-peaks boundary

Delivery rendering is absent outside staging and accepts only the exact current
working master. Its shared contract fixes codec, sample rate, channel count,
bitrate, metadata policy, full-decode evidence, complete MPEG frame accounting,
and a bounded waveform schema; callers cannot provide FFmpeg filters or output
locations. A master change makes queued, rendering, completing, and ready jobs
stale. Replacing episode audio makes the old approval historical.

The processor receives no R2 credential. Manifest/source/part/finalization
requests use purpose-bound timestamped HMACs, bounded bodies, exact
Content-Length, per-part SHA-256, ordered multipart evidence, native R2
checksums, and fixed object metadata. The shared client rejects any endpoint
outside the pinned staging Worker origin. Private source, MP3, waveform,
manifest, and callback files are removed before GitHub retains a 30-day
content-free evidence artifact.

Authenticated admin media is show-scoped, credentialed, range-safe where
applicable, `no-store`, `noindex`, and served only from ready/approved jobs.
Approval requires fresh Super-admin authentication and re-heads both R2
objects before an atomic episode/job/audit mutation. D1 triggers repeat the
current-master, complete-evidence, and exact-selected-audio checks if
application code is bypassed. The public peaks route is available only for a
published, due full episode whose enclosure still matches that approved job;
premium-only, stale, draft, and future states all return the same `404`.
Publication readiness, direct Publish, and asynchronous GitHub News projection
each enforce the exact approved/current binding independently.

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

The full-episode test stores one publication per episode revision and pins the
matching root job plus completed MP4 upload evidence. Normal cron recovery
explicitly excludes running YouTube jobs. A Worker interruption or ambiguous
provider result is quarantined as `reconciliation_required`; approval and
generic retry cannot replay it. A committed provider ID is reused without R2
or Google access if the surrounding root-job state later needs repair.
Reconciliation requires recent Super-admin authentication and an exact
confirmation. Recording an upload calls Google again and accepts the provider
ID only if channel and unlisted privacy match; recording no remaining video
requires an explicit owner attestation and creates an audit event before the
attempt can be approved again.
Episode uploads are capped at 2 GiB and 13 minutes for this initial controlled
gate, while production and `live` publishing remain disabled.
