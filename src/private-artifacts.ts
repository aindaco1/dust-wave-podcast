export async function putImmutablePrivateArtifact(
  bucket: R2Bucket,
  key: string,
  body: string | ArrayBuffer | ArrayBufferView,
  {
    sha256,
    maximumBytes,
    contentType,
    metadata
  }: {
    sha256: string;
    maximumBytes: number;
    contentType: string;
    metadata: Record<string, string>;
  }
): Promise<R2Object> {
  const objectBytes = bodyBytes(body);
  if (
    objectBytes < 1
    || objectBytes > maximumBytes
    || !/^[a-f0-9]{64}$/.test(sha256)
    || key.length < 1
    || key.length > 1024
    || key.startsWith("/")
    || key.includes("..")
    || contentType.length < 1
    || contentType.length > 200
  ) {
    throw new Error("Private artifact exceeds its identity contract");
  }
  const expectedMetadata = { ...metadata, sha256 };
  const existing = await bucket.head(key);
  if (existing) {
    assertImmutableObject(
      existing,
      objectBytes,
      sha256,
      expectedMetadata
    );
    return existing;
  }
  const stored = await bucket.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType,
      cacheControl: "private, no-store, max-age=0"
    },
    customMetadata: expectedMetadata,
    sha256
  });
  const verified = stored ?? await bucket.head(key);
  if (!verified) {
    throw new Error("Private artifact storage could not be verified");
  }
  assertImmutableObject(
    verified,
    objectBytes,
    sha256,
    expectedMetadata
  );
  return verified;
}

function bodyBytes(body: string | ArrayBuffer | ArrayBufferView): number {
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof ArrayBuffer) return body.byteLength;
  return body.byteLength;
}

function assertImmutableObject(
  object: R2Object,
  expectedBytes: number,
  expectedSha256: string,
  expectedMetadata: Record<string, string>
): void {
  if (
    object.size !== expectedBytes
    || object.checksums.toJSON().sha256 !== expectedSha256
    || Object.entries(expectedMetadata).some(
      ([key, value]) => object.customMetadata?.[key] !== value
    )
  ) {
    throw new Error("Private artifact identity changed");
  }
}
