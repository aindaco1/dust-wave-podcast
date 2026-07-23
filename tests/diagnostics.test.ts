import { describe, expect, it } from "vitest";

import type { PodcastEnv } from "../src/env";
import {
  serveStagingVirtualAudioDiagnostic,
  serveStagingVirtualAudioPlayer
} from "../src/diagnostics";

describe("staging virtual-audio diagnostic", () => {
  it("is unavailable outside staging even with a matching token", async () => {
    const response = await serveStagingVirtualAudioDiagnostic(
      new Request("https://example.test/fixture"),
      {
        ENVIRONMENT: "production",
        VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN: "a".repeat(32)
      } as unknown as PodcastEnv,
      "a".repeat(32)
    );

    expect(response.status).toBe(404);
    expect(
      serveStagingVirtualAudioPlayer({
        ENVIRONMENT: "production"
      } as unknown as PodcastEnv).status
    ).toBe(404);
  });

  it("serves a no-store, staging-only player without embedding a token", async () => {
    const response = serveStagingVirtualAudioPlayer({
      ENVIRONMENT: "staging"
    } as PodcastEnv);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "media-src 'self'"
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain('type="password"');
    expect(html).not.toContain("VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN");
  });

  it("streams only when a constant-time staging token matches", async () => {
    const bytesByKey: Record<string, Uint8Array> = {
      "fixtures/virtual-audio/program-pre.mp3": new Uint8Array(80_666),
      "fixtures/virtual-audio/direct-ad.mp3": new Uint8Array(32_600),
      "fixtures/virtual-audio/program-post.mp3": new Uint8Array(80_666)
    };
    const bucket = {
      async get(key: string, options: R2GetOptions) {
        const source = bytesByKey[key];
        if (!source) return null;
        const range = options.range as { offset: number; length: number };
        return {
          body: new Response(
            source.slice(range.offset, range.offset + range.length)
          ).body,
          size: source.byteLength,
          httpEtag: `"${key}"`,
          range,
          writeHttpMetadata() {}
        };
      }
    } as unknown as R2Bucket;
    const env = {
      ENVIRONMENT: "staging",
      VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN: "b".repeat(32),
      MEDIA_BUCKET: bucket
    } as PodcastEnv;

    const hidden = await serveStagingVirtualAudioDiagnostic(
      new Request("https://example.test/fixture"),
      env,
      "a".repeat(32)
    );
    expect(hidden.status).toBe(404);

    const response = await serveStagingVirtualAudioDiagnostic(
      new Request("https://example.test/fixture", {
        headers: { range: "bytes=80664-80668" }
      }),
      env,
      "b".repeat(32)
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      "bytes 80664-80668/193932"
    );
    expect((await response.arrayBuffer()).byteLength).toBe(5);
  });
});
