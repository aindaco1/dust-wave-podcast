import type { PodcastEnv } from "./env";

const MAX_GITHUB_CONTENT_BYTES = 2_000_000;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

type GitHubFilePayload = {
  content?: string;
  encoding?: string;
  sha?: string;
};

export async function readGitHubContentFile(
  env: PodcastEnv,
  path: string
): Promise<{ content: string; sha: string } | null> {
  const response = await fetch(githubContentsUrl(env, path, true), {
    headers: githubHeaders(env),
    redirect: "error",
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({})) as GitHubFilePayload;
  if (
    !response.ok
    || data.encoding !== "base64"
    || !data.content
    || !data.sha
    || data.content.length > Math.ceil(MAX_GITHUB_CONTENT_BYTES * 4 / 3) + 8
  ) {
    throw new Error(`Unable to read GitHub content (${response.status})`);
  }
  const content = decodeBase64Utf8(data.content);
  if (new TextEncoder().encode(content).byteLength > MAX_GITHUB_CONTENT_BYTES) {
    throw new Error("GitHub content exceeds the bounded file size");
  }
  return { content, sha: data.sha };
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
  if (
    new TextEncoder().encode(input.content).byteLength
    > MAX_GITHUB_CONTENT_BYTES
  ) {
    throw new Error("GitHub content exceeds the bounded file size");
  }
  const response = await fetch(githubContentsUrl(env, input.path, false), {
    method: "PUT",
    headers: {
      ...githubHeaders(env),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      message: input.message,
      content: encodeBase64Utf8(input.content),
      branch: env.GITHUB_REF || "main",
      ...(input.sha ? { sha: input.sha } : {})
    }),
    redirect: "error",
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({})) as {
    commit?: { sha?: string };
  };
  if (!response.ok || !payload.commit?.sha) {
    throw new Error(`Unable to publish GitHub content (${response.status})`);
  }
  return { commitSha: payload.commit.sha };
}

function githubContentsUrl(
  env: PodcastEnv,
  path: string,
  includeRef: boolean
): string {
  const owner = env.GITHUB_OWNER || "aindaco1";
  const repo = env.GITHUB_REPO || "dust-wave-new";
  const ref = encodeURIComponent(env.GITHUB_REF || "main");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const base = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  return includeRef ? `${base}?ref=${ref}` : base;
}

function githubHeaders(env: PodcastEnv): Record<string, string> {
  return {
    ...(env.GITHUB_TOKEN
      ? { authorization: `Bearer ${env.GITHUB_TOKEN}` }
      : {}),
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dust-wave-podcast-worker"
  };
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
