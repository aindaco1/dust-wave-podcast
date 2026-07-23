import { describe, expect, it } from "vitest";

import {
  compileVirtualMediaManifest,
  mapVirtualByteRange,
  parseVirtualByteRange,
  serveVirtualMedia,
  type VirtualMediaManifest
} from "../src/virtual-media";

describe("virtual media assembly", () => {
  it("maps a cross-segment range and merges contiguous windows in one object", () => {
    const manifest = compileVirtualMediaManifest(createManifest());
    const range = {
      startsAt: 3,
      endsAt: 16,
      length: 14
    };

    expect(mapVirtualByteRange(manifest, range)).toEqual([
      {
        objectKey: "program.mp3",
        sourceOffset: 3,
        byteLength: 5,
        segmentIds: ["program-pre"]
      },
      {
        objectKey: "ad.mp3",
        sourceOffset: 0,
        byteLength: 6,
        segmentIds: ["midroll"]
      },
      {
        objectKey: "program.mp3",
        sourceOffset: 8,
        byteLength: 3,
        segmentIds: ["program-post-a", "program-post-b"]
      }
    ]);
  });

  it("parses bounded, open-ended, and suffix ranges but rejects multipart ranges", () => {
    expect(parseVirtualByteRange("bytes=2-5", 20)).toEqual({
      startsAt: 2,
      endsAt: 5,
      length: 4
    });
    expect(parseVirtualByteRange("bytes=18-", 20)).toEqual({
      startsAt: 18,
      endsAt: 19,
      length: 2
    });
    expect(parseVirtualByteRange("bytes=-3", 20)).toEqual({
      startsAt: 17,
      endsAt: 19,
      length: 3
    });
    expect(parseVirtualByteRange("bytes=0-1,4-5", 20)).toBe("invalid");
    expect(parseVirtualByteRange("bytes=20-", 20)).toBe("invalid");
  });

  it("streams a byte range across R2 objects with stable virtual headers", async () => {
    const objects: Record<string, Uint8Array> = {
      "program.mp3": new TextEncoder().encode("ABCDEFGHijklmnop"),
      "ad.mp3": new TextEncoder().encode("123456")
    };
    const reads: Array<{
      key: string;
      offset: number;
      length: number;
    }> = [];
    const bucket = {
      async get(key: string, options: R2GetOptions) {
        const range = options.range as { offset: number; length: number };
        reads.push({ key, ...range });
        const source = objects[key];
        if (!source) return null;
        const body = source.slice(range.offset, range.offset + range.length);
        return {
          body: new Response(body).body,
          size: source.length,
          httpEtag: `"${key}"`,
          range,
          writeHttpMetadata() {}
        };
      }
    } as unknown as R2Bucket;

    const response = await serveVirtualMedia(
      new Request("https://media.dustwave.xyz/decision/example", {
        headers: { range: "bytes=6-14" }
      }),
      bucket,
      createManifest()
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 6-14/22");
    expect(response.headers.get("content-length")).toBe("9");
    expect(response.headers.get("etag")).toBe('"decision-revision-1"');
    expect(await response.text()).toBe("GH123456i");
    expect(reads).toEqual([
      { key: "program.mp3", offset: 6, length: 2 },
      { key: "ad.mp3", offset: 0, length: 6 },
      { key: "program.mp3", offset: 8, length: 1 }
    ]);
  });

  it("falls back to a full response when If-Range does not match", async () => {
    const chunks: Record<string, Uint8Array> = {
      "program.mp3": new TextEncoder().encode("ABCDEFGHijklmnop"),
      "ad.mp3": new TextEncoder().encode("123456")
    };
    const bucket = {
      async get(key: string, options: R2GetOptions) {
        const range = options.range as { offset: number; length: number };
        const body = chunks[key].slice(
          range.offset,
          range.offset + range.length
        );
        return {
          body: new Response(body).body,
          size: chunks[key].length,
          httpEtag: `"${key}"`,
          range,
          writeHttpMetadata() {}
        };
      }
    } as unknown as R2Bucket;
    const response = await serveVirtualMedia(
      new Request("https://media.dustwave.xyz/decision/example", {
        headers: {
          range: "bytes=2-4",
          "if-range": '"stale-decision"'
        }
      }),
      bucket,
      createManifest()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-length")).toBe("22");
    expect(await response.text()).toBe("ABCDEFGH123456ijklmnop");
  });

  it("returns a bodyless conditional response for a matching decision", async () => {
    const response = await serveVirtualMedia(
      new Request("https://media.dustwave.xyz/decision/example", {
        headers: { "if-none-match": 'W/"decision-revision-1"' }
      }),
      {} as R2Bucket,
      createManifest()
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"decision-revision-1"');
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("fails closed on unvalidated or incompatible media windows", async () => {
    const incompatible = createManifest();
    incompatible.segments[1].streamProfile = "different-profile";

    expect(() => compileVirtualMediaManifest(incompatible)).toThrow(
      "does not match the validated stream profile"
    );

    const outOfBounds = createManifest();
    outOfBounds.segments[0].byteLength = 17;
    expect(() => compileVirtualMediaManifest(outOfBounds)).toThrow(
      "invalid or out-of-bounds byte window"
    );

    const response = await serveVirtualMedia(
      new Request("https://media.dustwave.xyz/decision/example"),
      {} as R2Bucket,
      incompatible
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "virtual_media_not_ready" });
  });
});

function createManifest(): VirtualMediaManifest {
  return {
    schemaVersion: "1",
    id: "manifest-1",
    episodeId: "episode-1",
    decisionId: "decision-1",
    etag: '"decision-revision-1"',
    contentType: "audio/mpeg",
    streamProfile: "mp3-44100-stereo-cbr128-frame-v1",
    validatedAt: "2026-07-23T20:00:00.000Z",
    segments: [
      {
        id: "program-pre",
        kind: "program",
        objectKey: "program.mp3",
        objectBytes: 16,
        sourceOffset: 0,
        byteLength: 8,
        contentType: "audio/mpeg",
        streamProfile: "mp3-44100-stereo-cbr128-frame-v1"
      },
      {
        id: "midroll",
        kind: "direct_ad",
        objectKey: "ad.mp3",
        objectBytes: 6,
        sourceOffset: 0,
        byteLength: 6,
        contentType: "audio/mpeg",
        streamProfile: "mp3-44100-stereo-cbr128-frame-v1"
      },
      {
        id: "program-post-a",
        kind: "program",
        objectKey: "program.mp3",
        objectBytes: 16,
        sourceOffset: 8,
        byteLength: 2,
        contentType: "audio/mpeg",
        streamProfile: "mp3-44100-stereo-cbr128-frame-v1"
      },
      {
        id: "program-post-b",
        kind: "program",
        objectKey: "program.mp3",
        objectBytes: 16,
        sourceOffset: 10,
        byteLength: 6,
        contentType: "audio/mpeg",
        streamProfile: "mp3-44100-stereo-cbr128-frame-v1"
      }
    ]
  };
}
