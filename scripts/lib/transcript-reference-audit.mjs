import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { auditTimedTextReference } from "@dustwave/timed-text/alignment";

const MAXIMUM_INPUT_BYTES = 20 * 1024 * 1024;
const MAXIMUM_EVENTS = 100_000;
const MAXIMUM_SEGMENT_TEXT = 10_000;

export async function auditTranscriptReferenceFiles({
  transcriptPath,
  referencePath,
  referenceFormat = "youtube-json3",
  windowMs = 60_000,
  minimumSimilarity = 0.75,
  maximumLowSimilarityWindowRatio = 0.1,
  maximumReportedWindows = 12
}) {
  const transcriptInput = await readBoundedJson(transcriptPath, "transcript");
  const referenceInput = await readBoundedJson(referencePath, "reference");
  const cues = parseCanonicalTranscript(transcriptInput.value);
  const referenceCues = referenceFormat === "youtube-json3"
    ? parseYouTubeJson3Reference(referenceInput.value)
    : referenceFormat === "timed-cues"
      ? parseTimedReference(referenceInput.value)
      : invalid("Reference format is invalid");
  const audit = auditTimedTextReference({
    cues,
    referenceCues,
    windowMs,
    minimumSimilarity,
    maximumLowSimilarityWindowRatio,
    maximumReportedWindows
  });
  return {
    schemaVersion: "dustwave-transcript-reference-packet-v1",
    transcriptInputSha256: transcriptInput.sha256,
    referenceInputSha256: referenceInput.sha256,
    referenceFormat,
    audit
  };
}

export function parseCanonicalTranscript(value) {
  const transcript = object(value, "Transcript");
  if (!Array.isArray(transcript.cues) || transcript.cues.length < 1) {
    invalid("Transcript cues are invalid");
  }
  return transcript.cues.map((cue, index) => {
    const row = object(cue, `Transcript cue ${index + 1}`);
    return {
      startsAtMs: row.startsAtMs,
      endsAtMs: row.endsAtMs,
      textMarkdown: row.textMarkdown
    };
  });
}

export function parseYouTubeJson3Reference(value) {
  const document = object(value, "YouTube caption document");
  if (
    !Array.isArray(document.events)
    || document.events.length < 1
    || document.events.length > MAXIMUM_EVENTS
  ) {
    invalid("YouTube caption events are invalid");
  }
  const textEvents = document.events.flatMap((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return [];
    if (!Array.isArray(event.segs) || event.segs.length < 1) return [];
    const startsAtMs = integer(event.tStartMs, 0, 86_399_999,
      `YouTube event ${index + 1} start`);
    const text = event.segs.map((segment, segmentIndex) => {
      const row = object(
        segment,
        `YouTube event ${index + 1} segment ${segmentIndex + 1}`
      );
      const valueText = String(row.utf8 ?? "");
      if (
        valueText.length > MAXIMUM_SEGMENT_TEXT
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(valueText)
      ) {
        invalid(`YouTube event ${index + 1} text is invalid`);
      }
      return valueText;
    }).join("").replace(/\s+/g, " ").trim();
    return text ? [{ startsAtMs, text, durationMs: event.dDurationMs }] : [];
  });
  if (!textEvents.length) invalid("YouTube caption text is missing");
  return textEvents.map((event, index) => {
    const nextStart = textEvents[index + 1]?.startsAtMs;
    const durationMs = Number.isSafeInteger(Number(event.durationMs))
      && Number(event.durationMs) > 0
      ? Number(event.durationMs)
      : 5_000;
    const durationEnd = Math.min(86_400_000, event.startsAtMs + durationMs);
    const endsAtMs = nextStart === undefined
      ? durationEnd
      : Math.max(event.startsAtMs + 1, Math.min(durationEnd, nextStart));
    return {
      startsAtMs: event.startsAtMs,
      endsAtMs,
      text: event.text
    };
  });
}

export function parseTimedReference(value) {
  const document = object(value, "Timed reference document");
  if (!Array.isArray(document.cues) || document.cues.length < 1) {
    invalid("Timed reference cues are invalid");
  }
  return document.cues.map((cue, index) => {
    const row = object(cue, `Timed reference cue ${index + 1}`);
    return {
      startsAtMs: row.startsAtMs,
      endsAtMs: row.endsAtMs,
      text: row.text ?? row.textMarkdown
    };
  });
}

async function readBoundedJson(pathValue, field) {
  const path = String(pathValue ?? "");
  if (!path || /[\u0000-\u001f\u007f]/u.test(path)) {
    invalid(`${field} path is invalid`);
  }
  const bytes = await readFile(path);
  if (bytes.length < 2 || bytes.length > MAXIMUM_INPUT_BYTES) {
    invalid(`${field} input size is invalid`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid(`${field} input is not valid JSON`);
  }
  return {
    value,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${field} is invalid`);
  }
  return value;
}

function integer(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    invalid(`${field} is invalid`);
  }
  return number;
}

function invalid(message) {
  throw new TypeError(message);
}
