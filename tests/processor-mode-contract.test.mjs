import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const sourceFiles = [
  "alignment-jobs.ts",
  "audio-enhancement-derivatives.ts",
  "audio-masters.ts",
  "audio-qc.ts",
  "delivery-audio.ts"
];

test("every admin processor surface uses the shared mode projection", () => {
  for (const filename of sourceFiles) {
    const source = readFileSync(new URL(`../src/${filename}`, import.meta.url),
      "utf8");
    expect(source).toMatch(/describeProcessorAvailability/u);
    expect(source).not.toMatch(/mode: "staging_manual"/u);
  }
  const delivery = readFileSync(
    new URL("../src/delivery-audio.ts", import.meta.url),
    "utf8"
  );
  expect(delivery).toMatch(
    /manualDispatchOnly: processor\.mode !== "staging_automatic"/u
  );
});
