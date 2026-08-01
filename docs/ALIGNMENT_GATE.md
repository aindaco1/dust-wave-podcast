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

The parent repository pins the green `release/0.2.2` submodule so the private
benchmark-bundle assembler and its contract are reviewable with the Worker.
Model execution remains independently pinned to reviewed commit
`e611801d2af82dcdb079444b7e8a7eea4309d1a6` and runner digest
`sha256:8a7cda2702487a1d542d5fb740efe8580ca9edd99f405d722d610536c73a3a11`.
The digest is reproducible from that exact execution revision with
`git archive --format=tar REVISION | shasum -a 256`.
After the Worker validates that exact identity, the staging workflow fetches
and detaches the submodule at the execution commit before installing an
adapter. A bundle assembled by later source still identifies the exact commit
that produced its primary and replay results. Core CI does not download
models. The runtime validates bounded checksummed input, rejects input-root
and model-reference traversal, rechecks audio after inference, projects every
adapter result to stable word IDs, and writes canonical mode-`0600` evidence
with atomic no-overwrite semantics. Existing results are reused only when all
input and runner fingerprints match.

Benchmark integrity is fail-closed: duplicate fixture IDs, duplicate gold
words, invalid result/audio/transcript digests, repeated or unknown preview
samples, invalid timing provenance/confidence, and duplicate or unknown
idempotency checks cannot satisfy H1.

## Private benchmark evidence

Migration `0040_alignment_benchmark_evidence.sql` makes a passing benchmark
traceable to one immutable, closed-schema input. A recently authenticated
Super-admin submits at most 8 MiB to
`POST /v1/admin/alignment-benchmarks`. The Worker accepts only the exact pinned
runner repository/revision and configured adapter/model/settings/digest,
re-evaluates every fixture with the executable policy above, canonicalizes the
input and report, and stores the raw input in private R2 under an input-digest
identity. D1 retains the private object key, byte count, input/report SHA-256,
submission ID, runner revision, submitter ID, and summarized report.

Submission IDs and canonical input digests are independently unique. Replaying
the same submission or byte-equivalent benchmark returns the existing row;
reusing a submission ID for changed evidence is a conflict. Audit metadata
contains only counts, identities, statuses, and digests—not corpus text, word
records, object keys, or audio. Admin/Producer/Analyst roles may read the 20
latest summaries, but only a recent Super-admin session with a valid CSRF token
may import evidence.

The D1 approval trigger now also requires the benchmark’s private evidence
schema, bounded byte count, input digest/object key, and exact runner revision.
A failed benchmark remains useful diagnostic evidence but cannot unlock an
alignment. There is no benchmark override.

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
Ubuntu 24.04, validates the Worker-selected execution revision against the
reviewed constant, verifies the runner remote, and performs an exact
content-addressed fetch/detached checkout before installing only the selected
locked adapter extra. It uses purpose-bound signed Worker routes, receives no
Cloudflare/R2 credential, and retains no audio, transcript, or raw result
artifact. The Worker validates and stores the result but can move it only to
`needs_review`; an Admin/Super-admin approval button remains disabled until
the benchmark row matches.

## Current evidence state

The schema, normalized evaluator, private import path, and adversarial
integration fixtures are implemented. The test suite proves evaluation,
content-addressed storage, replay/conflict handling, content-free auditing,
role/recent-auth/CSRF enforcement, and D1 approval linkage with synthetic
records only. It does not claim that either candidate passes real audio. H1
remains blocked until the 24-fixture rights-cleared corpus, human word
boundaries, 100 preview reviews, 60-minute resource runs, idempotency evidence,
and clean-runner reproduction are imported and produce a passing row.

As of July 28, 2026, the owner-authorized English Dust Don't Settle source has
enough duration for 12 non-overlapping two-to-five-minute candidates, but its
transcript still needs human text, speaker, and timing review. No English
fixture is accepted yet. The Ópera en la Selva Substack feed currently exposes
two editorial items and no podcast-audio enclosure. A metadata-only review of
candidate Dust Wave YouTube uploads found English automatic captions and no
owner-confirmed Spanish spoken-audio source. YouTube's translated caption
options are not evidence that the underlying speech is Spanish.

The Spanish 12-fixture corpus therefore remains a sourcing and rights blocker.
Do not download an unapproved candidate, derive gold boundaries from
machine-translated captions, or substitute the deterministic UI fixture for
real benchmark evidence. Record the source authorization and spoken language
before any private corpus download or segmentation.
