#!/usr/bin/env node

import { readFile } from "node:fs/promises";
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
process.stdout.write(
  `timestamp=${signed.timestamp}\nsignature=${signed.signature}\n`
);
