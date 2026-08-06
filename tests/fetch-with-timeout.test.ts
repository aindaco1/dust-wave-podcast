import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "../src/fetch-with-timeout";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("provider fetch timeout", () => {
  it("validates timeout ownership and duration", async () => {
    await expect(fetchWithTimeout("https://provider.example", {}, 0)).rejects.toThrow(
      new TypeError("timeoutMs must be a positive integer")
    );
    await expect(
      fetchWithTimeout(
        "https://provider.example",
        { signal: new AbortController().signal },
        1_000
      )
    ).rejects.toThrow(
      new TypeError("fetchWithTimeout manages its own abort signal")
    );
  });

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

  it("clears the deadline after provider success", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

    await fetchWithTimeout("https://provider.example", {}, 1_000);

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a provider failure", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider failed"));

    await expect(
      fetchWithTimeout("https://provider.example", {}, 1_000)
    ).rejects.toThrow("provider failed");

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
