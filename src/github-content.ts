import { createGitHubClient } from "@dustwave/worker-core/github";

import type { PodcastEnv } from "./env";

const MAX_GITHUB_CONTENT_BYTES = 2_000_000;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

function getClient(env: PodcastEnv) {
  return createGitHubClient({
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER || "aindaco1",
    repo: env.GITHUB_REPO || "dust-wave-new",
    ref: env.GITHUB_REF || "main",
    userAgent: "dust-wave-podcast-worker",
    timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
    maxContentBytes: MAX_GITHUB_CONTENT_BYTES
  });
}

export async function readGitHubContentFile(
  env: PodcastEnv,
  path: string
): Promise<{ content: string; sha: string } | null> {
  const result = await getClient(env).getTextFile(path);
  if (!result.ok) {
    if (result.status === 404) return null;
    throw new Error(`Unable to read GitHub content (${result.status})`);
  }
  return { content: result.content, sha: result.sha };
}

export async function writeGitHubContentFile(
  env: PodcastEnv,
  input: {
    path: string;
    content: string;
    sha?: string;
    message: string;
  }
): Promise<{ commitSha: string }> {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GitHub publishing is not configured");
  }
  const result = await getClient(env).putTextFile(
    input.path,
    input.content,
    input.message,
    input.sha
  );
  if (!result.ok) {
    throw new Error(`Unable to publish GitHub content (${result.status})`);
  }
  if (!result.commitSha) throw new Error("Unable to publish GitHub content (502)");
  return { commitSha: result.commitSha };
}
