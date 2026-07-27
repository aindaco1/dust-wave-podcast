#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import contract from "../config/virtual-audio-synthetic-fixture.json"
  with { type: "json" };

process.umask(0o077);
const STAGING_ORIGIN =
  "https://dust-wave-podcast-staging.jogo.workers.dev";
const STAGING_BUCKET = "dustwave-media-staging";
const DIAGNOSTIC_SECRET = "VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN";
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const wrangler = path.resolve(
  repositoryRoot,
  "node_modules/.bin/wrangler"
);
const options = parseOptions(process.argv.slice(2));
if (options.help === true) {
  process.stdout.write(
    "Usage: npm run gate:virtual-audio:staging -- "
    + "--output /absolute/private/evidence/directory "
    + "[--origin https://dust-wave-podcast-staging.jogo.workers.dev] "
    + "[--pairs 5000] [--concurrency 12]\n"
  );
  process.exit(0);
}
if (typeof options.output !== "string" || !path.isAbsolute(options.output)) {
  fail("--output must be an explicit absolute directory.");
}
const origin = new URL(options.origin ?? STAGING_ORIGIN);
if (origin.origin !== STAGING_ORIGIN || origin.pathname !== "/") {
  fail(`This command is restricted to ${STAGING_ORIGIN}.`);
}
const pairs = boundedInteger(options.pairs ?? "5000", "pairs", 1, 10_000);
const concurrency = boundedInteger(
  options.concurrency ?? "12",
  "concurrency",
  1,
  50
);
const outputDirectory = path.resolve(options.output);
const fixtureDirectory = path.resolve(outputDirectory, "fixtures");
const token = randomBytes(48).toString("base64url");
const uploadedObjects = [];
let diagnosticSecretInstalled = false;
let diagnosticSecretCleanupComplete = true;
let uploadedObjectCleanupComplete = true;
let cleanupPromise = null;
let cleanupComplete = false;
let completed = false;
let failureMessage = null;
let evidenceDirectoryReady = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

try {
  validateContract();
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  if ((await readdir(outputDirectory)).length !== 0) {
    throw new Error("The evidence output directory must be empty.");
  }
  evidenceDirectoryReady = true;
  run(process.execPath, [
    path.resolve(repositoryRoot, "scripts/generate-virtual-audio-fixtures.mjs"),
    fixtureDirectory
  ]);
  await secureDirectory(fixtureDirectory);

  const fixtureEvidence = JSON.parse(
    await readFile(path.resolve(fixtureDirectory, "evidence.json"), "utf8")
  );
  verifyFixtureEvidence(fixtureEvidence);
  ensureDiagnosticSecretIsAbsent();
  installDiagnosticSecret();
  await waitForDiagnostic(origin, 200);
  await preflightAndUploadObjects(fixtureDirectory);
  await waitForVirtualAudioStability();

  const childEnvironment = {
    ...process.env,
    VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN: token
  };
  run(process.execPath, [
    path.resolve(repositoryRoot, "scripts/run-virtual-audio-protocol-matrix.mjs"),
    "--origin",
    origin.origin,
    "--output",
    path.resolve(outputDirectory, "protocol-matrix.json")
  ], { env: childEnvironment });
  run(process.execPath, [
    path.resolve(repositoryRoot, "scripts/run-virtual-audio-load-gate.mjs"),
    "--origin",
    origin.origin,
    "--output",
    path.resolve(outputDirectory, "paired-load.json"),
    "--pairs",
    String(pairs),
    "--concurrency",
    String(concurrency)
  ], { env: childEnvironment });
  completed = true;
} catch (error) {
  failureMessage = error instanceof Error ? error.message : String(error);
} finally {
  await cleanup();
  if (evidenceDirectoryReady) await writeGateEvidence();
}

if (!completed || !cleanupComplete) {
  fail(
    failureMessage
      ? `gate did not complete: ${failureMessage}`
      : "gate cleanup did not complete"
  );
}
process.stdout.write(
  `Staging virtual-audio gate passed and cleaned up; evidence=${outputDirectory}\n`
);

async function preflightAndUploadObjects(sourceDirectory) {
  const objects = [
    ...contract.sources.map((source) => ({
      filename: source.filename,
      objectKey: source.objectKey,
      bytes: source.bytes,
      sha256: source.sha256
    })),
    {
      filename: contract.assemblies.virtual.filename,
      objectKey: contract.assemblies.virtual.objectKey,
      bytes: contract.assemblies.virtual.bytes,
      sha256: contract.assemblies.virtual.sha256
    }
  ];
  for (const object of objects) {
    const evidenceUrl = diagnosticObjectUrl(object.filename);
    const retrieval = await fetch(evidenceUrl, {
      redirect: "error",
      cache: "no-store"
    });
    if (retrieval.status === 200) {
      const evidence = await retrieval.json();
      if (
        !evidence
        || typeof evidence !== "object"
        || evidence.matches !== true
        || evidence.bytes !== object.bytes
        || evidence.sha256 !== object.sha256
      ) {
        throw new Error(
          `Refusing to overwrite non-matching staging object ${object.objectKey}.`
        );
      }
      continue;
    }
    if (retrieval.status !== 404) {
      throw new Error(
        `Could not preflight staging object ${object.objectKey} `
        + `(HTTP ${retrieval.status}).`
      );
    }
    const bytes = await readFile(
      path.resolve(sourceDirectory, object.filename)
    );
    uploadedObjects.push(object);
    const upload = await fetch(evidenceUrl, {
      method: "PUT",
      redirect: "error",
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": contract.contentType
      },
      body: bytes
    });
    const evidence = await upload.json().catch(() => null);
    if (
      upload.status !== 201
      || !evidence
      || typeof evidence !== "object"
      || evidence.matches !== true
      || evidence.bytes !== object.bytes
      || evidence.sha256 !== object.sha256
    ) {
      throw new Error(
        `Uploaded staging object failed verification: ${object.objectKey}.`
      );
    }
  }
}

function ensureDiagnosticSecretIsAbsent() {
  if (diagnosticSecretNamePresent()) {
    throw new Error(
      `${DIAGNOSTIC_SECRET} already exists; refusing to rotate an unknown value.`
    );
  }
}

function installDiagnosticSecret() {
  run(wrangler, [
    "secret",
    "put",
    DIAGNOSTIC_SECRET,
    "--env",
    "staging"
  ], { input: `${token}\n` });
  diagnosticSecretInstalled = true;
  diagnosticSecretCleanupComplete = false;
}

async function waitForDiagnostic(targetOrigin, expectedStatus) {
  const url = new URL(
    `/v1/diagnostics/virtual-audio/${encodeURIComponent(token)}/virtual`,
    targetOrigin
  );
  const objectUrl = diagnosticObjectUrl(contract.sources[0].filename);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const [response, objectResponse] = await Promise.all([
        fetch(url, {
          method: "HEAD",
          redirect: "error",
          cache: "no-store"
        }),
        fetch(objectUrl, {
          redirect: "error",
          cache: "no-store"
        })
      ]);
      if (
        response.status === expectedStatus
        && (
          expectedStatus !== 200
          || objectResponse.status === 200
          || objectResponse.status === 404
        )
      ) return;
    } catch {
      // Deployment propagation is retried within the bounded window.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Staging diagnostic did not reach HTTP ${expectedStatus} within 30 seconds.`
  );
}

async function waitForVirtualAudioStability() {
  const baseUrl = new URL(
    `/v1/diagnostics/virtual-audio/${encodeURIComponent(token)}/virtual`,
    origin
  );
  let consecutivePasses = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set("readiness", String(attempt));
      const response = await fetch(url, {
        redirect: "error",
        cache: "no-store",
        headers: { range: "bytes=0-0" }
      });
      const body = new Uint8Array(await response.arrayBuffer());
      if (
        response.status === 206
        && body.byteLength === 1
        && response.headers.get("content-range")
          === `bytes 0-0/${contract.assemblies.virtual.bytes}`
      ) {
        consecutivePasses += 1;
        if (consecutivePasses >= 10) return;
      } else {
        consecutivePasses = 0;
      }
    } catch {
      consecutivePasses = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    "Staging ranged audio did not stabilize for ten consecutive probes."
  );
}

async function cleanup() {
  if (!cleanupPromise) cleanupPromise = performCleanup();
  return cleanupPromise;
}

async function performCleanup() {
  for (const object of [...uploadedObjects].reverse()) {
    try {
      const deletion = await fetch(diagnosticObjectUrl(object.filename), {
        method: "DELETE",
        redirect: "error",
        cache: "no-store"
      });
      if (deletion.status !== 204) {
        uploadedObjectCleanupComplete = false;
        process.stderr.write(
          `Cleanup warning: could not delete staging object ${object.objectKey}.\n`
        );
        continue;
      }
      const verification = await fetch(
        diagnosticObjectUrl(object.filename),
        { redirect: "error", cache: "no-store" }
      );
      if (verification.status !== 404) {
        uploadedObjectCleanupComplete = false;
        process.stderr.write(
          `Cleanup warning: staging object remains ${object.objectKey}.\n`
        );
      }
    } catch {
      uploadedObjectCleanupComplete = false;
      process.stderr.write(
        `Cleanup warning: could not verify staging object ${object.objectKey}.\n`
      );
    }
  }
  if (diagnosticSecretInstalled) {
    const deletion = runResult(wrangler, [
      "secret",
      "delete",
      DIAGNOSTIC_SECRET,
      "--env",
      "staging"
    ], { input: "y\n" });
    if (deletion.status !== 0) {
      process.stderr.write(
        `Cleanup warning: could not delete ${DIAGNOSTIC_SECRET}.\n`
      );
    } else {
      diagnosticSecretInstalled = false;
      try {
        await waitForDiagnostic(origin, 404);
        if (diagnosticSecretNamePresent()) {
          throw new Error("Diagnostic secret name is still present.");
        }
        diagnosticSecretCleanupComplete = true;
      } catch {
        process.stderr.write(
          "Cleanup warning: diagnostic secret removal did not propagate.\n"
        );
      }
    }
  }
  cleanupComplete =
    uploadedObjectCleanupComplete
    && diagnosticSecretCleanupComplete;
}

function diagnosticSecretNamePresent() {
  const result = runResult(wrangler, [
    "secret",
    "list",
    "--env",
    "staging"
  ]);
  if (result.status !== 0) {
    throw new Error("Could not inspect staging Worker secret names.");
  }
  let secrets;
  try {
    secrets = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned an invalid staging secret list.");
  }
  return secrets.some((secret) => secret?.name === DIAGNOSTIC_SECRET);
}

async function writeGateEvidence() {
  const git = runResult("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot
  });
  const evidence = {
    schemaVersion: "dust-wave-virtual-audio-staging-gate-v1",
    generatedAt: new Date().toISOString(),
    sourceCommit: git.status === 0 ? git.stdout.trim() : null,
    targetOrigin: origin.origin,
    targetBucket: STAGING_BUCKET,
    scope: {
      syntheticProtocolEmulation: true,
      nativeClientValidation: false,
      pairs,
      totalMeasuredRequests: pairs * 2
    },
    result: {
      passed: completed,
      cleanupComplete,
      temporarySecretRemoved: diagnosticSecretCleanupComplete,
      uploadedObjectsRemoved: uploadedObjectCleanupComplete,
      failureCode: failureMessage ? "gate_failed" : null
    }
  };
  await writeFile(
    path.resolve(outputDirectory, "staging-gate.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600, flag: "wx" }
  );
}

async function secureDirectory(directory) {
  await chmod(directory, 0o700);
  const filenames = [
    ...contract.sources.map(({ filename }) => filename),
    ...Object.values(contract.assemblies).map(({ filename }) => filename),
    "evidence.json"
  ];
  await Promise.all(
    filenames.map((filename) =>
      chmod(path.resolve(directory, filename), 0o600)
    )
  );
}

function verifyFixtureEvidence(evidence) {
  const expected = new Map([
    ...contract.sources.map(({ filename, bytes, sha256 }) => [
      filename,
      { bytes, sha256 }
    ]),
    ...Object.values(contract.assemblies).map(
      ({ filename, bytes, sha256 }) => [
        filename,
        { bytes, sha256 }
      ]
    )
  ]);
  for (const artifact of evidence.artifacts ?? []) {
    const declared = expected.get(artifact.filename);
    if (
      declared
      && artifact.bytes === declared.bytes
      && artifact.sha256 === declared.sha256
    ) {
      expected.delete(artifact.filename);
    }
  }
  if (expected.size !== 0) {
    throw new Error("Generated fixture evidence does not match the contract.");
  }
}

function validateContract() {
  if (
    contract.schemaVersion !== "dust-wave-virtual-audio-fixture-v1"
    || contract.contentType !== "audio/mpeg"
    || contract.sources.length !== 3
    || contract.assemblies.virtual.sourceIds.join(",")
      !== contract.sources.map(({ id }) => id).join(",")
    || contract.sources.reduce((sum, source) => sum + source.bytes, 0)
      !== contract.assemblies.virtual.bytes
  ) {
    fail("The versioned virtual-audio fixture contract is invalid.");
  }
}

function run(command, args, options = {}) {
  const result = runResult(command, args, options);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed with status ${result.status}.`
    );
  }
  return result;
}

function runResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return result;
}

function diagnosticObjectUrl(filename) {
  return new URL(
    `/v1/diagnostics/virtual-audio/${encodeURIComponent(token)}`
    + `/objects/${encodeURIComponent(filename)}`,
    origin
  );
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help") {
      parsed.help = true;
      continue;
    }
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      fail("Invalid command arguments.");
    }
    parsed[flag.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function fail(message) {
  process.stderr.write(`Staging virtual-audio gate failed: ${message}\n`);
  process.exit(1);
}
