import {
  compileVirtualMediaManifest,
  virtualMediaLengthContractMatches,
  type VirtualMediaLengthContract,
  type VirtualMediaManifest,
  type VirtualMediaSegment
} from "./virtual-media";

export type StoredAdDecisionManifest = VirtualMediaManifest & {
  fallback: VirtualMediaManifest;
  fallbackType: "house_fill" | "full_file";
  deliveryLengthContract: VirtualMediaLengthContract;
};

export function parseStoredAdDecisionManifest(
  value: string
): StoredAdDecisionManifest {
  const parsed: unknown = JSON.parse(value);
  const record = storedRecord(parsed);
  if (!record) {
    throw new Error("Stored ad decision manifest is invalid.");
  }
  const primary = parseStoredVirtualManifest(record);
  const fallback = parseStoredVirtualManifest(record.fallback);
  const fallbackType = record.fallbackType;
  const lengthRecord = storedRecord(record.deliveryLengthContract);
  if (
    (fallbackType !== "house_fill" && fallbackType !== "full_file")
    || !lengthRecord
    || lengthRecord.schemaVersion !== "equal-byte-length-v1"
    || !storedPositiveInteger(lengthRecord.primaryBytes)
    || !storedPositiveInteger(lengthRecord.fallbackBytes)
    || typeof lengthRecord.equalByteLength !== "boolean"
  ) {
    throw new Error("Stored ad decision delivery contract is invalid.");
  }
  const manifest: StoredAdDecisionManifest = {
    ...primary,
    fallback,
    fallbackType,
    deliveryLengthContract: {
      schemaVersion: "equal-byte-length-v1",
      primaryBytes: lengthRecord.primaryBytes,
      fallbackBytes: lengthRecord.fallbackBytes,
      equalByteLength: lengthRecord.equalByteLength
    }
  };
  if (
    manifest.fallback.decisionId !== manifest.decisionId
    || manifest.fallback.episodeId !== manifest.episodeId
    || !virtualMediaLengthContractMatches(
      manifest,
      manifest.fallback,
      manifest.deliveryLengthContract
    )
    || (
      manifest.fallbackType === "house_fill"
      && !manifest.deliveryLengthContract.equalByteLength
    )
  ) {
    throw new Error("Stored ad decision delivery contract does not match.");
  }
  return manifest;
}

function parseStoredVirtualManifest(value: unknown): VirtualMediaManifest {
  const record = storedRecord(value);
  if (
    !record
    || record.schemaVersion !== "1"
    || typeof record.id !== "string"
    || typeof record.episodeId !== "string"
    || typeof record.decisionId !== "string"
    || typeof record.etag !== "string"
    || (
      record.contentType !== "audio/mpeg"
      && record.contentType !== "audio/mp4"
    )
    || typeof record.streamProfile !== "string"
    || typeof record.validatedAt !== "string"
    || !Array.isArray(record.segments)
  ) {
    throw new Error("Stored virtual media manifest is invalid.");
  }
  const segments = record.segments.map((value): VirtualMediaSegment => {
    const segment = storedRecord(value);
    if (
      !segment
      || typeof segment.id !== "string"
      || (
        segment.kind !== "program"
        && segment.kind !== "house_ad"
        && segment.kind !== "direct_ad"
      )
      || typeof segment.objectKey !== "string"
      || (
        segment.objectEtag !== undefined
        && typeof segment.objectEtag !== "string"
      )
      || !storedPositiveInteger(segment.objectBytes)
      || !storedNonNegativeInteger(segment.sourceOffset)
      || !storedPositiveInteger(segment.byteLength)
      || (
        segment.contentType !== "audio/mpeg"
        && segment.contentType !== "audio/mp4"
      )
      || typeof segment.streamProfile !== "string"
    ) {
      throw new Error("Stored virtual media segment is invalid.");
    }
    return {
      id: segment.id,
      kind: segment.kind,
      objectKey: segment.objectKey,
      ...(segment.objectEtag === undefined
        ? {}
        : { objectEtag: segment.objectEtag }),
      objectBytes: segment.objectBytes,
      sourceOffset: segment.sourceOffset,
      byteLength: segment.byteLength,
      contentType: segment.contentType,
      streamProfile: segment.streamProfile
    };
  });
  const manifest: VirtualMediaManifest = {
    schemaVersion: "1",
    id: record.id,
    episodeId: record.episodeId,
    decisionId: record.decisionId,
    etag: record.etag,
    contentType: record.contentType,
    streamProfile: record.streamProfile,
    validatedAt: record.validatedAt,
    segments
  };
  compileVirtualMediaManifest(manifest);
  return manifest;
}

function storedRecord(
  value: unknown
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function storedPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function storedNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
