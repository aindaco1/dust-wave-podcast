# Real-client virtual-audio gate

Request-time sponsor selection may launch only through a decision-specific
virtual enclosure that behaves like one stable audio object in real podcast
clients. A validated preassembled full-file rendition remains the automatic
fallback until this gate passes.

## Implemented contract

`src/virtual-media.ts` compiles a bounded, decision-specific media manifest and
maps a single HTTP byte range onto ordered private R2 object windows. It:

- requires one common, previously validated codec/container stream profile;
- rejects duplicate segments and invalid or out-of-bounds byte windows;
- caps each rendition at 24 segments, well above the launch maximum of three ad
  markers while reserving request budget;
- coalesces adjacent windows from the same object;
- supports bounded, open-ended, and suffix byte ranges;
- rejects multipart or unsatisfiable ranges with `416`;
- preserves `HEAD`, `If-None-Match`, and `If-Range` behavior;
- returns decision-specific ETags and no-store response policy; and
- streams sequential R2 ranges without buffering the full episode.

The `0012` isolated-staging route projects persisted selector output into this
contract. It HMAC-binds a URL to an immutable manifest digest, stores no raw
address or user-agent, and rechecks the manifest hash plus every object
size/ETag before streaming. Missing or mutated objects fail before headers.
Creative uploads use new versioned keys and processed program segments use
content-addressed filenames, so a later replacement cannot silently alter an
issued decision.

This contract does not claim that arbitrary MP3 or M4A files can be
concatenated. The media pipeline must produce frame-boundary program pieces and
creative assets with the same recorded profile, validate the assembled
rendition, and retain a full-file fallback. Insertable creative objects must
contain raw MPEG frames only: ID3v2 headers and ID3v1 trailers are rejected
because metadata bytes inserted between program frames would corrupt the
virtual stream.

Generate the first deterministic, Dust Wave-owned raw-frame MP3 fixture and
FFmpeg/FFprobe evidence outside the repository with:

```sh
npm run fixtures:virtual-audio -- /absolute/private/evidence/directory
```

The generator refuses an implicit destination, emits checksums and probe
metadata, verifies that program-only and mid-roll byte assemblies fully decode,
and writes a manifest that can be projected into the Worker contract. The tone
fixture proves framing and byte behavior only; listening-client acceptance
still requires the matrix below.

The staging Worker exposes this exact fixture only at an opaque, manually
rotatable path under `/v1/diagnostics/virtual-audio/`. The path token is a
staging-only Worker secret, is compared in constant time, and is never
committed or printed in evidence. Production returns `404` even if a token is
supplied. Rotate or remove the secret after the client matrix.
For browser checks, open `/v1/diagnostics/virtual-audio/player` and enter the
token into its password field. The no-store, no-referrer, staging-only harness
keeps the value in page memory, clears the field, and exposes explicit load,
play, seek, and pause status without putting the token in navigation history.

Run the redacted HTTP protocol matrix with the token supplied only through the
environment:

```sh
VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN=... npm run matrix:virtual-audio -- \
  --origin https://dust-wave-podcast-staging.example.workers.dev \
  --output /absolute/private/evidence/protocol-matrix.json
```

The runner verifies full and ranged delivery, resume forms, retries, ETag
conditionals, invalid ranges, and concurrent reads. Its named podcast-client
probes emulate request headers only and are explicitly recorded as
`nativeClientValidation: false`; they do not replace the real application
matrix.

For the sustained staging gate, upload the generated
`virtual-midroll.mp3` alongside its three component objects and run:

```sh
VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN=... npm run load:virtual-audio -- \
  --origin https://dust-wave-podcast-staging.example.workers.dev \
  --output /absolute/private/evidence/paired-load.json \
  --pairs 5000 --concurrency 12
```

The diagnostic exposes the same 193,932 bytes as a three-object virtual stream
and a one-object private-R2 baseline under the same ETag. The load gate
alternates request order, excludes warmups, uses five deterministic range
patterns including both object boundaries, and compares 5,000 pairs (10,000
measured requests). It fails at a 0.1% or higher request error rate, any
content mismatch, or more than 250 ms of added virtual p95 latency. Evidence
redacts the token path and stores only bounded aggregate/error data.

## Required fixture set

Generate Dust Wave-owned fixtures for both launch formats:

1. program only;
2. pre-roll plus program;
3. program with one mid-roll;
4. pre-, mid-, and post-roll;
5. no eligible sponsor, house-promo fallback;
6. ad-free premium;
7. creative kill-switch after an earlier decision expires; and
8. intentionally incompatible media, which must select the full-file fallback.

Each manifest and derivative records source checksums, codec/container profile,
frame-boundary evidence, virtual byte length, ETag, decision expiry, selected
campaign/creative IDs, and fallback identity.

## Client and protocol matrix

Exercise full `GET`, `HEAD`, bounded range, open range, suffix range, retry,
seek forward/back, resume, download, expired decision, and concurrent requests
against:

- Apple Podcasts on a current iPhone and macOS;
- Spotify on current iPhone, Android, and desktop;
- Pocket Casts and Overcast;
- Podcast Addict on Android;
- the Dust Wave WaveSurfer player in current Safari, Chrome, and Firefox; and
- `curl`, FFmpeg, and a feed-validator diagnostic client.

Record application/version, device/OS, request sequence, status and range
headers, bytes served, first-play and seek latency, playback discontinuities,
decision/manifest ID, fallback use, and result. Do not log raw IP addresses,
private feed tokens, or full user agents.

## Launch thresholds

The request-time path passes only when:

- every supported client completes first play, seek, resume, and download for
  every compatible fixture without audible corruption or wrong content;
- all returned byte counts and `Content-Range` values match the virtual length;
- repeated requests for one unexpired decision return the same manifest and
  ETag without counting a second qualified impression;
- incompatible, missing, expired, over-budget, or validation-failed manifests
  select the preassembled fallback before response streaming begins;
- p95 Worker time-to-first-byte adds no more than 250 ms over the equivalent
  private-R2 full-file response in the staging region set;
- the stream error rate is below 0.1% in a 10,000-request staged load run with
  zero content/entitlement mismatches; and
- a kill-switch takes effect for new decisions within 60 seconds without
  changing an already issued decision's bytes.

Until the recorded matrix passes, feed enclosures and downloads continue to
use validated full-file renditions. The admin may show request-time selection
as an engineering preview, never as launch-ready inventory.

Every immutable decision records primary and fallback byte counts in an
`equal-byte-length-v1` contract. The Worker derives and revalidates the
contract rather than trusting caller input. Unequal staging fixtures remain
usable for diagnostic fallback evidence but are explicitly not launch-ready.
Before the permanent enclosure can use request-time selection, each supported
slot duration needs an approved house/filler rendition whose complete
assembled byte count exactly matches the sponsor rendition.

The staging selector now enforces this mechanically. For each selected
sponsor slot it considers only approved, targeted house inventory with the
same validated object bytes, duration, MIME type, and stream profile, then
snapshots the house campaign/creative/object evidence separately. Complete
coverage produces a `house_fill` fallback with the same virtual length;
incomplete coverage retains the diagnostic `full_file` fallback and leaves the
length gate false.
