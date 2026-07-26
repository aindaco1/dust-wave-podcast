import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "../src/fetch-with-timeout";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("provider fetch timeout", () => {
  it("passes a managed abort signal to fetch", async () => {
    const response = new Response(null, { status: 204 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(
      fetchWithTimeout("https://provider.example", { method: "POST" }, 1_000)
    ).resolves.toBe(response);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("aborts a provider request after the configured deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })
    );

    const request = fetchWithTimeout(
      "https://provider.example",
      {},
      1_000
    );
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError"
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
  });
});
