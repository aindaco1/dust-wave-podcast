# Email delivery

The shared `@dustwave/worker-core/email` helper supplies `Auto-Submitted: auto-generated` and an explicit reply destination. Existing subjects, HTML, plain text, sender identities, recipients, links, attachments, tags, and unsubscribe headers remain owned by the application. It does not add marketing, tracking, retry loops, or new recipients.

Resend's verified domain authentication and hard-bounce/complaint suppression remain provider responsibilities. An API success or a delivered event means provider/recipient-server acceptance; it does not prove Inbox placement. Keep open/click tracking disabled for these service messages. See the [shared deliverability guide](https://github.com/aindaco1/dust-wave-platform/blob/main/docs/email-deliverability.md).

All Podcast Resend messages use the existing `sendResendPayload` boundary. Optional `PODCAST_EMAIL_REPLY_TO` overrides the existing `PODCAST_OWNER_EMAIL` fallback. No message renderer changed. The same serialized payload is used for the bounded trusted redirect. Announcement subscription checks, one-click unsubscribe, delivery mode and idempotency keys remain unchanged; deployment does not enable announcements.

## Shared dependency and rollback

Platform 0.36.0 (`af2a5e5e4b65f218e627652b8243feb9704c48a1`) supplies Worker Core 0.13.0. Exact package versions are enforced by `tests/platform-pin.test.mjs`. This advances an older platform pin, so the full Podcast gate and staging/production Wrangler dry runs are required. No database migration is needed.

Rollback the complete adoption commit, restore pin `a0006c3e0c3f8ab814387491753989956adbbe94` with its matching lockfile, run `npm ci`, and redeploy the previous Worker version. Do not replay previously attempted announcement payloads under changed configuration; review existing delivery records before any manual resend.
