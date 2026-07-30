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

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

import {
  CLIP_ASPECT_DIMENSIONS,
  manifestBodySha256,
  validateClipRenderManifest
} from "../scripts/lib/clip-render-contract.mjs";

describe("captioned waveform processor", () => {
  let temporaryDirectory;
  let sourcePath;
  let sourceBytes;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "dustwave-clip-processor-")
    );
    sourcePath = path.join(temporaryDirectory, "source.mp3");
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
    sourceBytes = (await stat(sourcePath)).size;
  });

  afterAll(async () => {
    if (temporaryDirectory && process.env.KEEP_CLIP_PROCESSOR_FIXTURE !== "1") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    if (process.env.KEEP_CLIP_PROCESSOR_FIXTURE === "1") {
      process.stdout.write(`Preserved clip fixture: ${temporaryDirectory}\n`);
    }
  });

  it("validates all three isolated-staging aspect contracts", () => {
    for (const aspectRatio of Object.keys(CLIP_ASPECT_DIMENSIONS)) {
      const manifest = fixtureManifest({ aspectRatio, sourceBytes });
      expect(validateClipRenderManifest(manifest)).toBe(manifest);
    }
  });

  it("rejects a changed digest, public callback, traversal, and active HTML", () => {
    const changed = fixtureManifest({ sourceBytes });
    changed.recipe.title = "Changed after digest";
    expect(() => validateClipRenderManifest(changed))
      .toThrow(/digest/);

    const publicCallback = fixtureManifest({ sourceBytes });
    publicCallback.callbackUrl =
      "https://feeds.dustwave.xyz/v1/processor/clip-renders/render_fixture/complete";
    publicCallback.manifestSha256 = manifestBodySha256(publicCallback);
    expect(() => validateClipRenderManifest(publicCallback))
      .toThrow(/isolated staging/);

    const traversal = fixtureManifest({ sourceBytes });
    traversal.output.objectKey =
      "podcasts/show_fixture/episode_fixture/clips/clip_fixture/revision-1/../render_fixture.mp4";
    traversal.manifestSha256 = manifestBodySha256(traversal);
    expect(() => validateClipRenderManifest(traversal))
      .toThrow(/output contract/);

    const html = fixtureManifest({ sourceBytes });
    html.captions.cues[0].textMarkdown = "<script>alert(1)</script>";
    html.manifestSha256 = manifestBodySha256(html);
    expect(() => validateClipRenderManifest(html))
      .toThrow(/caption cue/);

    const abusiveDensity = fixtureManifest({ sourceBytes });
    abusiveDensity.captions.cues = [0, 1, 2].map((index) => ({
      id: `cue_fixture_${index}`,
      startsAtMs: index * 300,
      endsAtMs: index * 300 + 300,
      speakerLabel: "Jay",
      textMarkdown: `Cue ${index}`
    }));
    abusiveDensity.manifestSha256 = manifestBodySha256(abusiveDensity);
    expect(() => validateClipRenderManifest(abusiveDensity))
      .toThrow(/caption collection/);
  });

  it("renders, fully decodes, and proves visuals in all aspect ratios", async () => {
    for (const [aspectRatio, dimensions] of Object.entries(
      CLIP_ASPECT_DIMENSIONS
    )) {
      const suffix = aspectRatio.replace(":", "x");
      const manifest = fixtureManifest({ aspectRatio, sourceBytes });
      const manifestPath = path.join(
        temporaryDirectory,
        `manifest-${suffix}.json`
      );
      const outputDirectory = path.join(
        temporaryDirectory,
        `output-${suffix}`
      );
      const callbackPath = path.join(
        temporaryDirectory,
        `callback-${suffix}.json`
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`
      );
      run("node", [
        "scripts/build-captioned-waveform-clip.mjs",
        "--manifest", manifestPath,
        "--source", sourcePath,
        "--output", outputDirectory,
        "--callback-body", callbackPath
      ], { timeout: 120_000 });
      const callback = JSON.parse(await readFile(callbackPath, "utf8"));
      expect(callback).toMatchObject({
        renderId: manifest.renderId,
        manifestSha256: manifest.manifestSha256,
        status: "succeeded",
        output: {
          objectKey: manifest.output.objectKey,
          mimeType: "video/mp4",
          width: dimensions.width,
          height: dimensions.height
        },
        report: {
          schemaVersion: "clip-render-report-v1",
          templateId: "captioned-waveform-v1",
          aspectRatio,
          captionCueCount: 1,
          videoCodec: "h264",
          audioCodec: "aac",
          fullDecode: true
        }
      });
      expect(
        Math.abs(callback.output.durationMs - 1_000)
      ).toBeLessThanOrEqual(250);
      expect(callback.output.objectBytes).toBeGreaterThan(10_000);
      expect(callback.output.sha256).toMatch(/^[a-f0-9]{64}$/);

      if (aspectRatio === "9:16") {
        run("node", [
          "scripts/verify-clip-source.mjs",
          manifestPath,
          sourcePath
        ]);
        const githubOutputPath = path.join(
          temporaryDirectory,
          "github-output.txt"
        );
        await writeFile(githubOutputPath, "");
        run("node", [
          "scripts/prepare-clip-upload.mjs",
          manifestPath,
          callbackPath
        ], {
          env: {
            ...process.env,
            GITHUB_OUTPUT: githubOutputPath
          }
        });
        const outputs = Object.fromEntries(
          (await readFile(githubOutputPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [
                line.slice(0, separator),
                line.slice(separator + 1)
              ];
            })
        );
        const uploadPayload = JSON.parse(
          Buffer.from(outputs.upload_payload, "base64url")
            .toString("utf8")
        );
        expect(uploadPayload).toEqual({
          action: "upload",
          renderId: manifest.renderId,
          manifestSha256: manifest.manifestSha256,
          objectBytes: callback.output.objectBytes,
          sha256: callback.output.sha256
        });
        expect(await readFile(
          outputs.upload_payload_path,
          "utf8"
        )).toBe(outputs.upload_payload);

        const uploadResponsePath = path.join(
          temporaryDirectory,
          "upload-response.json"
        );
        await writeFile(
          uploadResponsePath,
          JSON.stringify({
            object: {
              objectKey: callback.output.objectKey,
              objectBytes: callback.output.objectBytes,
              sha256: callback.output.sha256,
              mimeType: "video/mp4",
              manifestSha256: callback.manifestSha256
            },
            checksumVerified: true
          })
        );
        run("node", [
          "scripts/verify-clip-output.mjs",
          callbackPath,
          uploadResponsePath
        ]);
      }

      expect((await stat(
        path.join(outputDirectory, "caption-0.png")
      )).size).toBeGreaterThan(1_000);

      const framePath = path.join(
        temporaryDirectory,
        `frame-${suffix}.rgb`
      );
      run("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-ss", "0.5",
        "-i", path.join(outputDirectory, "clip.mp4"),
        "-frames:v", "1",
        "-pix_fmt", "rgb24",
        "-f", "rawvideo",
        framePath
      ]);
      const frame = await readFile(framePath);
      let coloredPixels = 0;
      let lightPixels = 0;
      for (let index = 0; index < frame.length; index += 3) {
        const red = frame[index];
        const green = frame[index + 1];
        const blue = frame[index + 2];
        if (
          Math.max(red, green, blue) - Math.min(red, green, blue) > 45
        ) {
          coloredPixels += 1;
        }
        if (red > 190 && green > 190 && blue > 190) lightPixels += 1;
      }
      expect(coloredPixels).toBeGreaterThan(100);
      expect(lightPixels).toBeGreaterThan(100);
    }
  }, 120_000);
});

function fixtureManifest({
  aspectRatio = "9:16",
  sourceBytes
} = {}) {
  const dimensions = CLIP_ASPECT_DIMENSIONS[aspectRatio];
  const manifest = {
    schemaVersion: "clip-render-v1",
    renderId: "render_fixture",
    clipId: "clip_fixture",
    clipRevision: 1,
    episodeId: "episode_fixture",
    showId: "show_fixture",
    recipeSha256: "a".repeat(64),
    source: {
      bucketName: "dustwave-media-staging",
      objectKey:
        "podcasts/show_fixture/episode_fixture/delivery.mp3",
      objectBytes: sourceBytes,
      etag: '"source-etag-fixture"',
      mimeType: "audio/mpeg"
    },
    recipe: {
      schemaVersion: 1,
      title: "Fixture clip",
      aspectRatio,
      templateId: "captioned-waveform-v1",
      captionLanguage: "es",
      boundaryMode: "segment",
      startsAtMs: 0,
      endsAtMs: 1_000,
      startCueId: "cue_fixture",
      endCueId: "cue_fixture",
      startWordId: null,
      endWordId: null,
      transcriptId: "transcript_fixture",
      transcriptRevision: 1,
      transcriptSha256: "b".repeat(64),
      alignmentRevisionId: null,
      captionStyle: "high-contrast-v1",
      safeArea: {
        topPercent: 8,
        rightPercent: 8,
        bottomPercent: 18,
        leftPercent: 8
      },
      durationMs: 1_000,
      outputWidth: dimensions.width,
      outputHeight: dimensions.height
    },
    captions: {
      format: "timed-text-v1",
      language: "es",
      cues: [{
        id: "cue_fixture",
        startsAtMs: 0,
        endsAtMs: 1_000,
        speakerLabel: "Jay",
        textMarkdown: "Hola {\\p1} **mundo**"
      }]
    },
    output: {
      bucketName: "dustwave-media-staging",
      objectKey: [
        "podcasts/show_fixture/episode_fixture/clips/clip_fixture",
        "revision-1/render_fixture.mp4"
      ].join("/"),
      mimeType: "video/mp4",
      requiredCustomMetadata: [
        "sha256",
        "render-manifest-sha256"
      ]
    },
    callbackUrl: [
      "https://dust-wave-podcast-staging.jogo.workers.dev/v1/processor",
      "clip-renders/render_fixture/complete"
    ].join("/")
  };
  manifest.manifestSha256 = manifestBodySha256(manifest);
  return manifest;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    ...options
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || result.stdout).trim()}`
    );
  }
}
