# English/Spanish word-alignment gate

Word-level navigation and edit boundaries are disabled until one pinned
alignment adapter passes the recorded launch benchmark in both English and
Spanish. Segment captions remain available when this gate is incomplete or
failed.

## Normalized boundary

Every adapter result is converted to stable transcript word records before it
reaches D1 or an admin client. Each record carries:

- stable transcript, cue, and word IDs;
- lexical text and order;
- start/end milliseconds, or an explicit bounded unaligned reason;
- confidence when the adapter supplies one;
- `forced_alignment`, `model`, `editor`, or `interpolated` provenance;
- source-audio, transcript-revision, adapter/model/settings, and runner
  fingerprints through its alignment revision.

Interpolated words may be retained for diagnostics but never count as aligned
and never power a word-level cut. A missing word record is not an acceptable
substitute for an explicit unaligned reason.

## Launch thresholds

The executable policy in `src/alignment-quality.ts` enforces:

- 12 rights-cleared two-to-five-minute fixtures per language;
- at least 400 human-marked lexical words per language;
- at least 98% valid aligned words per language;
- median absolute start/end boundary error no greater than 120 ms;
- p95 absolute start/end boundary error no greater than 300 ms;
- no negative, backward, zero-duration, cross-cue, outside-audio, duplicate-ID,
  or unexplained omitted intervals;
- at least 95 accepted unclipped edit previews from 100 reviewed samples;
- a recorded 60-minute resource run in each language;
- semantic/timing-stable idempotent reruns for every fixture, without a second
  billable job; and
- one clean-environment reproduction.

English and Spanish pass independently. One language cannot average away the
other language’s failure.

## Candidate adapters

The runner contract keeps stable-ts and WhisperX behind the same normalized
manifest. stable-ts can align reviewed text with Whisper and is MIT-licensed;
its paused-development status requires an exact pin and a maintained fallback.
WhisperX is BSD-2-Clause and provides default English and Spanish
phoneme-alignment models; its diarization feature is excluded. WhisperX may
interpolate unalignable values internally, so the adapter must mark that origin
and the gate will reject those timings for word edits.

The Python/model runtime belongs in a pinned GitHub or owner-controlled runner,
not in the public Worker. The Worker owns job fingerprints, state, policy,
result validation, and D1/R2 projection.

The owner-controlled runtime is package version `0.2.0`, pinned by an exact
commit in the `alignment-runner` submodule on its `release/0.2.0` branch. Its
core CI does not download models. It validates
bounded checksummed input, rejects input-root and model-reference traversal,
rechecks audio after inference, projects every adapter result to stable word
IDs, and writes canonical mode-`0600` evidence with atomic no-overwrite
semantics. Existing results are reused only when all input and runner
fingerprints match.

Benchmark integrity is fail-closed: duplicate fixture IDs, duplicate gold
words, invalid result/audio/transcript digests, repeated or unknown preview
samples, invalid timing provenance/confidence, and duplicate or unknown
idempotency checks cannot satisfy H1.

## Operational staging bridge

Migration `0039_alignment_orchestration.sql` records one immutable job per
source/transcript/projection/adapter/runner fingerprint, permits the same word
position across distinct alignment revisions, and makes current jobs stale
when their transcript or working master changes. D1 independently rejects an
alignment `passed` transition without an exact approval and rejects an
approval unless the result is structurally eligible and its current inputs and
clean bilingual benchmark all match.

The Podcast admin queues the selected approved language and displays the exact
manual workflow handoff. `process-alignment.yml` is staging-only, pinned to
Ubuntu 24.04 and the exact runner submodule revision, installs only the
selected locked adapter extra, and uses purpose-bound signed Worker routes. It
receives no Cloudflare/R2 credential and retains no audio, transcript, or raw
result artifact. The Worker validates and stores the result but can move it
only to `needs_review`; an Admin/Super-admin approval button remains disabled
until the benchmark row matches.

## Current evidence state

The schema, normalized evaluator, and adversarial unit fixtures are implemented.
They do not claim that either candidate passes real audio. H1 remains blocked
until the 24-fixture rights-cleared corpus, human word boundaries, 100 preview
reviews, 60-minute resource runs, idempotency evidence, and clean-runner
reproduction are attached to a benchmark report.
