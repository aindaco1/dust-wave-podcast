#!/usr/bin/env node

import { spawn } from "node:child_process";
import { stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SAMPLE_INTERVAL_MS = 1_000;
const MEGABYTE = 1024 * 1024;

export async function runWithDiskSampling(args = process.argv.slice(2)) {
  const separator = args.indexOf("--");
  const outputIndex = args.indexOf("--output");
  const inputIndex = args.indexOf("--existing-input");
  if (
    separator < 0
    || outputIndex < 0
    || inputIndex < 0
    || outputIndex + 1 >= separator
    || inputIndex + 1 >= separator
    || separator + 1 >= args.length
  ) {
    throw new Error(
      "Usage: run-with-disk-sampling --output FILE "
      + "--existing-input FILE -- COMMAND [ARG ...]"
    );
  }
  const output = path.resolve(args[outputIndex + 1]);
  const existingInput = path.resolve(args[inputIndex + 1]);
  const command = args[separator + 1];
  const commandArgs = args.slice(separator + 2);
  const baselineBytes = await usedFilesystemBytes(process.cwd());
  const inputStats = await stat(existingInput);
  if (!inputStats.isFile() || inputStats.size <= 0) {
    throw new Error("The measured alignment input must be a non-empty file.");
  }
  let peakUsedBytes = baselineBytes;
  let sampleError = null;
  let samplePromise = Promise.resolve();
  const sample = () => {
    samplePromise = samplePromise
      .then(async () => {
        peakUsedBytes = Math.max(
          peakUsedBytes,
          await usedFilesystemBytes(process.cwd())
        );
      })
      .catch((error) => {
        sampleError ??= error;
      });
    return samplePromise;
  };
  const timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
  timer.unref();
  let exitCode;
  try {
    exitCode = await runCommand(command, commandArgs);
    await sample();
  } finally {
    clearInterval(timer);
  }
  if (sampleError) {
    throw new Error("Filesystem usage sampling failed.", {
      cause: sampleError
    });
  }
  const measuredBytes = inputStats.size
    + Math.max(0, peakUsedBytes - baselineBytes);
  const measurement = {
    schemaVersion: "alignment-disk-measurement-v1",
    method: "filesystem-delta-plus-input-v1",
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    peakDiskMb: Math.round((measuredBytes / MEGABYTE) * 1_000) / 1_000
  };
  if (!(measurement.peakDiskMb > 0)) {
    throw new Error("The measured alignment disk footprint is invalid.");
  }
  await writeFile(output, `${JSON.stringify(measurement)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  if (exitCode !== 0) {
    throw new Error("The measured command failed.");
  }
  return measurement;
}

export function filesystemUsedBytes(stats) {
  const blockSize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const freeBlocks = Number(stats.bfree);
  const used = (blocks - freeBlocks) * blockSize;
  if (!Number.isSafeInteger(used) || used < 0) {
    throw new Error("Filesystem usage measurement is invalid.");
  }
  return used;
}

async function usedFilesystemBytes(target) {
  return filesystemUsedBytes(await statfs(target));
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error("The measured command was interrupted."));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  await runWithDiskSampling();
}
