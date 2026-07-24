export const MAX_VIRTUAL_MEDIA_SEGMENTS = 24;

export type VirtualMediaSegmentKind =
  | "program"
  | "house_ad"
  | "direct_ad";

export interface VirtualMediaSegment {
  id: string;
  kind: VirtualMediaSegmentKind;
  objectKey: string;
  objectEtag?: string;
  objectBytes: number;
  sourceOffset: number;
  byteLength: number;
  contentType: "audio/mpeg" | "audio/mp4";
  streamProfile: string;
}

export interface VirtualMediaManifest {
  schemaVersion: "1";
  id: string;
  episodeId: string;
  decisionId: string;
  etag: string;
  contentType: "audio/mpeg" | "audio/mp4";
  streamProfile: string;
  validatedAt: string;
  segments: VirtualMediaSegment[];
}

export interface CompiledVirtualMediaSegment extends VirtualMediaSegment {
  virtualStartsAt: number;
  virtualEndsAt: number;
}

export interface CompiledVirtualMediaManifest
  extends Omit<VirtualMediaManifest, "segments"> {
  segments: CompiledVirtualMediaSegment[];
  totalBytes: number;
}

export interface VirtualMediaLengthContract {
  schemaVersion: "equal-byte-length-v1";
  primaryBytes: number;
  fallbackBytes: number;
  equalByteLength: boolean;
}

export interface VirtualByteRange {
  startsAt: number;
  endsAt: number;
  length: number;
}

export interface VirtualObjectSpan {
  objectKey: string;
  objectEtag?: string;
  sourceOffset: number;
  byteLength: number;
  segmentIds: string[];
}

export class VirtualMediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualMediaValidationError";
  }
}

export function compileVirtualMediaManifest(
  manifest: VirtualMediaManifest
): CompiledVirtualMediaManifest {
  if (manifest.schemaVersion !== "1") {
    throw new VirtualMediaValidationError("Unsupported virtual media schema version.");
  }
  if (!manifest.id.trim() || !manifest.episodeId.trim() || !manifest.decisionId.trim()) {
    throw new VirtualMediaValidationError(
      "Manifest, episode, and decision IDs are required."
    );
  }
  if (!/^"[A-Za-z0-9._:-]{1,200}"$/.test(manifest.etag)) {
    throw new VirtualMediaValidationError(
      "A strong, quoted, decision-specific ETag is required."
    );
  }
  if (!manifest.streamProfile.trim()) {
    throw new VirtualMediaValidationError("A validated stream profile is required.");
  }
  if (manifest.contentType !== "audio/mpeg" && manifest.contentType !== "audio/mp4") {
    throw new VirtualMediaValidationError(
      "Virtual media must use a supported launch audio type."
    );
  }
  if (!Number.isFinite(Date.parse(manifest.validatedAt))) {
    throw new VirtualMediaValidationError(
      "The manifest must record when its media profile was validated."
    );
  }
  if (
    manifest.segments.length === 0
    || manifest.segments.length > MAX_VIRTUAL_MEDIA_SEGMENTS
  ) {
    throw new VirtualMediaValidationError(
      `A manifest must contain 1-${MAX_VIRTUAL_MEDIA_SEGMENTS} segments.`
    );
  }

  const segmentIds = new Set<string>();
  let totalBytes = 0;
  const segments = manifest.segments.map((segment) => {
    if (!segment.id.trim() || segmentIds.has(segment.id)) {
      throw new VirtualMediaValidationError(
        "Every virtual media segment needs a unique ID."
      );
    }
    segmentIds.add(segment.id);
    if (!segment.objectKey.trim()) {
      throw new VirtualMediaValidationError("Every segment needs an R2 object key.");
    }
    if (
      segment.objectEtag !== undefined
      && (
        !segment.objectEtag.trim()
        || segment.objectEtag.length > 300
        || /[\r\n]/.test(segment.objectEtag)
      )
    ) {
      throw new VirtualMediaValidationError(
        `Segment "${segment.id}" has an invalid object ETag.`
      );
    }
    if (!["program", "house_ad", "direct_ad"].includes(segment.kind)) {
      throw new VirtualMediaValidationError(
        `Segment "${segment.id}" has an invalid media kind.`
      );
    }
    if (
      !isSafeNonNegativeInteger(segment.sourceOffset)
      || !isSafePositiveInteger(segment.byteLength)
      || !isSafePositiveInteger(segment.objectBytes)
      || segment.sourceOffset + segment.byteLength > segment.objectBytes
    ) {
      throw new VirtualMediaValidationError(
        `Segment "${segment.id}" has an invalid or out-of-bounds byte window.`
      );
    }
    if (
      segment.contentType !== manifest.contentType
      || segment.streamProfile !== manifest.streamProfile
    ) {
      throw new VirtualMediaValidationError(
        `Segment "${segment.id}" does not match the validated stream profile.`
      );
    }
    if (!Number.isSafeInteger(totalBytes + segment.byteLength)) {
      throw new VirtualMediaValidationError("Virtual media length exceeds safe bounds.");
    }
    const virtualStartsAt = totalBytes;
    totalBytes += segment.byteLength;
    return {
      ...segment,
      virtualStartsAt,
      virtualEndsAt: totalBytes - 1
    };
  });

  return {
    ...manifest,
    segments,
    totalBytes
  };
}

export function buildVirtualMediaLengthContract(
  primary: VirtualMediaManifest,
  fallback: VirtualMediaManifest
): VirtualMediaLengthContract {
  const primaryBytes = compileVirtualMediaManifest(primary).totalBytes;
  const fallbackBytes = compileVirtualMediaManifest(fallback).totalBytes;
  return {
    schemaVersion: "equal-byte-length-v1",
    primaryBytes,
    fallbackBytes,
    equalByteLength: primaryBytes === fallbackBytes
  };
}

export function virtualMediaLengthContractMatches(
  primary: VirtualMediaManifest,
  fallback: VirtualMediaManifest,
  contract: VirtualMediaLengthContract | null | undefined
): boolean {
  if (
    !contract
    || contract.schemaVersion !== "equal-byte-length-v1"
    || !isSafePositiveInteger(contract.primaryBytes)
    || !isSafePositiveInteger(contract.fallbackBytes)
    || typeof contract.equalByteLength !== "boolean"
  ) {
    return false;
  }
  try {
    const expected = buildVirtualMediaLengthContract(primary, fallback);
    return expected.primaryBytes === contract.primaryBytes
      && expected.fallbackBytes === contract.fallbackBytes
      && expected.equalByteLength === contract.equalByteLength;
  } catch {
    return false;
  }
}

export function parseVirtualByteRange(
  header: string | null,
  totalBytes: number
): VirtualByteRange | "invalid" | null {
  if (!header) return null;
  if (!isSafePositiveInteger(totalBytes)) return "invalid";
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!isSafePositiveInteger(suffixLength)) return "invalid";
    const length = Math.min(suffixLength, totalBytes);
    return {
      startsAt: totalBytes - length,
      endsAt: totalBytes - 1,
      length
    };
  }

  const startsAt = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : totalBytes - 1;
  if (
    !isSafeNonNegativeInteger(startsAt)
    || !isSafeNonNegativeInteger(requestedEnd)
    || startsAt >= totalBytes
    || requestedEnd < startsAt
  ) {
    return "invalid";
  }
  const endsAt = Math.min(requestedEnd, totalBytes - 1);
  return {
    startsAt,
    endsAt,
    length: endsAt - startsAt + 1
  };
}

export function mapVirtualByteRange(
  manifest: CompiledVirtualMediaManifest,
  range: VirtualByteRange
): VirtualObjectSpan[] {
  if (
    !isSafeNonNegativeInteger(range.startsAt)
    || !isSafeNonNegativeInteger(range.endsAt)
    || range.endsAt < range.startsAt
    || range.endsAt >= manifest.totalBytes
    || range.length !== range.endsAt - range.startsAt + 1
  ) {
    throw new VirtualMediaValidationError("The requested virtual range is invalid.");
  }

  const spans: VirtualObjectSpan[] = [];
  for (const segment of manifest.segments) {
    const overlapStart = Math.max(range.startsAt, segment.virtualStartsAt);
    const overlapEnd = Math.min(range.endsAt, segment.virtualEndsAt);
    if (overlapStart > overlapEnd) continue;

    const sourceOffset =
      segment.sourceOffset + overlapStart - segment.virtualStartsAt;
    const byteLength = overlapEnd - overlapStart + 1;
    const prior = spans.at(-1);
    if (
      prior
      && prior.objectKey === segment.objectKey
      && prior.objectEtag === segment.objectEtag
      && prior.sourceOffset + prior.byteLength === sourceOffset
    ) {
      prior.byteLength += byteLength;
      prior.segmentIds.push(segment.id);
    } else {
      spans.push({
        objectKey: segment.objectKey,
        ...(segment.objectEtag
          ? { objectEtag: segment.objectEtag }
          : {}),
        sourceOffset,
        byteLength,
        segmentIds: [segment.id]
      });
    }
  }

  const mappedBytes = spans.reduce(
    (total, span) => total + span.byteLength,
    0
  );
  if (mappedBytes !== range.length) {
    throw new VirtualMediaValidationError(
      "The virtual range did not map to a complete object span."
    );
  }
  return spans;
}

export async function serveVirtualMedia(
  request: Request,
  bucket: R2Bucket,
  sourceManifest: VirtualMediaManifest
): Promise<Response> {
  let manifest: CompiledVirtualMediaManifest;
  try {
    manifest = compileVirtualMediaManifest(sourceManifest);
  } catch {
    return virtualMediaError("virtual_media_not_ready", 503);
  }

  const headers = virtualMediaHeaders(manifest);
  if (etagMatches(request.headers.get("if-none-match"), manifest.etag)) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }

  const requestedRange = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const effectiveRange =
    requestedRange && (!ifRange || ifRange.trim() === manifest.etag)
      ? requestedRange
      : null;
  const range = parseVirtualByteRange(effectiveRange, manifest.totalBytes);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: {
        "content-range": `bytes */${manifest.totalBytes}`,
        "cache-control": "no-store",
        "accept-ranges": "bytes"
      }
    });
  }

  const selectedRange = range ?? {
    startsAt: 0,
    endsAt: manifest.totalBytes - 1,
    length: manifest.totalBytes
  };
  headers.set("content-length", String(selectedRange.length));
  if (range) {
    headers.set(
      "content-range",
      `bytes ${range.startsAt}-${range.endsAt}/${manifest.totalBytes}`
    );
  }
  if (request.method === "HEAD") {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const spans = mapVirtualByteRange(manifest, selectedRange);
  const body = withFixedLength(
    streamVirtualObjectSpans(bucket, spans),
    selectedRange.length
  );
  return new Response(body, {
    status: range ? 206 : 200,
    headers
  });
}

export function streamVirtualObjectSpans(
  bucket: R2Bucket,
  spans: VirtualObjectSpan[]
): ReadableStream<Uint8Array> {
  let spanIndex = 0;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let activeExpectedBytes = 0;
  let activeReadBytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (activeReader) {
          const chunk = await activeReader.read();
          if (!chunk.done) {
            activeReadBytes += chunk.value.byteLength;
            if (activeReadBytes > activeExpectedBytes) {
              controller.error(
                new Error("A virtual media object returned more bytes than requested.")
              );
              return;
            }
            controller.enqueue(chunk.value);
            return;
          }
          if (activeReadBytes !== activeExpectedBytes) {
            controller.error(
              new Error("A virtual media object returned fewer bytes than requested.")
            );
            return;
          }
          activeReader.releaseLock();
          activeReader = null;
          spanIndex += 1;
          continue;
        }

        const span = spans[spanIndex];
        if (!span) {
          controller.close();
          return;
        }
        const object = await bucket.get(span.objectKey, {
          range: {
            offset: span.sourceOffset,
            length: span.byteLength
          }
        });
        if (!object?.body) {
          controller.error(
            new Error(`Virtual media segment object is unavailable: ${span.objectKey}`)
          );
          return;
        }
        if (
          span.objectEtag
          && object.httpEtag !== span.objectEtag
        ) {
          controller.error(
            new Error(`Virtual media segment object changed: ${span.objectKey}`)
          );
          return;
        }
        activeReader = object.body.getReader();
        activeExpectedBytes = span.byteLength;
        activeReadBytes = 0;
      }
    },
    async cancel(reason) {
      if (activeReader) await activeReader.cancel(reason);
    }
  });
}

function virtualMediaHeaders(
  manifest: CompiledVirtualMediaManifest
): Headers {
  return new Headers({
    "content-type": manifest.contentType,
    "content-length": String(manifest.totalBytes),
    "cache-control": "private, no-store",
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "access-control-expose-headers":
      "accept-ranges,content-length,content-range,etag,x-dust-wave-media-manifest",
    "x-content-type-options": "nosniff",
    "x-dust-wave-media-manifest": manifest.id,
    etag: manifest.etag
  });
}

function virtualMediaError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function withFixedLength(
  source: ReadableStream<Uint8Array>,
  expectedLength: number
): ReadableStream<Uint8Array> {
  if (typeof FixedLengthStream === "undefined") return source;
  const fixedLength = new FixedLengthStream(expectedLength);
  void source
    .pipeTo(fixedLength.writable as WritableStream<Uint8Array>)
    .catch(() => {
      // pipeTo already propagates the source error to the response stream.
    });
  return fixedLength.readable;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((value) => value.trim())
    .some((value) =>
      value === "*"
      || value === etag
      || (value.startsWith("W/") && value.slice(2) === etag)
    );
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
