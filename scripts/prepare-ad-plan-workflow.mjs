#!/usr/bin/env node

import {
  appendFile,
  mkdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const raw = process.env.PLAN_MANIFEST;
const outputFile = process.env.GITHUB_OUTPUT;
if (!raw || !outputFile) {
  throw new Error("PLAN_MANIFEST and GITHUB_OUTPUT are required.");
}
const manifest = JSON.parse(raw);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const planId = String(manifest.planId || "");
const showId = String(manifest.showId || "");
const episodeId = String(manifest.episodeId || "");
const sourceKey = String(manifest.source?.objectKey || "");
const outputPrefix = String(manifest.outputPrefix || "").replace(/\/+$/, "");
const expectedEpisodePrefix = `podcasts/${showId}/${episodeId}/`;
const expectedOutputPrefix =
  `podcasts/${showId}/${episodeId}/ad-plans/${planId}`;
if (
  manifest.schemaVersion !== "1"
  || !identifier.test(planId)
  || !identifier.test(showId)
  || !identifier.test(episodeId)
  || manifest.streamProfile !== "mp3-44100-stereo-cbr128-frame-v1"
  || !Number.isSafeInteger(Number(manifest.durationMs))
  || Number(manifest.durationMs) <= 0
  || manifest.source?.bucketName !== "dustwave-media-staging"
  || !sourceKey.startsWith(expectedEpisodePrefix)
  || /[\r\n]/.test(sourceKey)
  || !Number.isSafeInteger(Number(manifest.source?.objectBytes))
  || Number(manifest.source?.objectBytes) <= 0
  || !String(manifest.source?.etag || "").trim()
  || outputPrefix !== expectedOutputPrefix
  || !validMarkers(manifest.markers, Number(manifest.durationMs))
) {
  throw new Error("The staging ad-plan manifest is invalid.");
}
const callback = new URL(String(manifest.callbackUrl || ""));
if (
  callback.protocol !== "https:"
  || callback.hostname !== "dust-wave-podcast-staging.jogo.workers.dev"
  || callback.pathname
    !== `/v1/processor/ad-plans/${planId}/complete`
  || callback.search
  || callback.hash
) {
  throw new Error("The processor callback is outside isolated staging.");
}
const workDirectory = path.resolve("work/ad-plan");
await mkdir(workDirectory, { recursive: true });
await writeFile(
  path.join(workDirectory, "plan.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
await appendFile(
  outputFile,
  [
    `plan_id=${planId}`,
    `bucket_name=${manifest.source.bucketName}`,
    `source_key=${sourceKey}`,
    `callback_url=${callback.href}`,
    ""
  ].join("\n")
);

function validMarkers(value, durationMs) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    return false;
  }
  const positions = new Set();
  for (const marker of value) {
    if (
      !marker
      || typeof marker !== "object"
      || Array.isArray(marker)
      || !["pre", "mid", "post"].includes(marker.position)
      || positions.has(marker.position)
    ) {
      return false;
    }
    positions.add(marker.position);
    if (marker.position === "mid") {
      if (
        !Number.isSafeInteger(Number(marker.startsAtMs))
        || Number(marker.startsAtMs) <= 0
        || Number(marker.startsAtMs) >= durationMs
      ) {
        return false;
      }
    } else if (marker.startsAtMs !== null) {
      return false;
    }
  }
  return true;
}
