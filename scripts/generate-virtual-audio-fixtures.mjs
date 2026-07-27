import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import contract from "../config/virtual-audio-synthetic-fixture.json"
  with { type: "json" };

process.umask(0o077);
const requestedDirectory = process.argv[2];
if (!requestedDirectory) {
  throw new Error(
    "Pass an explicit output directory: npm run fixtures:virtual-audio -- /absolute/path"
  );
}
const outputDirectory = resolve(requestedDirectory);
await mkdir(outputDirectory, { recursive: true });
if ((await readdir(outputDirectory)).length !== 0) {
  throw new Error("The fixture output directory must be empty.");
}

assertContract();
const { profile, sources } = contract;

for (const source of sources) {
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${source.frequencyHz}:sample_rate=44100:duration=${source.durationSeconds}`,
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
const sourceById = Object.fromEntries(
  sources.map((source) => [source.id, source])
);
for (const assembly of Object.values(contract.assemblies)) {
  const bytes = Buffer.concat(
    assembly.sourceIds.map((sourceId) => {
      const source = sourceById[sourceId];
      if (!source) throw new Error(`Unknown fixture source: ${sourceId}`);
      return fileBytes[source.filename];
    })
  );
  await writeFile(resolve(outputDirectory, assembly.filename), bytes);
  fileBytes[assembly.filename] = bytes;
}

for (const filename of Object.values(contract.assemblies).map(
  ({ filename }) => filename
)) {
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

const declaredArtifacts = [
  ...sources,
  ...Object.values(contract.assemblies)
];
const artifacts = await Promise.all(
  declaredArtifacts.map(async ({ filename, bytes: expectedBytes, sha256 }) => {
    const path = resolve(outputDirectory, filename);
    const bytes = await readFile(path);
    const artifact = {
      filename,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      probe: probe(path)
    };
    if (
      artifact.bytes !== expectedBytes
      || artifact.sha256 !== sha256
    ) {
      throw new Error(
        `Generated fixture ${filename} does not match the versioned contract.`
      );
    }
    return artifact;
  })
);
const byFilename = Object.fromEntries(
  artifacts.map((artifact) => [artifact.filename, artifact])
);
const manifest = {
  schemaVersion: contract.schemaVersion,
  generatedAt: new Date().toISOString(),
  generator: basename(import.meta.filename),
  profile,
  contract: {
    contentType: contract.contentType,
    validatedAt: contract.validatedAt
  },
  artifacts,
  virtualManifest: {
    schemaVersion: "1",
    id: contract.manifest.id,
    episodeId: contract.manifest.episodeId,
    decisionId: contract.manifest.decisionId,
    etag: `"${contract.assemblies.virtual.sha256}"`,
    contentType: contract.contentType,
    streamProfile: profile,
    validatedAt: contract.validatedAt,
    segments: sources.map((source) =>
      segment(source, byFilename[source.filename])
    )
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
    virtualBytes: contract.assemblies.virtual.bytes,
    evidence: resolve(outputDirectory, "evidence.json")
  })}\n`
);

function segment(source, artifact) {
  return {
    id: source.id,
    kind: source.kind,
    objectKey: source.objectKey,
    objectBytes: artifact.bytes,
    sourceOffset: 0,
    byteLength: artifact.bytes,
    contentType: "audio/mpeg",
    streamProfile: profile
  };
}

function assertContract() {
  if (
    contract.schemaVersion !== "dust-wave-virtual-audio-fixture-v1"
    || contract.contentType !== "audio/mpeg"
    || !Array.isArray(contract.sources)
    || contract.sources.length !== 3
  ) {
    throw new Error("Unsupported virtual-audio synthetic fixture contract.");
  }
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
