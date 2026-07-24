#!/usr/bin/env node

import {
  createHmac
} from "node:crypto";
import {
  readFile
} from "node:fs/promises";
import path from "node:path";

const bodyPath = process.argv[2];
const secret = process.env.MEDIA_PROCESSOR_CALLBACK_SECRET;
if (!bodyPath || !secret) {
  throw new Error(
    "Pass the callback body path and set MEDIA_PROCESSOR_CALLBACK_SECRET."
  );
}
const body = await readFile(path.resolve(bodyPath), "utf8");
const timestamp = Math.floor(Date.now() / 1_000);
const signature = createHmac("sha256", secret)
  .update(`${timestamp}.${body}`)
  .digest("hex");
process.stdout.write(`timestamp=${timestamp}\nsignature=${signature}\n`);
