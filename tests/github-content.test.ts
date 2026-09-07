import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  readGitHubContentFile,
  writeGitHubContentFile
} from "../src/github-content";

const stagingWebsite = {
  GITHUB_OWNER: "aindaco1",
  GITHUB_REPO: "dust-wave-new",
  GITHUB_REF: "a".repeat(40)
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bounded GitHub Contents client", () => {
  it("reads the exact configured ref without requiring write credentials", async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) => Response.json({
      encoding: "base64",
      content: btoa('[{"id":"show_fixture"}]\n'),
      sha: "a".repeat(40)
    }));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      GITHUB_OWNER: "aindaco1",
      GITHUB_REPO: "dust-wave-new",
      GITHUB_REF: stagingWebsite.GITHUB_REF
    } as unknown as PodcastEnv;

    await expect(
      readGitHubContentFile(env, "src/_data/podcastShows.json")
    ).resolves.toEqual({
      content: '[{"id":"show_fixture"}]\n',
      sha: "a".repeat(40)
    });
    const [url] = fetchMock.mock.calls[0];
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new URL(String(url)).searchParams.get("ref"))
      .toBe(stagingWebsite.GITHUB_REF);
    expect(init.headers).not.toHaveProperty("authorization");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not fall back to main when the configured preview is unavailable", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(null, { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(readGitHubContentFile(
      stagingWebsite as unknown as PodcastEnv,
      "src/_data/podcastShows.json"
    )).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("ref"))
      .toBe(stagingWebsite.GITHUB_REF);
  });

  it("requires write credentials before making a provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(writeGitHubContentFile({} as PodcastEnv, {
      path: "src/_data/podcastShows.json",
      content: "[]\n",
      sha: "a".repeat(40),
      message: "Fixture"
    })).rejects.toThrow("GitHub publishing is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds a write to the reviewed blob SHA and configured branch", async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) => Response.json({
      commit: { sha: "b".repeat(40) }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      GITHUB_OWNER: "aindaco1",
      GITHUB_REPO: "dust-wave-new",
      GITHUB_REF: "staging/review",
      GITHUB_TOKEN: "github_fixture_token"
    } as unknown as PodcastEnv;

    await expect(writeGitHubContentFile(env, {
      path: "src/_data/podcastShows.json",
      content: '[{"id":"show_fixture"}]\n',
      sha: "a".repeat(40),
      message: "Project fixture"
    })).resolves.toEqual({ commitSha: "b".repeat(40) });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({
      authorization: "Bearer github_fixture_token",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(init.body))).toEqual({
      message: "Project fixture",
      content: btoa('[{"id":"show_fixture"}]\n'),
      branch: "staging/review",
      sha: "a".repeat(40)
    });
  });
});
