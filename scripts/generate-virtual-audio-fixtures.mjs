import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const requestedDirectory = process.argv[2];
if (!requestedDirectory) {
  throw new Error(
    "Pass an explicit output directory: npm run fixtures:virtual-audio -- /absolute/path"
  );
}
const outputDirectory = resolve(requestedDirectory);
await mkdir(outputDirectory, { recursive: true });

const profile = "mp3-44100-stereo-cbr128-raw-frames-v1";
const sources = [
  { filename: "program-pre.mp3", frequency: 440, duration: 5 },
  { filename: "direct-ad.mp3", frequency: 880, duration: 2 },
  { filename: "program-post.mp3", frequency: 554, duration: 5 }
];

for (const source of sources) {
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${source.frequency}:sample_rate=44100:duration=${source.duration}`,
    "-map_metadata",
    "-1",
    "-ac",
    "2",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-write_xing",
    "0",
    "-id3v2_version",
    "0",
    resolve(outputDirectory, source.filename)
  ]);
}

const fileBytes = Object.fromEntries(
  await Promise.all(
    sources.map(async ({ filename }) => [
      filename,
      await readFile(resolve(outputDirectory, filename))
    ])
  )
);
const programOnly = Buffer.concat([
  fileBytes["program-pre.mp3"],
  fileBytes["program-post.mp3"]
]);
const virtualMidroll = Buffer.concat([
  fileBytes["program-pre.mp3"],
  fileBytes["direct-ad.mp3"],
  fileBytes["program-post.mp3"]
]);
await writeFile(resolve(outputDirectory, "program-only.mp3"), programOnly);
await writeFile(resolve(outputDirectory, "virtual-midroll.mp3"), virtualMidroll);

for (const filename of ["program-only.mp3", "virtual-midroll.mp3"]) {
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    resolve(outputDirectory, filename),
    "-f",
    "null",
    "-"
  ]);
}

const artifacts = await Promise.all(
  [
    ...sources.map(({ filename }) => filename),
    "program-only.mp3",
    "virtual-midroll.mp3"
  ].map(async (filename) => {
    const path = resolve(outputDirectory, filename);
    const bytes = await readFile(path);
    return {
      filename,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      probe: probe(path)
    };
  })
);
const byFilename = Object.fromEntries(
  artifacts.map((artifact) => [artifact.filename, artifact])
);
const manifest = {
  schemaVersion: "1",
  generatedAt: new Date().toISOString(),
  generator: basename(import.meta.filename),
  profile,
  artifacts,
  virtualManifest: {
    schemaVersion: "1",
    id: "synthetic-midroll-fixture",
    episodeId: "synthetic-episode",
    decisionId: "synthetic-direct-ad-decision",
    etag: `"${byFilename["virtual-midroll.mp3"].sha256}"`,
    contentType: "audio/mpeg",
    streamProfile: profile,
    validatedAt: new Date().toISOString(),
    segments: [
      segment("program-pre", "program", byFilename["program-pre.mp3"]),
      segment("direct-ad", "direct_ad", byFilename["direct-ad.mp3"]),
      segment("program-post", "program", byFilename["program-post.mp3"])
    ]
  }
};
await writeFile(
  resolve(outputDirectory, "evidence.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);

process.stdout.write(
  `${JSON.stringify({
    outputDirectory,
    profile,
    virtualBytes: byFilename["virtual-midroll.mp3"].bytes,
    evidence: resolve(outputDirectory, "evidence.json")
  })}\n`
);

function segment(id, kind, artifact) {
  return {
    id,
    kind,
    objectKey: `fixtures/virtual-audio/${artifact.filename}`,
    objectBytes: artifact.bytes,
    sourceOffset: 0,
    byteLength: artifact.bytes,
    contentType: "audio/mpeg",
    streamProfile: profile
  };
}

function probe(path) {
  const result = run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=codec_name,sample_rate,channels,bit_rate",
    "-of",
    "json",
    path
  ]);
  return JSON.parse(result.stdout);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr.trim()}`
    );
  }
  return result;
}
