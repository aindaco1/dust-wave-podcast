# Security and privacy boundaries

## Authentication and authorization

- Administrator login is passwordless and enumeration-resistant.
- D1 stores an HMAC lookup value instead of a raw email address.
- Login and session secrets are one-way hashes at rest; login tokens are
  single-use.
- The session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, and path-scoped.
- Mutations require a same-origin check and a session-bound CSRF token.
- Roles are `super_admin`, `admin`, `producer`, and `analyst`, with optional
  show scope. Multiple super-admins are supported.
- Super-admin management must preserve at least two active super-admins before
  production. That management API is not yet exposed.
- Every implemented content, media, and publication mutation emits a D1 audit
  event without credentials or raw email addresses.
- Sponsor campaign creation, edits, approval, and the kill switch are
  show-scoped admin mutations with CSRF/origin enforcement and audit events.
  Edits reset approval; direct campaigns require an active sponsor; revoked
  rows cannot be silently reactivated.

## Storage and delivery

- R2 buckets remain private. The Worker mediates public and future premium
  access so object URLs cannot bypass entitlement or ad policy.
- Public media is served only for a due, public-eligible, ready episode.
- Byte ranges are validated and bounded; upload kinds, MIME types, object
  sizes, filenames, and part numbers are allowlisted.
- CORS reflects only explicit origins. Admin responses are private/no-store and
  marked noindex.

## Provider boundaries

- Stripe webhooks require a valid signature and matching test/live mode before
  D1 is touched. Event IDs are journaled once.
- Stripe product and price identifiers are configuration, not credentials.
  Checkout stays disabled until listener identity and approved tax rules exist.
- GitHub and YouTube writes are dry-run by default. Live mode requires
  least-privilege provider credentials and an audited environment change.
- Resend receives the raw destination only at send time. Delivery failures are
  logged by internal admin ID, never by email address.
- Secrets live only in `.dev.vars` or Cloudflare Worker secrets. Existing
  Cloudflare secrets cannot and should not be read back or copied by the
  application.

## Before production

- Threat-model private feed tokens, real-time ad decisions, webhook replays,
  Pool redemption codes, checkout recovery, and transcript/clip file access.
- Add rate limits for login, exchange, uploads, publication, and provider
  callbacks.
- Add super-admin lifecycle endpoints with two-admin protection and recent-auth
  requirements for destructive or live-provider actions.
- Validate logs contain no tokens, raw emails, Stripe payload bodies, media
  source URLs, or transcript content.
- Complete backup/restore, queue replay, secret rotation, incident response,
  and provider revocation drills.
