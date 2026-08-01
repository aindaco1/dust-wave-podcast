# Queue terminal-failure automation

This document defines the staging-only boundary that preserves exhausted
Podcast Queue evidence without automatically repeating an ambiguous provider
side effect.

## Flow

1. `dust-wave-podcast-jobs-staging` attempts a normal job at most four times:
   the first delivery plus three configured retries.
2. Cloudflare moves an exhausted message to
   `dust-wave-podcast-jobs-staging-dlq`.
3. The same staging Worker consumes that isolated DLQ, validates the closed
   Podcast job envelope again, and writes one content-free incident to D1.
4. D1 acknowledgement is the only side effect. The DLQ consumer never sends a
   message to `JOBS`, calls a provider, publishes an episode, sends email, or
   changes source job state.
5. The Queue message is acknowledged only after D1 succeeds. Storage failures
   use a five-minute retry delay and a bounded 100-retry ceiling so a temporary
   D1 outage does not discard the incident during the short Queue retention
   window.

## Durable evidence

Migration `0068_queue_dead_letter_incidents.sql` stores only:

- a SHA-256 fingerprint of the serialized Queue body;
- the fixed source and dead-letter queue names;
- a valid closed job type and bounded job/show/episode identifiers, when the
  message is a valid Podcast job envelope;
- the publication revision, delivery attempt, occurrence count, fixed failure
  code, state, and timestamps.

The table has no column for the Queue body, provider response, error message,
media URL, object key, transcript, listener identity, email address, or
credential. Malformed messages retain only the fingerprint, classification,
fixed failure code, and delivery evidence. Repeated delivery of the same body
increments one row and reopens a previously resolved incident.

## Safety properties

- The consumer activates only when `ENVIRONMENT=staging` and `batch.queue`
  exactly matches the staging DLQ.
- The application has no producer binding for the DLQ.
- The DLQ consumer has no dead-letter queue of its own, preventing recursive
  queue chains.
- Production queue configuration and migrations remain unchanged until an
  independent promotion review.
- Automatic replay is intentionally absent. A later recovery action must
  classify each job type by idempotency and provider ambiguity, re-read current
  source state, and issue a new typed job rather than copying the old body.

## Verification

Before applying migration `0068` or deploying staging:

```sh
npx vitest run tests/queue-config.test.mjs tests/queue-dead-letters.test.mjs
npm run check
npm run deploy:staging:dry
npm run deploy:production:dry
```

Back up staging D1, apply migrations to staging only, deploy the staging
Worker, and confirm both consumers:

```sh
npx wrangler queues consumer worker list dust-wave-podcast-jobs-staging
npx wrangler queues consumer worker list dust-wave-podcast-jobs-staging-dlq
```

Use only aggregate/content-free inspection in shared evidence:

```sql
SELECT classification, job_type, status, COUNT(*) AS total
FROM queue_dead_letter_incidents
GROUP BY classification, job_type, status
ORDER BY classification, job_type, status;
```

Do not publish a synthetic message directly to the operational DLQ merely to
exercise the consumer. The local migration replay and focused tests cover
ingestion without polluting terminal-failure evidence.
