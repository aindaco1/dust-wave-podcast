#!/usr/bin/env node

// Compatibility entrypoint; ad plans and clips share one signature contract.
await import("./sign-media-processor-body.mjs");
