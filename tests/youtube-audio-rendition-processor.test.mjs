import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

import {
  manifestBodySha256,
  validateYouTubeAudioRenditionManifest,
  YOUTUBE_AUDIO_RENDITION_MAXIMUM_BYTES,
  YOUTUBE_AUDIO_RENDITION_ORIGIN,
  YOUTUBE_AUDIO_RENDITION_PART_BYTES
} from "../scripts/lib/youtube-audio-rendition-contract.mjs";

describe("YouTube audio rendition processor", () => {
  let temporaryDirectory;
  let sourcePath;
  let artworkPath;
  let sourceBytes;
  let artworkBytes;
  let artworkSha256;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "dustwave-youtube-audio-")
    );
    sourcePath = path.join(temporaryDirectory, "source.mp3");
    artworkPath = path.join(temporaryDirectory, "artwork.png");
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=44100:duration=2",
      "-ac", "2",
      "-codec:a", "libmp3lame",
      "-b:a", "128k",
      sourcePath
    ]);
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "color=c=0x3b42f6:s=1200x1200",
      "-frames:v", "1",
      artworkPath
    ]);
    sourceBytes = (await stat(sourcePath)).size;
    artworkBytes = (await stat(artworkPath)).size;
    artworkSha256 = createHash("sha256")
      .update(await readFile(artworkPath))
      .digest("hex");
  });

  afterAll(async () => {
    if (
      temporaryDirectory
      && process.env.KEEP_YOUTUBE_AUDIO_FIXTURE !== "1"
    ) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("binds exact isolated-staging inputs, outputs, and codecs", () => {
    const manifest = fixtureManifest({ sourceBytes, artworkBytes });
    expect(validateYouTubeAudioRenditionManifest(manifest)).toBe(manifest);

    const changedCodec = structuredClone(manifest);
    changedCodec.video.crf = 20;
    changedCodec.manifestSha256 = manifestBodySha256(changedCodec);
    expect(() => validateYouTubeAudioRenditionManifest(changedCodec))
      .toThrow(/codec policy/);

    const externalEndpoint = structuredClone(manifest);
    externalEndpoint.endpoints.audioSource =
      "https://feeds.dustwave.xyz/v1/source";
    externalEndpoint.manifestSha256 = manifestBodySha256(externalEndpoint);
    expect(() => validateYouTubeAudioRenditionManifest(externalEndpoint))
      .toThrow(/isolated staging/);

    const traversal = structuredClone(manifest);
    traversal.output.objectKey =
      "podcasts/show/episode/youtube_audio_rendition/../escape.mp4";
    traversal.manifestSha256 = manifestBodySha256(traversal);
    expect(() => validateYouTubeAudioRenditionManifest(traversal))
      .toThrow(/output/);
  });

  it("renders and fully decodes a deterministic H.264/AAC MP4", async () => {
    const manifest = fixtureManifest({ sourceBytes, artworkBytes });
    const manifestPath = path.join(temporaryDirectory, "manifest.json");
    const outputDirectory = path.join(temporaryDirectory, "output");
    const callbackPath = path.join(temporaryDirectory, "callback.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    run("node", [
      "scripts/build-youtube-audio-rendition.mjs",
      "--manifest", manifestPath,
      "--source", sourcePath,
      "--artwork", artworkPath,
      "--output", outputDirectory,
      "--callback-body", callbackPath
    ], { timeout: 120_000 });
    const callback = JSON.parse(await readFile(callbackPath, "utf8"));
    expect(callback).toMatchObject({
      renditionId: "rendition_fixture",
      manifestSha256: manifest.manifestSha256,
      status: "succeeded",
      output: {
        objectKey: manifest.output.objectKey,
        mimeType: "video/mp4",
        width: 1920,
        height: 1080,
        videoCodec: "h264",
        pixelFormat: "yuv420p",
        audioCodec: "aac",
        sampleRateHz: 48_000,
        channels: 2,
        fullyDecoded: true
      },
      report: {
        schemaVersion: "youtube-audio-rendition-report-v1",
        templateId: "episode-artwork-waveform-v1",
        fullDecode: true
      }
    });
    expect(callback.output.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(callback.output.objectBytes).toBeGreaterThan(10_000);
    expect(Math.abs(callback.output.durationMs - 2_000))
      .toBeLessThanOrEqual(1_000);
  }, 15_000);

  function fixtureManifest({ sourceBytes, artworkBytes }) {
    const renditionId = "rendition_fixture";
    const base = [
      YOUTUBE_AUDIO_RENDITION_ORIGIN,
      "v1",
      "processor",
      "youtube-audio-renditions",
      renditionId
    ].join("/");
    const manifest = {
      schemaVersion: 1,
      renditionId,
      environment: "staging",
      templateId: "episode-artwork-waveform-v1",
      episode: {
        id: "episode_fixture",
        title: "Fixture episode",
        durationMs: 2_000
      },
      source: {
        objectKey: "podcasts/show_fixture/episode_fixture/delivery/source.mp3",
        objectBytes: sourceBytes,
        etag: "\"source-etag\"",
        mimeType: "audio/mpeg",
        workingMasterId: "master_fixture",
        workingMasterSha256: "a".repeat(64)
      },
      artwork: {
        objectKey:
          "podcasts/show_fixture/episode_fixture/"
            + "youtube_audio_rendition/rendition_fixture-artwork.png",
        objectBytes: artworkBytes,
        etag: "\"artwork-etag\"",
        mimeType: "image/png",
        sha256: artworkSha256
      },
      video: {
        width: 1920,
        height: 1080,
        frameRate: 30,
        pixelFormat: "yuv420p",
        codec: "h264",
        profile: "high",
        crf: 26,
        preset: "veryfast",
        fastStart: true
      },
      audio: {
        codec: "aac",
        sampleRateHz: 48_000,
        channels: 2,
        bitrateKbps: 192
      },
      output: {
        objectKey:
          "podcasts/show_fixture/episode_fixture/"
            + "youtube_audio_rendition/rendition_fixture.mp4",
        mimeType: "video/mp4",
        width: 1920,
        height: 1080,
        maximumBytes: YOUTUBE_AUDIO_RENDITION_MAXIMUM_BYTES,
        recommendedPartBytes: YOUTUBE_AUDIO_RENDITION_PART_BYTES,
        maximumPartBytes: YOUTUBE_AUDIO_RENDITION_PART_BYTES
      },
      endpoints: {
        audioSource: `${base}/sources/audio`,
        artworkSource: `${base}/sources/artwork`,
        partTemplate: `${base}/parts/{partNumber}`,
        uploadComplete: `${base}/upload-complete`,
        evidenceComplete: `${base}/complete`
      }
    };
    manifest.manifestSha256 = manifestBodySha256(manifest);
    return manifest;
  }
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || result.stdout).slice(0, 8_000)}`
    );
  }
}
