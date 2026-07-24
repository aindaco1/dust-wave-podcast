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

Append `?download=1` to the episode media URL for attachment disposition.
Public audio is available only when the episode is published, due, eligible
for public access, and backed by ready delivery media.

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

## Provider modes

`GITHUB_PUBLISH_MODE` and `YOUTUBE_PUBLISH_MODE` default to `dry_run`. A dry-run
publication exercises state transitions without an external write. The
Podcast checkout endpoint is not exposed until member authentication and
accountant-approved manual tax configuration pass their launch gates.
