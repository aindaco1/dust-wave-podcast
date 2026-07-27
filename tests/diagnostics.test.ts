import { describe, expect, it } from "vitest";

import syntheticFixture from "../config/virtual-audio-synthetic-fixture.json";
import type { PodcastEnv } from "../src/env";
import {
  manageStagingVirtualAudioFixtureObject,
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
    expect(
      serveStagingVirtualAudioPlayer({
        ENVIRONMENT: "staging"
      } as PodcastEnv).status
    ).toBe(404);
  });

  it("serves a no-store, staging-only player without embedding a token", async () => {
    const response = serveStagingVirtualAudioPlayer({
      ENVIRONMENT: "staging",
      VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN: "b".repeat(32)
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
    const bytesByKey: Record<string, Uint8Array> = Object.fromEntries([
      ...syntheticFixture.sources.map((source) => [
        source.objectKey,
        new Uint8Array(source.bytes)
      ]),
      [
        syntheticFixture.assemblies.virtual.objectKey,
        new Uint8Array(syntheticFixture.assemblies.virtual.bytes)
      ]
    ]);
    const reads: Array<{ key: string; offset: number; length: number }> = [];
    const bucket = {
      async get(key: string, options: R2GetOptions) {
        const source = bytesByKey[key];
        if (!source) return null;
        const range = options.range as { offset: number; length: number };
        reads.push({ key, ...range });
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
      `bytes 80664-80668/${syntheticFixture.assemblies.virtual.bytes}`
    );
    expect((await response.arrayBuffer()).byteLength).toBe(5);

    const baseline = await serveStagingVirtualAudioDiagnostic(
      new Request("https://example.test/fixture", {
        headers: { range: "bytes=80664-80668" }
      }),
      env,
      "b".repeat(32),
      "baseline"
    );
    expect(baseline.status).toBe(206);
    expect(baseline.headers.get("content-range")).toBe(
      `bytes 80664-80668/${syntheticFixture.assemblies.virtual.bytes}`
    );
    expect(reads.at(-1)).toEqual({
      key: syntheticFixture.assemblies.virtual.objectKey,
      offset: 80_664,
      length: 5
    });
  });

  it("bounds exact fixture-object setup and keeps it staging-token-only", async () => {
    const fixture = syntheticFixture.sources[0];
    const objects = new Map<string, Uint8Array>([
      [fixture.objectKey, new Uint8Array(fixture.bytes)]
    ]);
    let puts = 0;
    const bucket = {
      async get(key: string) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return {
          size: bytes.byteLength,
          async arrayBuffer() {
            return bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            );
          }
        };
      },
      async put() {
        puts += 1;
        throw new Error("Mismatched bytes must not be stored.");
      },
      async delete(key: string) {
        objects.delete(key);
      }
    } as unknown as R2Bucket;
    const env = {
      ENVIRONMENT: "staging",
      VIRTUAL_AUDIO_DIAGNOSTIC_TOKEN: "b".repeat(32),
      MEDIA_BUCKET: bucket
    } as PodcastEnv;
    const objectUrl =
      `https://example.test/v1/diagnostics/virtual-audio/${"b".repeat(32)}`
      + `/objects/${fixture.filename}`;

    const hidden = await manageStagingVirtualAudioFixtureObject(
      new Request(objectUrl),
      env,
      "a".repeat(32),
      fixture.filename
    );
    expect(hidden.status).toBe(404);

    const mismatched = await manageStagingVirtualAudioFixtureObject(
      new Request(objectUrl, {
        method: "GET"
      }),
      env,
      "b".repeat(32),
      fixture.filename
    );
    expect(mismatched.status).toBe(200);
    expect(await mismatched.json()).toMatchObject({
      filename: fixture.filename,
      bytes: fixture.bytes,
      matches: false
    });

    const rejected = await manageStagingVirtualAudioFixtureObject(
      new Request(objectUrl, {
        method: "PUT",
        headers: {
          "content-length": String(fixture.bytes),
          "content-type": "audio/mpeg"
        },
        body: new Uint8Array(fixture.bytes)
      }),
      env,
      "b".repeat(32),
      fixture.filename
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "fixture_contract_mismatch"
    });
    expect(puts).toBe(0);

    const deleted = await manageStagingVirtualAudioFixtureObject(
      new Request(objectUrl, { method: "DELETE" }),
      env,
      "b".repeat(32),
      fixture.filename
    );
    expect(deleted.status).toBe(204);
    expect(objects.has(fixture.objectKey)).toBe(false);
  });
});
