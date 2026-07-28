export const PODCAST_GUID_NAMESPACE =
  "ead4c236-bf58-58c6-a2c6-a6b28d128cb6";

export const PODCAST_GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isPodcastGuid(value: unknown): value is string {
  return typeof value === "string" && PODCAST_GUID_PATTERN.test(value);
}

export async function podcastGuidForFeedUrl(
  feedUrlValue: string
): Promise<string> {
  const feedUrl = new URL(feedUrlValue);
  if (
    !["http:", "https:"].includes(feedUrl.protocol)
    || feedUrl.username
    || feedUrl.password
    || feedUrl.hash
  ) {
    throw new TypeError("The podcast feed URL cannot seed a channel GUID.");
  }
  const pathname = feedUrl.pathname.replace(/\/+$/u, "");
  const seed = `${feedUrl.host}${pathname}${feedUrl.search}`;
  if (!seed) {
    throw new TypeError("The podcast feed URL cannot seed a channel GUID.");
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-1",
      concatBytes(
        uuidBytes(PODCAST_GUID_NAMESPACE),
        new TextEncoder().encode(seed)
      )
    )
  );
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest.slice(0, 16));
}

function uuidBytes(value: string): Uint8Array {
  const compact = value.replace(/-/gu, "");
  if (!/^[0-9a-f]{32}$/u.test(compact)) {
    throw new TypeError("The UUID namespace is invalid.");
  }
  return Uint8Array.from(
    compact.match(/.{2}/gu) ?? [],
    (byte) => Number.parseInt(byte, 16)
  );
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.byteLength + second.byteLength);
  result.set(first);
  result.set(second, first.byteLength);
  return result;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}
