import { describe, expect, it, vi } from "vitest";

import { completeMultipartUploadAndHead } from "../src/r2-multipart";

describe("R2 multipart completion", () => {
  it("validates the authoritative strongly consistent object metadata", async () => {
    const completed = {
      key: "private/output.mp3",
      size: 10,
      httpMetadata: {},
      customMetadata: {}
    };
    const authoritative = {
      ...completed,
      httpMetadata: { contentType: "audio/mpeg" },
      customMetadata: { "processor-manifest-sha256": "a".repeat(64) }
    };
    const complete = vi.fn().mockResolvedValue(completed);
    const head = vi.fn().mockResolvedValue(authoritative);
    const bucket = {
      resumeMultipartUpload: vi.fn().mockReturnValue({ complete }),
      head
    } as unknown as R2Bucket;
    const parts = [{ partNumber: 1, etag: "etag-1" }];

    await expect(completeMultipartUploadAndHead(
      bucket,
      authoritative.key,
      "upload-1",
      parts
    )).resolves.toBe(authoritative);
    expect(complete).toHaveBeenCalledWith(parts);
    expect(head).toHaveBeenCalledWith(authoritative.key);
  });
});
