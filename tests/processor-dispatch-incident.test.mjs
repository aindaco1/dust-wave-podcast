import { describe, expect, it, vi } from "vitest";

import {
  reconcileProcessorDispatchIncident
} from "../scripts/lib/processor-dispatch-incident.mjs";

const base = {
  githubToken: "github_token_fixture",
  repository: "aindaco1/dust-wave-podcast",
  runId: "30691497945",
  serverUrl: "https://github.com"
};
const emptyLedger = {
  total: 0,
  queued: 0,
  leased: 0,
  dispatched: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0
};
const marker = "<!-- dust-wave-processor-dispatch-incident-v1 -->";

describe("processor dispatch incident automation", () => {
  it("opens one content-free issue for terminal failures", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/search/issues?")) {
        expect(init.headers["x-github-api-version"]).toBe("2026-03-10");
        return Response.json({ items: [] });
      }
      if (String(url).endsWith("/issues") && init.method === "POST") {
        const body = JSON.parse(init.body);
        expect(body.title).toBe(
          "[Podcast automation] Processor dispatch failures"
        );
        expect(body.body).toContain("Terminal failures: 1");
        expect(body.body).toContain(marker);
        expect(body.body).not.toContain("target_fixture");
        expect(body.body).not.toContain("a".repeat(64));
        expect(body.body).not.toContain("listener@example.com");
        return Response.json({ number: 17 }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(reconcileProcessorDispatchIncident({
      ...base,
      fetchImpl,
      ledger: { ...emptyLedger, total: 1, failed: 1 }
    })).resolves.toEqual({ action: "opened", issueNumber: 17 });
    expect(requests).toHaveLength(2);
  });

  it("closes the owned issue automatically after recovery", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).includes("/search/issues?")) {
        return Response.json({
          items: [{
            number: 17,
            title: "[Podcast automation] Processor dispatch failures",
            body: `Prior evidence\n${marker}`
          }]
        });
      }
      if (String(url).endsWith("/issues/17") && init.method === "PATCH") {
        expect(JSON.parse(init.body)).toMatchObject({
          state: "closed",
          state_reason: "completed"
        });
        return Response.json({ number: 17, state: "closed" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(reconcileProcessorDispatchIncident({
      ...base,
      fetchImpl,
      ledger: emptyLedger
    })).resolves.toEqual({ action: "closed", issueNumber: 17 });
  });

  it("ignores similarly titled issues without the ownership marker", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("/search/issues?")) {
        return Response.json({
          items: [{
            number: 9,
            title: "[Podcast automation] Processor dispatch failures",
            body: "Human-authored issue"
          }]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await expect(reconcileProcessorDispatchIncident({
      ...base,
      fetchImpl,
      ledger: emptyLedger
    })).resolves.toEqual({ action: "none", issueNumber: null });
  });
});
