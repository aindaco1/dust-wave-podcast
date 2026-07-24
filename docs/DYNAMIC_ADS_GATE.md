# Dynamic house/direct sponsor gate

Launch inventory is limited to Dust Wave house promos and directly sold
sponsors. The runtime may select at request time by show, episode, marker
position, campaign/rule dates, normalized device class, and normalized podcast
app. It does not implement a programmatic marketplace, demographic targeting,
or third-party advertiser settlement.

## Implemented decision boundary

`src/ad-decision.ts` is a deterministic, provider-neutral selector:

- only active campaigns inside both campaign and matching-rule date windows
  are eligible;
- a kill switch or hard impression cap removes a campaign immediately;
- creative audio must be active, validated, byte-bounded, and on the episode's
  exact stream profile;
- explicit priority wins first, direct inventory wins a tie over house
  inventory, and the most specific matching rule wins the next tie;
- campaign pacing influences deterministic weighted selection among otherwise
  equal candidates;
- a decision fills at most one pre-, mid-, and post-roll and avoids repeating a
  campaign when other eligible inventory exists;
- the same pseudonymous request key and inventory revision produce the same
  selection; and
- raw IP addresses and full user-agent strings are never returned or persisted.

The authenticated `POST /v1/admin/ads/preview` route loads the current D1
campaigns, rules, creatives, marker, and program-segment readiness into that
selector. It accepts only normalized app/device input, writes no decision or
counter, and always reports `full_file_only` public delivery plus the remaining
activation blockers.

The schema in migration `0008` records media validation, approved episode
markers, frame-safe program segments, decision manifests, selected slots, and
deduplicated qualified impressions. Raw delivery telemetry belongs in
Analytics Engine; D1 retains decisions, qualifications, counters, and
reconciliation evidence.

Migration `0009` adds versioned campaign approval and active-rule state.
Admin-only create/edit/approve/kill operations are show-scoped, CSRF-protected,
and audited. Creation and any edit leave the campaign in `draft`; approval
requires validated compatible creative audio; and the idempotent kill switch
sets both inactive and revoked state. The serving selector accepts only
`approved` campaigns with an active sponsor for direct inventory.

Migration `0010` makes creative approval evidence durable. The producer/admin
workflow streams a maximum 25 MiB MP3 to private R2, verifies the declared and
stored byte counts, parses every frame against the launch
`mp3-44100-stereo-cbr128-frame-v1` profile, compares declared and measured
duration, and stores the measured duration, SHA-256, validation report, and
operator identities. Browser clients declare size with
`x-podcast-upload-bytes`; R2 size remains authoritative. Upload, replacement,
and revalidation reset campaign approval, and failures cannot become selectable.

Migration `0011` separates marker intent, machine evidence, and human approval.
An ad plan snapshots the exact episode source key/bytes/ETag, marker intent,
profile, and revision. The isolated staging processor normalizes the source
once, splits only on full MPEG frames, uploads plan-prefixed private program
objects, and returns a timestamped HMAC evidence manifest. The Worker verifies
R2 sizes, contiguous order, frame-count duration, 128 kbps byte bounds,
mid-roll alignment, total episode duration, and manifest SHA-256. Only a later
Producer/Admin/Super-admin approval atomically promotes markers and segments to
ready state; approval deliberately leaves show/episode delivery flags false.

Migration `0012` adds the first persisted immutable-decision exercise. The
staging-only issuer keys one decision by episode/publication revision,
inventory/marker/segment fingerprint, coarse client dimensions, hourly epoch,
and an ephemeral daily address HMAC. It snapshots campaign revision, creative
hash/duration/key/bytes/ETag, the complete ordered virtual manifest, its strong
ETag, and its SHA-256. Expiring URLs sign the decision ID, expiry, and manifest
digest; invalid signatures are rejected before D1 lookup. Stored manifests are
rehash-checked and every R2 object size/ETag is preflighted before headers.
Rotation accepts a current and optional previous secret while issuing only
with the current secret; the previous key can be retired after the maximum
two-hour URL lifetime without changing any stored manifest.

Creative replacement now writes a new versioned object key rather than
overwriting bytes referenced by an earlier decision. Processor program
filenames include their SHA-256 under the unique ad-plan prefix. The permanent
enclosure is still full-file-only; this path exists solely for isolated
staging/client evidence.

## Privacy and identity

The permanent enclosure must not derive a new byte layout for every range
probe. Before live use, it will issue a signed decision URL. The request key is
an HMAC over:

- episode and publication revision;
- the versioned eligible-inventory fingerprint;
- an hourly decision epoch;
- normalized app and device values; and
- an ephemeral daily HMAC of the connecting address.

The address exists only in request memory. D1 stores the final keyed hash,
coarse app/device values, and the privacy/decision epochs. A decision URL keeps
its original immutable manifest available for resumable downloads after
campaign state changes; new permanent-enclosure requests can receive a newer
decision after a rule boundary or kill switch.

## Full-file fallback

Request-time assembly remains disabled per show and episode by default. Any of
the following chooses the validated preassembled full file before response
streaming begins:

- missing decision secret or disabled environment mode;
- no approved marker or no complete validated program segmentation;
- incompatible or unavailable creative media;
- invalid, expired, revoked, or over-budget decision;
- unsupported client behavior from the real-client matrix;
- manifest/profile/range validation failure; or
- operator kill switch.

Fallback is a successful safe delivery state, not an ad impression. Admin
analytics must separate decisions, full-file fallbacks, starts, byte delivery,
qualified impressions, and completed downloads.

## Qualification and pacing gate

A campaign counter increments once per decision slot only after a durable,
deduplicated qualification:

- the complete ad byte window was delivered; or
- player telemetry proves the configured listen threshold.

Range probes, retries, duplicate events, manifest creation, and fallback
delivery do not qualify. Counters must reconcile to
`ad_impression_qualifications` before pacing or sponsor reporting is enabled.
The hard cap update must be atomic; if D1 contention cannot prove this under the
staged load envelope, move counter reservation to a Durable Object without
changing the selector or decision manifest contract.

Migration `0012` enforces one qualification per decision slot with a partial
unique index. A SQLite `BEFORE INSERT` trigger ignores an insertion at a
reached hard cap, while the paired `AFTER INSERT` trigger increments the
campaign counter in the same statement/transaction. A reconciliation view
compares each counter with its durable rows. The trusted code path currently
accepts only complete-download evidence for the exact creative byte count; it
is not yet exposed as a browser endpoint.

## Promotion evidence

Live request-time ads require all of:

- admin authorization, approval, kill-switch, audit, and campaign CRUD tests;
- deterministic selector fixtures for every target dimension and date edge;
- exact program/creative stream-profile validation and full-file comparison;
- signed-decision key rotation plus expiry-boundary and revocation evidence;
- atomic cap and qualification deduplication under staged concurrency;
- the complete real podcast-client range/seek/resume/download matrix in
  `VIRTUAL_AUDIO_GATE.md`;
- fallback latency and correctness evidence;
- privacy/log inspection with no raw address, full user agent, feed token, or
  member identifier; and
- one reviewed direct-sponsor pilot whose delivery and invoice report
  reconcile.

Until those pass, `dynamic_ads_enabled` stays false and existing public media
routes continue serving the validated full episode file.
