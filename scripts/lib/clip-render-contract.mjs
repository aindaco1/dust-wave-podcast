import { createHash } from "node:crypto";

export const CLIP_ASPECT_DIMENSIONS = Object.freeze({
  "9:16": Object.freeze({ width: 1080, height: 1920 }),
  "1:1": Object.freeze({ width: 1080, height: 1080 }),
  "16:9": Object.freeze({ width: 1920, height: 1080 })
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STAGING_BUCKET = "dustwave-media-staging";
const STAGING_HOST = "dust-wave-podcast-staging.jogo.workers.dev";
const MAXIMUM_CAPTION_BYTES = 1_000_000;
const MAXIMUM_CAPTION_CUES = 360;

export function validateClipRenderManifest(value, {
  stagingHost = STAGING_HOST,
  stagingBucket = STAGING_BUCKET
} = {}) {
  assertObject(value, "Clip render manifest");
  const manifest = value;
  for (const [field, identifier] of [
    ["renderId", manifest.renderId],
    ["clipId", manifest.clipId],
    ["episodeId", manifest.episodeId],
    ["showId", manifest.showId]
  ]) {
    if (!validIdentifier(identifier)) {
      throw new Error(`${field} is invalid.`);
    }
  }
  if (
    manifest.schemaVersion !== "clip-render-v1"
    || !positiveInteger(manifest.clipRevision)
    || !SHA256.test(String(manifest.recipeSha256 || ""))
  ) {
    throw new Error("The clip render identity is invalid.");
  }

  validateSource(manifest, stagingBucket);
  const dimensions = validateRecipe(manifest.recipe);
  validateCaptions(manifest.captions, manifest.recipe);
  validateOutput(manifest, dimensions, stagingBucket);
  validateCallback(manifest, stagingHost);
  validateManifestDigest(manifest);
  return manifest;
}

export function manifestBodySha256(manifest) {
  const { manifestSha256: _manifestSha256, ...body } = manifest;
  return sha256Hex(JSON.stringify(body));
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateSource(manifest, stagingBucket) {
  assertObject(manifest.source, "source");
  const expectedPrefix =
    `podcasts/${manifest.showId}/${manifest.episodeId}/`;
  if (
    manifest.source.bucketName !== stagingBucket
    || manifest.source.mimeType !== "audio/mpeg"
    || !safeObjectKey(manifest.source.objectKey)
    || !manifest.source.objectKey.startsWith(expectedPrefix)
    || !positiveInteger(manifest.source.objectBytes)
    || !boundedText(manifest.source.etag, 200)
  ) {
    throw new Error("The private clip source is invalid.");
  }
}

function validateRecipe(recipe) {
  assertObject(recipe, "recipe");
  const dimensions = CLIP_ASPECT_DIMENSIONS[recipe.aspectRatio];
  if (
    recipe.schemaVersion !== 1
    || !dimensions
    || recipe.templateId !== "captioned-waveform-v1"
    || !["en", "es"].includes(recipe.captionLanguage)
    || !["segment", "word"].includes(recipe.boundaryMode)
    || recipe.captionStyle !== "high-contrast-v1"
    || !nonNegativeInteger(recipe.startsAtMs)
    || !positiveInteger(recipe.endsAtMs)
    || !positiveInteger(recipe.durationMs)
    || recipe.endsAtMs - recipe.startsAtMs !== recipe.durationMs
    || recipe.durationMs < 1_000
    || recipe.durationMs > 180_000
    || recipe.outputWidth !== dimensions.width
    || recipe.outputHeight !== dimensions.height
    || !validIdentifier(recipe.startCueId)
    || !validIdentifier(recipe.endCueId)
    || !validIdentifier(recipe.transcriptId)
    || !positiveInteger(recipe.transcriptRevision)
    || !SHA256.test(String(recipe.transcriptSha256 || ""))
    || !boundedText(recipe.title, 160)
  ) {
    throw new Error("The captioned-waveform recipe is invalid.");
  }
  if (
    recipe.boundaryMode === "word"
    && (
      !validIdentifier(recipe.startWordId)
      || !validIdentifier(recipe.endWordId)
      || !validIdentifier(recipe.alignmentRevisionId)
    )
  ) {
    throw new Error("The word-boundary recipe lacks alignment evidence.");
  }
  if (
    recipe.boundaryMode === "segment"
    && (
      recipe.startWordId !== null
      || recipe.endWordId !== null
      || recipe.alignmentRevisionId !== null
    )
  ) {
    throw new Error("The segment recipe contains word-boundary evidence.");
  }
  const safeArea = recipe.safeArea;
  if (
    !safeArea
    || safeArea.topPercent !== 8
    || safeArea.rightPercent !== 8
    || safeArea.bottomPercent !== 18
    || safeArea.leftPercent !== 8
  ) {
    throw new Error("The clip safe-area contract is invalid.");
  }
  return dimensions;
}

function validateCaptions(captions, recipe) {
  assertObject(captions, "captions");
  if (
    captions.format !== "timed-text-v1"
    || captions.language !== recipe.captionLanguage
    || !Array.isArray(captions.cues)
    || captions.cues.length < 1
    || captions.cues.length > MAXIMUM_CAPTION_CUES
    || captions.cues.length > Math.ceil(recipe.durationMs / 500)
  ) {
    throw new Error("The clip caption collection is invalid.");
  }
  if (
    Buffer.byteLength(JSON.stringify(captions.cues), "utf8")
    > MAXIMUM_CAPTION_BYTES
  ) {
    throw new Error("The clip caption collection is too large.");
  }
  const identifiers = new Set();
  let previousEnd = 0;
  for (const cue of captions.cues) {
    assertObject(cue, "caption cue");
    if (
      !validIdentifier(cue.id)
      || identifiers.has(cue.id)
      || !nonNegativeInteger(cue.startsAtMs)
      || !positiveInteger(cue.endsAtMs)
      || cue.endsAtMs <= cue.startsAtMs
      || cue.startsAtMs < previousEnd
      || cue.endsAtMs > recipe.durationMs
      || !validCaptionMarkdown(cue.textMarkdown)
      || (
        String(cue.speakerLabel || "")
        && !validPlainCaption(cue.speakerLabel, 80)
      )
    ) {
      throw new Error("A clip caption cue is invalid.");
    }
    identifiers.add(cue.id);
    previousEnd = cue.endsAtMs;
  }
}

function validateOutput(manifest, dimensions, stagingBucket) {
  assertObject(manifest.output, "output");
  const expectedPrefix = [
    "podcasts",
    manifest.showId,
    manifest.episodeId,
    "clips",
    manifest.clipId,
    `revision-${manifest.clipRevision}`
  ].join("/");
  if (
    manifest.output.bucketName !== stagingBucket
    || manifest.output.mimeType !== "video/mp4"
    || !safeObjectKey(manifest.output.objectKey)
    || !manifest.output.objectKey.startsWith(`${expectedPrefix}/`)
    || !manifest.output.objectKey.endsWith(`/${manifest.renderId}.mp4`)
    || manifest.recipe.outputWidth !== dimensions.width
    || manifest.recipe.outputHeight !== dimensions.height
    || !Array.isArray(manifest.output.requiredCustomMetadata)
    || manifest.output.requiredCustomMetadata.length !== 2
    || !manifest.output.requiredCustomMetadata.includes("sha256")
    || !manifest.output.requiredCustomMetadata.includes(
      "render-manifest-sha256"
    )
  ) {
    throw new Error("The private clip output contract is invalid.");
  }
}

function validateCallback(manifest, stagingHost) {
  let callback;
  try {
    callback = new URL(String(manifest.callbackUrl || ""));
  } catch {
    throw new Error("The clip callback URL is invalid.");
  }
  if (
    callback.protocol !== "https:"
    || callback.hostname !== stagingHost
    || callback.pathname !==
      `/v1/processor/clip-renders/${manifest.renderId}/complete`
    || callback.username
    || callback.password
    || callback.port
    || callback.search
    || callback.hash
  ) {
    throw new Error("The clip callback is outside isolated staging.");
  }
}

function validateManifestDigest(manifest) {
  if (
    !SHA256.test(String(manifest.manifestSha256 || ""))
    || manifestBodySha256(manifest) !== manifest.manifestSha256
  ) {
    throw new Error("The clip processor manifest digest is invalid.");
  }
}

function validCaptionMarkdown(value) {
  const text = String(value || "");
  if (
    !text
    || text.length > 2_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
  ) {
    return false;
  }
  const withoutUnderline = text.replace(/<\/?u>/gi, "");
  if (/[<>]/.test(withoutUnderline)) return false;
  let underlineOpen = false;
  for (const tag of text.match(/<\/?u>/gi) ?? []) {
    const closing = /^<\//.test(tag);
    if ((closing && !underlineOpen) || (!closing && underlineOpen)) {
      return false;
    }
    underlineOpen = !closing;
  }
  return !underlineOpen && Boolean(
    withoutUnderline.replace(/[*_]/g, "").trim()
  );
}

function validPlainCaption(value, maximum) {
  const text = String(value || "");
  return Boolean(
    text
    && text.length <= maximum
    && !/[\u0000-\u001f\u007f<>]/.test(text)
  );
}

function safeObjectKey(value) {
  const key = String(value || "");
  return Boolean(
    key
    && key.length <= 1_000
    && !key.startsWith("/")
    && !key.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(key)
    && !key.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function boundedText(value, maximum) {
  const text = String(value || "");
  return Boolean(
    text
    && text.length <= maximum
    && !/[\r\n\u0000]/.test(text)
  );
}

function validIdentifier(value) {
  const identifier = String(value || "");
  return identifier.length <= 160 && IDENTIFIER.test(identifier);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}
