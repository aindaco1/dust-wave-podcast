import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
export const wrangler = path.resolve(
  repositoryRoot,
  "node_modules/.bin/wrangler"
);
const workerConfigPath = path.resolve(repositoryRoot, "wrangler.jsonc");

export function loadWorkerConfig() {
  try {
    return JSON.parse(readFileSync(workerConfigPath, "utf8"));
  } catch {
    throw new Error("The Worker configuration could not be read as JSON.");
  }
}

export function runJson(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: options.maxBufferBytes ?? 4 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: "1"
    }
  });
  const failureLabel = options.failureLabel ?? "read-only staging command";
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} ${failureLabel} failed.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${path.basename(command)} returned invalid JSON.`);
  }
}
