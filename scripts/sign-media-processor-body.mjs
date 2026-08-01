#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import {
  mediaProcessorSignature
} from "./lib/media-processor-signature.mjs";

const bodyPath = process.argv[2];
const secret = process.env.MEDIA_PROCESSOR_CALLBACK_SECRET;
if (!bodyPath || !secret) {
  throw new Error(
    "Pass the JSON body path and set MEDIA_PROCESSOR_CALLBACK_SECRET."
  );
}
const body = await readFile(path.resolve(bodyPath), "utf8");
const signed = mediaProcessorSignature(body, secret);
const outputs =
  `timestamp=${signed.timestamp}\nsignature=${signed.signature}\n`;
if (process.env.GITHUB_OUTPUT) {
  process.stdout.write(`::add-mask::${signed.signature}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, outputs, "utf8");
} else {
  process.stdout.write(outputs);
}
