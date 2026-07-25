export type ParsedMediaRange = R2Range | "invalid" | null;

export function requestedMediaRange(
  request: Request,
  totalBytes: number,
  etag?: string | null
): ParsedMediaRange {
  const header = request.headers.get("range");
  if (!header) return null;
  const ifRange = request.headers.get("if-range");
  if (ifRange && etag && ifRange !== etag) return null;
  return parseSingleByteRange(header, totalBytes);
}

export function parseSingleByteRange(
  header: string | null,
  totalBytes: number
): ParsedMediaRange {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { suffix: Math.min(suffix, totalBytes) };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : totalBytes - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || start >= totalBytes
    || end < start
  ) {
    return "invalid";
  }
  return {
    offset: start,
    length: Math.min(end, totalBytes - 1) - start + 1
  };
}

export function safeDownloadFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 180);
}
