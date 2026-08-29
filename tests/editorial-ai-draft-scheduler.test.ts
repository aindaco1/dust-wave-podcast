import { describe, expect, it, vi } from "vitest";

import { scheduleEditorialAiDrafts } from "../src/editorial-ai-draft-scheduler";

describe("editorial AI draft scheduler", () => {
  it("does not inspect sources while automation is disabled", async () => {
    const loadSources = vi.fn(async () => ({ results: [] }));
    expect(await scheduleEditorialAiDrafts({
      enabled: false,
      maximumAttempts: 4,
      loadSources,
      generate: vi.fn(),
      scanFailedEvent: "scan_failed",
      generationFailedEvent: "generation_failed"
    })).toBe(0);
    expect(loadSources).not.toHaveBeenCalled();
  });

  it("deduplicates languages and counts only non-skipped attempts", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce("skipped")
      .mockResolvedValueOnce("ready")
      .mockResolvedValueOnce("failed");
    const generated = await scheduleEditorialAiDrafts({
      enabled: true,
      maximumAttempts: 2,
      loadSources: async () => ({ results: [
        {
          episode_id: "episode_1",
          source_language: "es" as const,
          show_language: "es"
        },
        {
          episode_id: "episode_2",
          source_language: "en" as const,
          show_language: "es"
        },
        {
          episode_id: "episode_3",
          source_language: "en" as const,
          show_language: "en"
        }
      ] }),
      generate,
      scanFailedEvent: "scan_failed",
      generationFailedEvent: "generation_failed"
    });

    expect(generated).toBe(1);
    expect(generate.mock.calls.map(([, language]) => language)).toEqual([
      "es",
      "en",
      "es"
    ]);
  });

  it("records bounded scan and generation failures and continues", async () => {
    const scanLog = vi.fn();
    expect(await scheduleEditorialAiDrafts({
      enabled: true,
      maximumAttempts: 1,
      loadSources: async () => {
        throw new TypeError("private provider detail");
      },
      generate: vi.fn(),
      scanFailedEvent: "scan_failed",
      generationFailedEvent: "generation_failed",
      logError: scanLog
    })).toBe(0);
    expect(scanLog).toHaveBeenCalledWith({
      level: "error",
      event: "scan_failed",
      errorName: "TypeError"
    });

    const generationLog = vi.fn();
    const generated = await scheduleEditorialAiDrafts({
      enabled: true,
      maximumAttempts: 1,
      loadSources: async () => ({ results: [
        {
          episode_id: "episode_1",
          source_language: "en" as const,
          show_language: "en"
        },
        {
          episode_id: "episode_2",
          source_language: "es" as const,
          show_language: "es"
        }
      ] }),
      generate: vi.fn()
        .mockRejectedValueOnce(new RangeError("private provider detail"))
        .mockResolvedValueOnce("ready"),
      scanFailedEvent: "scan_failed",
      generationFailedEvent: "generation_failed",
      logError: generationLog
    });
    expect(generated).toBe(1);
    expect(generationLog).toHaveBeenCalledWith({
      level: "error",
      event: "generation_failed",
      episodeId: "episode_1",
      outputLanguage: "en",
      errorName: "RangeError"
    });
  });
});
