#!/usr/bin/env node

import { auditTranscriptReferenceFiles } from "./lib/transcript-reference-audit.mjs";

const options = parseArguments(process.argv.slice(2));
const audit = await auditTranscriptReferenceFiles(options);
process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined) usage();
    const key = flag.slice(2);
    if (key === "transcript") options.transcriptPath = value;
    else if (key === "reference") options.referencePath = value;
    else if (key === "reference-format") options.referenceFormat = value;
    else if (key === "window-ms") options.windowMs = number(value, flag);
    else if (key === "minimum-similarity") {
      options.minimumSimilarity = number(value, flag);
    } else if (key === "maximum-low-window-ratio") {
      options.maximumLowSimilarityWindowRatio = number(value, flag);
    } else if (key === "maximum-reported-windows") {
      options.maximumReportedWindows = number(value, flag);
    } else usage();
  }
  if (!options.transcriptPath || !options.referencePath) usage();
  return options;
}

function number(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function usage() {
  throw new TypeError(
    "Usage: audit-transcript-reference --transcript FILE --reference FILE "
      + "[--reference-format youtube-json3|timed-cues]"
  );
}
