import { createHash } from "node:crypto";

export const YOUTUBE_AUDIO_RENDITION_ORIGIN =
  "https://dust-wave-podcast-staging.jogo.workers.dev";
export const YOUTUBE_AUDIO_RENDITION_PART_BYTES = 32 * 1024 * 1024;
export const YOUTUBE_AUDIO_RENDITION_MAXIMUM_BYTES =
  2 * 1024 * 1024 * 1024;

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function manifestBodySha256(value) {
  const body = { ...value };
  delete body.manifestSha256;
  return sha256Hex(JSON.stringify(body));
}

export function validateYouTubeAudioRenditionManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The YouTube audio rendition manifest is invalid.");
  }
  const manifest = value;
  const renditionId = identifier(manifest.renditionId, "rendition ID");
  const expectedBase = [
    YOUTUBE_AUDIO_RENDITION_ORIGIN,
    "v1",
    "processor",
    "youtube-audio-renditions",
    renditionId
  ].join("/");
  if (
    manifest.schemaVersion !== 1
    || manifest.environment !== "staging"
    || manifest.templateId !== "episode-artwork-waveform-v1"
    || !sha256(manifest.manifestSha256)
    || manifestBodySha256(manifest) !== manifest.manifestSha256
  ) {
    throw new Error("The YouTube audio rendition manifest digest is invalid.");
  }
  if (
    !manifest.episode
    || identifier(manifest.episode.id, "episode ID") !== manifest.episode.id
    || typeof manifest.episode.title !== "string"
    || manifest.episode.title.length < 1
    || manifest.episode.title.length > 240
    || !positiveInteger(manifest.episode.durationMs, 86_400_000)
  ) {
    throw new Error("The YouTube audio rendition episode is invalid.");
  }
  if (
    !manifest.source
    || !safeObjectKey(manifest.source.objectKey)
    || !positiveInteger(manifest.source.objectBytes, 20 * 1024 ** 3)
    || !boundedText(manifest.source.etag, 256)
    || ![
      "audio/mpeg",
      "audio/mp4",
      "audio/wav",
      "audio/x-wav",
      "audio/flac",
      "audio/x-flac"
    ].includes(manifest.source.mimeType)
    || identifier(
      manifest.source.workingMasterId,
      "working master ID"
    ) !== manifest.source.workingMasterId
    || !sha256(manifest.source.workingMasterSha256)
  ) {
    throw new Error("The YouTube audio rendition source is invalid.");
  }
  if (
    !manifest.artwork
    || !safeObjectKey(manifest.artwork.objectKey)
    || !positiveInteger(manifest.artwork.objectBytes, 10 * 1024 * 1024)
    || !boundedText(manifest.artwork.etag, 256)
    || !["image/jpeg", "image/png", "image/webp"].includes(
      manifest.artwork.mimeType
    )
    || !sha256(manifest.artwork.sha256)
  ) {
    throw new Error("The YouTube audio rendition artwork is invalid.");
  }
  if (
    !manifest.video
    || manifest.video.width !== 1920
    || manifest.video.height !== 1080
    || manifest.video.frameRate !== 30
    || manifest.video.pixelFormat !== "yuv420p"
    || manifest.video.codec !== "h264"
    || manifest.video.profile !== "high"
    || manifest.video.crf !== 26
    || manifest.video.preset !== "veryfast"
    || manifest.video.fastStart !== true
    || !manifest.audio
    || manifest.audio.codec !== "aac"
    || manifest.audio.sampleRateHz !== 48_000
    || manifest.audio.channels !== 2
    || manifest.audio.bitrateKbps !== 192
  ) {
    throw new Error("The YouTube audio rendition codec policy is invalid.");
  }
  const expectedOutputKeySuffix =
    `/youtube_audio_rendition/${renditionId}.mp4`;
  if (
    !manifest.output
    || !safeObjectKey(manifest.output.objectKey)
    || !manifest.output.objectKey.endsWith(expectedOutputKeySuffix)
    || manifest.output.mimeType !== "video/mp4"
    || manifest.output.width !== 1920
    || manifest.output.height !== 1080
    || manifest.output.maximumBytes !==
      YOUTUBE_AUDIO_RENDITION_MAXIMUM_BYTES
    || manifest.output.recommendedPartBytes !==
      YOUTUBE_AUDIO_RENDITION_PART_BYTES
    || manifest.output.maximumPartBytes !==
      YOUTUBE_AUDIO_RENDITION_PART_BYTES
  ) {
    throw new Error("The YouTube audio rendition output is invalid.");
  }
  const endpoints = manifest.endpoints;
  if (
    !endpoints
    || endpoints.audioSource !== `${expectedBase}/sources/audio`
    || endpoints.artworkSource !== `${expectedBase}/sources/artwork`
    || endpoints.partTemplate !== `${expectedBase}/parts/{partNumber}`
    || endpoints.uploadComplete !== `${expectedBase}/upload-complete`
    || endpoints.evidenceComplete !== `${expectedBase}/complete`
  ) {
    throw new Error(
      "The YouTube audio rendition endpoints are not isolated staging URLs."
    );
  }
  return manifest;
}

function identifier(value, name) {
  const normalized = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(normalized)) {
    throw new Error(`The ${name} is invalid.`);
  }
  return normalized;
}

function positiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function boundedText(value, maximum) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum;
}

function sha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function safeObjectKey(value) {
  return typeof value === "string"
    && value.startsWith("podcasts/")
    && value.length <= 1024
    && !value.includes("..")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value);
}
