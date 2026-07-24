# HTTP API

All bodies are JSON unless noted. Public routes may be called without a
session. Admin routes use an HttpOnly cookie scoped to `/v1/admin`; mutating
routes also require the `x-podcast-csrf` value returned at login exchange.

## Public

| Method | Path | Purpose |
|---|---|---|
| `GET`, `HEAD` | `/health` | Runtime and environment health |
| `GET`, `HEAD` | `/v1/shows` | Non-archived shows, including coming-soon shows |
| `GET`, `HEAD` | `/v1/shows/{slug}` | Show, configured prices, and public episodes |
| `GET`, `HEAD` | `/{rss-slug}/rss.xml` | Canonical public RSS |
| `GET`, `HEAD` | `/v1/feeds/{rss-slug}/rss.xml` | RSS alias for staging and diagnostics |
| `GET`, `HEAD` | `/episodes/{episode-id}/audio` | Public R2-backed audio with byte ranges |
| `GET`, `HEAD` | `/v1/media/{episode-id}` | Media alias for staging and diagnostics |
| `POST` | `/v1/webhooks/stripe` | Signed Stripe event intake |
| `POST` | `/v1/shows/{slug}/tax/quote` | Rate-limited, no-store manual subscription-tax estimate |

Append `?download=1` to the episode media URL for attachment disposition.
Public audio is available only when the episode is published, due, eligible
for public access, and backed by ready delivery media.

Subscription tax quotes accept a configured `priceId` and a billing
`destination`. The Worker normalizes the destination with the same shared
primitive used by Store, selects the most specific assigned
accountant-approved rate version, and returns integer-cent exclusive or
inclusive math. It never returns the Stripe Tax Rate ID, stores the address, or
enables checkout. A missing assignment or provider mapping fails closed.

## Passwordless admin authentication

1. `POST /v1/admin/auth/start` with `email`, `preferredLanguage`, and a
   Turnstile token. The response is deliberately the same for known and unknown
   addresses.
2. Resend sends a link to `/admin/podcasts/#magic-link={token}`.
3. The browser sends the fragment token to
   `POST /v1/admin/auth/exchange`.
4. The response sets the HttpOnly session cookie and returns a CSRF token for
   in-memory use.
5. `GET /v1/admin/session` restores non-secret identity and role scope.
6. `POST /v1/admin/logout` revokes the session.

Login tokens expire after 15 minutes and are single-use. Sessions expire after
8 hours. Raw administrator email addresses are not stored in Podcast D1.

### Super-admin lifecycle

All lifecycle mutations require a `super_admin` session, same-origin CSRF, and
authentication within the preceding 15 minutes. Responses never expose an
email address or lookup HMAC.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/admin/users` | List up to 100 admin identities and scoped roles |
| `POST` | `/v1/admin/users` | Invite an email lookup with one initial role |
| `PATCH` | `/v1/admin/users/{id}` | Move an identity to invited, suspended, or revoked |
| `POST` | `/v1/admin/users/{id}/roles` | Idempotently grant a global or show-scoped role |
| `DELETE` | `/v1/admin/users/{id}/roles/{role}?showId={id}` | Idempotently revoke a role |

Invited administrators use the standard Turnstile-protected magic-link form.
Once an environment has two active super-admins, D1 triggers prevent a status
change, user deletion, or role deletion from reducing that count below two,
including under concurrent requests.

## Admin

| Method | Path | Roles | Purpose |
|---|---|---|---|
| `GET` | `/v1/admin/shows` | analyst+ | Show overview |
| `PATCH` | `/v1/admin/shows/{id}` | admin+ | Editable show metadata |
| `GET` | `/v1/admin/shows/{id}/episodes` | analyst+ | Draft, scheduled, and published episode workbench rows |
| `POST` | `/v1/admin/shows/{id}/episodes` | producer+ | Create a draft episode |
| `PATCH` | `/v1/admin/episodes/{id}` | producer+ | Edit episode metadata |
| `POST` | `/v1/admin/episodes/{id}/publish` | producer+ | Idempotent one-click publish/schedule |
| `GET` | `/v1/admin/distribution` | analyst+ | Directory registry |
| `GET` | `/v1/admin/episodes/{id}/distribution` | analyst+ | Per-episode destination state |
| `POST` | `/v1/admin/uploads` | producer+ | Start R2 multipart upload |
| `PUT` | `/v1/admin/uploads/{id}/parts/{n}` | producer+ | Stream one upload part |
| `POST` | `/v1/admin/uploads/{id}/complete` | producer+ | Verify and complete upload |
| `DELETE` | `/v1/admin/uploads/{id}` | producer+ | Abort an incomplete upload |
| `GET` | `/v1/admin/billing/readiness` | super-admin | Non-secret provider/tax readiness |
| `POST` | `/v1/admin/ads/preview` | analyst+ | Read-only sponsor decision preview |
| `GET` | `/v1/admin/ads/campaigns?showId={id}` | analyst+ | Show-scoped campaign/readiness list |
| `POST` | `/v1/admin/ads/campaigns` | admin+ | Create an audited draft campaign and target |
| `PATCH` | `/v1/admin/ads/campaigns/{id}` | admin+ | Edit metadata and reset approval |
| `POST` | `/v1/admin/ads/campaigns/{id}/creatives` | producer+ | Create pending MP3 creative metadata |
| `PUT` | `/v1/admin/ads/creatives/{id}/audio` | producer+ | Stream one bounded creative MP3 to private R2 |
| `POST` | `/v1/admin/ads/creatives/{id}/validate` | producer+ | Validate exact frame/profile/duration/size and hash |
| `GET` | `/v1/admin/episodes/{id}/ad-plan` | analyst+ | Latest processor/review state and approved marker/segment state |
| `POST` | `/v1/admin/episodes/{id}/ad-plan` | producer+ | Submit versioned pre/mid/post marker intent against immutable source audio |
| `POST` | `/v1/admin/ads/plans/{id}/approve` | producer+ | Atomically approve processor evidence as active markers/segments |
| `POST` | `/v1/admin/ads/plans/{id}/reject` | producer+ | Reject pending processor evidence with an audited reason |
| `POST` | `/v1/admin/ads/decisions/issue` | producer+ | Isolated-staging immutable decision exercise; never the public enclosure |
| `GET` | `/v1/admin/ads/reconciliation?showId={id}` | analyst+ | Bounded, paginated campaign-counter versus durable-qualification report |
| `POST` | `/v1/admin/ads/campaigns/{id}/approve` | admin+ | Approve only complete, validated inventory |
| `POST` | `/v1/admin/ads/campaigns/{id}/kill` | admin+ | Immediately and idempotently revoke a campaign |

The publish operation hashes all publication-relevant episode state. Repeating
the request without a change returns the existing revision. A changed episode
creates one new revision, stable idempotency keys, one site publication, and
one status record per configured directory.

Multipart clients should use 32 MiB parts; the API currently caps each request
at 100 MiB and each logical media object at 20 GiB. Parts are streamed to R2 and
never buffered as one Worker request.

### Sponsor decision preview

`POST /v1/admin/ads/preview` also requires the current CSRF token. Its JSON
body is:

```json
{
  "episodeId": "episode_example",
  "position": "mid",
  "deviceType": "mobile",
  "appName": "apple_podcasts",
  "streamProfile": "mp3-44100-stereo-cbr128-frame-v1",
  "at": "2026-07-24T12:00:00.000Z"
}
```

The response evaluates current D1 campaign/rule/creative rows without creating
a decision, incrementing a counter, or changing public delivery. It reports
feature flags, approved-marker and program-segment readiness, an inventory
fingerprint, the proposed selection or full-file fallback, and explicit
activation blockers. `runtime_not_connected` remains present until the signed
manifest, qualification, virtual-audio, privacy, and real-client gates pass.

Campaign creation requires an explicit show, date window, campaign type, and
one initial targeting rule. Direct campaigns also require an active sponsor;
house campaigns cannot carry sponsor billing metadata. New and edited
campaigns are drafts. Approval fails closed until there is an active show rule,
active sponsor when applicable, and active creative whose validated byte,
MIME, and exact stream-profile metadata is ready. The kill endpoint is
irreversible for that campaign row; operators create a new campaign rather
than silently resurrecting revoked inventory. Every mutation writes an admin
audit event, while approval still cannot affect playback until the separate
runtime and show/episode feature gates pass.

Creative audio is a separate, bounded streaming workflow rather than a copy of
the episode multipart uploader. Create metadata first, then send an
`audio/mpeg` body of at most 25 MiB with the exact byte count in
`x-podcast-upload-bytes`, and call the returned validation route. Validation
parses every MPEG frame, permits bounded ID3 metadata outside the frames,
requires MPEG-1 Layer III at 128 kbps/44.1 kHz/stereo, verifies complete frame
boundaries and object size, checks declared versus measured duration, and
records a SHA-256 digest and review evidence. Creating, replacing, or
revalidating audio returns the campaign to draft. Upload and validation
failures remain non-ready and are audited.

### Episode ad plans and processor evidence

Submitting an episode ad plan records 1–3 unique pre/mid/post positions against
the exact ready delivery MP3 key, byte size, ETag, and reviewed duration. It
does not edit the currently approved marker/segment rows. The response includes
a non-secret `processorManifest` for the isolated staging workflow.

The `Process staging Podcast ad plan` GitHub workflow downloads the private
source through authenticated Wrangler, normalizes it once to the launch MP3
profile, splits that normalized stream only on complete MPEG frame boundaries,
uploads full private program objects under the plan-specific R2 prefix, and
submits its evidence to
`POST /v1/processor/ad-plans/{id}/complete`. That internal callback is not a
browser API: it requires a five-minute timestamp and HMAC-SHA256 signature over
the exact request body. The Worker checks immutable source evidence, contiguous
sequence, object prefix, exact R2 sizes, frame-derived duration, 128 kbps frame
byte bounds, the mid-roll boundary, whole-episode duration, and per-segment
SHA-256 before changing the plan to `needs_review`.

A Producer/Admin/Super-admin must then approve. Approval rechecks the manifest
digest, source identity, and current R2 objects and replaces active
marker/segment rows in one D1 batch. It does not set either dynamic-ad feature
flag, create a decision, change the public file, or count an impression.

### Signed staging decisions

With `AD_DECISION_MODE=staging_validate` and a staging-only signing secret, an
authenticated Producer/Admin/Super-admin may issue a deterministic decision
exercise. It requires a published revision, current approved marker/program
plan, complete validated creative snapshots for every marker, one exact stream
profile, and matching private R2 sizes/ETags. The response contains an expiring
`GET|HEAD /v1/ads/decisions/{id}/audio` URL whose HMAC covers the decision ID,
expiry, and manifest SHA-256. Signature validation occurs before D1 lookup.
During a planned key rotation, issuance uses `AD_DECISION_SIGNING_SECRET` while
validation also accepts `AD_DECISION_SIGNING_SECRET_PREVIOUS`; remove the
previous value only after the two-hour maximum decision lifetime.

The signed route reloads and hashes the stored manifest and preflights every
private object size/ETag before response headers, then uses the existing
bounded virtual range streamer. It is available only on isolated staging.
Production sets the mode to `disabled`; the permanent episode enclosure never
calls this route and both dynamic-ad feature flags remain false.

Every newly issued staging decision also selects a deterministic house
fallback for each slot. A house creative is eligible only when its validated
byte count, duration, MIME type, and stream profile exactly match the selected
sponsor creative. The decision snapshots those fallback campaign, creative,
hash, duration, object-key, size, ETag, and profile fields. When every slot is
covered, the fallback manifest reuses the same program segments with the
matching house creatives and reports `fallbackType: "house_fill"`.

If any slot lacks an exact house rendition, the staging decision instead
snapshots one validated `fallbackType: "full_file"` manifest from the current
immutable delivery-audio key, size, and ETag. The signed manifest records a
derived `equal-byte-length-v1` contract containing primary bytes, fallback
bytes, and their equality result. The Worker recomputes that contract before
presenting or serving a decision, so a missing or altered declaration fails
closed. An unequal full-file diagnostic reports
`deliveryLengthReady: false`; production activation requires complete
same-length house/filler coverage plus every other documented launch gate.

On the signed URL's first `GET` or `HEAD`, the Worker preflights the primary
virtual manifest. If primary evidence is unavailable, it preflights the
fallback and atomically commits exactly one `primary` or `fallback` delivery
variant in D1 before emitting headers. Concurrent first requests use the
committed winner. Later range/retry requests may never switch variants; if the
committed objects change, the route fails closed instead of returning
different bytes under one signed URL. This staging safety path does not attach
the permanent enclosure or enable either dynamic-ad feature flag.

### Trusted staging qualification and reconciliation

`POST /v1/internal/ad-qualifications` is a server-to-server staging contract,
not a browser telemetry route. It requires
`AD_QUALIFICATION_CALLBACK_SECRET`, `application/json`, a five-minute
`x-podcast-qualification-timestamp`, and
`x-podcast-qualification-signature` containing HMAC-SHA256 over
`{timestamp}.{exact raw body}`. Signature validation and the 20 KB body bound
run before D1. The body contains only `decisionId`, `decisionSlotId`, and
`creativeBytesServed`; it does not accept an IP address, user agent, listener
identity, or caller-supplied qualification time.

The callback counts at most one completed delivery per immutable decision
slot, only while its qualification window is open and only after the
snapshotted creative byte threshold is met. D1 triggers enforce the campaign
hard cap and counter increment atomically. Retries resolve by immutable slot
identity, so callback-secret rotation cannot duplicate or strand an already
recorded qualification.

The admin reconciliation endpoint defaults to 50 campaigns, caps each page at
100, and uses a campaign cursor. It is show- and role-scoped, reports its
`trusted-download-v1` methodology, and compares trigger-maintained counters
with durable qualification rows. Supporting indexes cover show targeting,
created-time pagination, and campaign qualification history.

## Provider modes

`GITHUB_PUBLISH_MODE` and `YOUTUBE_PUBLISH_MODE` default to `dry_run`. A dry-run
publication exercises state transitions without an external write. The
Podcast checkout endpoint is not exposed until member authentication and
accountant-approved manual tax configuration pass their launch gates.
