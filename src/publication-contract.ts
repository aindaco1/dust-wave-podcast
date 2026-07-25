import { sha256Hex } from "@dustwave/worker-core/crypto";

export type PublicationPrerequisiteInput = {
  title: string;
  summary: string;
  guid: string | null;
  audioKey: string | null;
  audioMimeType: string | null;
  audioBytes: number | null;
  durationSeconds: number | null;
  mediaStatus: string;
};

export type PublicationFingerprintInput = {
  id: string;
  showId: string;
  showSlug: string;
  title: string;
  summary: string;
  contentHtml: string;
  access: string;
  explicit: number;
  guid: string | null;
  audioKey: string | null;
  audioMimeType: string | null;
  audioBytes: number | null;
  durationSeconds: number | null;
  videoSourceKey: string | null;
  publicAt: string;
  canonicalUrl: string;
};

export async function publicationFingerprint(
  episode: PublicationFingerprintInput
): Promise<string> {
  return sha256Hex(JSON.stringify(episode));
}

export function publicationPrerequisiteFailures(
  episode: PublicationPrerequisiteInput
): string[] {
  return [
    !episode.title.trim() ? "title" : null,
    !episode.summary.trim() ? "summary" : null,
    !episode.guid ? "guid" : null,
    !episode.audioKey ? "delivery audio" : null,
    !episode.audioMimeType ? "audio MIME type" : null,
    !episode.audioBytes ? "audio byte length" : null,
    !episode.durationSeconds ? "duration" : null,
    episode.mediaStatus !== "ready" ? "ready media" : null
  ].filter((value): value is string => value !== null);
}
