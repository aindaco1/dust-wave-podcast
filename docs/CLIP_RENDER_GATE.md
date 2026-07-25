# Clip-render staging gate

The clip processor turns one approved, versioned transcript selection and one
immutable delivery MP3 into a private captioned-waveform MP4. It is
staging-only. Passing this gate does not publish a clip, expose an object URL,
or upload a YouTube Short.

## Implemented boundary

1. A Producer queues one stable render ID for the current clip revision.
2. The Worker rechecks the approved transcript, any required passed word
   alignment, source object bytes/ETag, and canonical `FEED_ORIGIN`; it persists
   the manifest digest and predetermined private output key.
3. The pinned GitHub workflow signs a purpose-bound `manifest` request and
   validates the returned `clip-render-v1` document.
4. A separately signed `source` request conditionally streams the exact
   private MP3 from the Worker's R2 binding. The processor receives no R2
   credential.
5. FFmpeg trims the selected audio and creates H.264/AAC MP4; ImageMagick
   rasterizes approved caption text into fixed safe areas. No caption string is
   evaluated by a shell.
6. The processor probes and fully decodes the file, verifies dimensions,
   duration, codecs, frame rate, audio profile, bytes, and SHA-256.
7. A signed upload descriptor binds render/manifest identity, bytes, and
   SHA-256. The Worker streams the MP4 into the predetermined R2 key with
   native SHA-256 verification and fixed custom metadata.
8. A signed completion callback re-heads R2 and commits `ready` idempotently.
   A historical render cannot update a newer clip revision.

## Fixed resource limits

- duration: 1–180 seconds;
- formats: 1080×1920, 1080×1080, or 1920×1080;
- output: H.264 High/YUV420p at 30 fps plus AAC 48 kHz stereo;
- output upload: at most 95 MiB, below Cloudflare's 100 MB Free/Pro request
  limit;
- caption payload: at most 1 MB, at most 360 cues, and at most two cues per
  second;
- workflow: 30-minute job timeout; one concurrency group per render ID;
- retained artifact: callback, bounded failure evidence, and upload response
  only, for 30 days.

## Required configuration

Use one staging-only value in both locations:

- Cloudflare Worker secret `MEDIA_PROCESSOR_CALLBACK_SECRET`;
- GitHub environment `podcast-staging` secret
  `MEDIA_PROCESSOR_CALLBACK_SECRET`.

No R2 access key, Cloudflare account ID, or Cloudflare API token is required by
the clip workflow. Do not copy Pool or Store deployment credentials.

GitHub accepts `workflow_dispatch` only after the workflow file exists on the
default branch. Queue a staging render in the authenticated workbench, then:

```sh
gh workflow run process-clip-render.yml \
  --ref main \
  -f render_id=clip_render_example
```

## Acceptance evidence

- `actionlint` passes and every third-party action is pinned to a full commit;
- Worker types, TypeScript, all tests, and staging/production dry-run bundles
  pass; production is not deployed;
- hostile HTML, traversal, changed digest, public callback, excessive caption
  density, missing signatures, stale timestamps, and changed signed payloads
  fail closed;
- real FFmpeg/ImageMagick renders for 9:16, 1:1, and 16:9 fully decode and
  contain both colored waveform and high-contrast caption pixels;
- signed Worker manifest and source routes return only the queued immutable
  revision;
- the upload response and a separate R2 read have the same byte count and
  SHA-256 as the local output;
- D1 stores `ready` with exact dimensions/duration and has no foreign-key
  violations;
- replaying the same completion returns `idempotent: true`;
- GitHub logs/artifacts contain no transcript text, source/output media,
  provider credential, or private object URL.
- ready preview/download requires show-scoped admin authorization, revalidates
  D1 and R2 checksum/manifest evidence, and serves only private no-store,
  noindex, single-range MP4 responses without exposing the object key.

Local runtime evidence on July 25, 2026 passed the complete
Worker+D1+R2 source/render/upload/callback path for a 12-second 9:16 fixture:
193,932 source bytes, 730,316 output bytes, matching SHA-256
`c2feda8f1a099ae678f8fb6f0fd8246bf24655201b66cac839d3fcca90bd42b9`,
`ready` state, clean foreign keys, and idempotent replay. This is not a remote
GitHub Actions or production claim.

## Failure and rollback

- Before output verification, workflow failure submits bounded `failed`
  evidence when a validated callback URL exists.
- After output verification, a callback/network failure does not falsely mark
  the render failed; rerun the same render ID.
- Disable dispatch by removing the GitHub environment secret.
- Roll the staging Worker back to the prior recorded version if a route
  regression appears. Do not deploy or roll back production as part of this
  gate.
- Private output keys are revision/render-specific. A failed attempt may be
  overwritten only by the same render contract; it cannot mutate an older
  published object.
