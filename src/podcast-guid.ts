export const PODCAST_GUID_NAMESPACE =
  "ead4c236-bf58-58c6-a2c6-a6b28d128cb6";

export const PODCAST_GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const PODCAST_NAMESPACE_URIS = new Set([
  "https://podcastindex.org/namespace/1.0",
  "https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md"
]);

export type PodcastGuidDiscovery = {
  status: "absent" | "valid" | "invalid";
  guid: string | null;
};

export function isPodcastGuid(value: unknown): value is string {
  return typeof value === "string" && PODCAST_GUID_PATTERN.test(value);
}

export function discoverPodcastGuid(
  rssDocument: string,
  channelMetadata: string
): PodcastGuidDiscovery {
  const rootAttributes = rssDocument.match(/<rss\b([^>]*)>/iu)?.[1] ?? "";
  const prefixes = [...rootAttributes.matchAll(
    /xmlns:([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:"([^"]+)"|'([^']+)')/gu
  )]
    .filter((match) =>
      PODCAST_NAMESPACE_URIS.has(match[2] ?? match[3] ?? "")
    )
    .map((match) => match[1]);
  const uniquePrefixes = [...new Set(prefixes)];
  if (
    /<podcast:guid\b/iu.test(channelMetadata)
    && !uniquePrefixes.includes("podcast")
  ) {
    return { status: "invalid", guid: null };
  }
  if (uniquePrefixes.length === 0) {
    return { status: "absent", guid: null };
  }

  let openingCount = 0;
  const values: string[] = [];
  for (const prefix of uniquePrefixes) {
    const escapedPrefix = escapeRegex(prefix);
    openingCount += countMatches(
      channelMetadata,
      new RegExp(`<${escapedPrefix}:guid\\b`, "giu")
    );
    values.push(
      ...[...channelMetadata.matchAll(
        new RegExp(
          `<${escapedPrefix}:guid\\s*>([^<]+)<\\/${escapedPrefix}:guid\\s*>`,
          "giu"
        )
      )].map((match) => match[1].trim())
    );
  }
  if (openingCount === 0) {
    return { status: "absent", guid: null };
  }
  if (
    openingCount !== 1
    || values.length !== 1
    || !isPodcastGuid(values[0])
  ) {
    return { status: "invalid", guid: null };
  }
  return { status: "valid", guid: values[0] };
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

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
