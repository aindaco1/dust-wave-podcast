import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { describe, it } from "vitest";

const documentUrl = new URL("../docs/USER_FLOWS.md", import.meta.url);
const document = await readFile(documentUrl, "utf8");
const rows = document
  .split("\n")
  .filter((line) => /^\| (?:LF|MF|AF)-\d{2} \|/u.test(line));
const websiteRoot = new URL("../../dust-wave-new/", import.meta.url);
let websiteCheckoutAvailable = true;

try {
  await access(new URL("package.json", websiteRoot));
} catch {
  websiteCheckoutAvailable = false;
}

async function regressionSource(url, id, surface) {
  const source = await readFile(url, "utf8");
  assert.ok(source.length >= 80, `${id} has empty ${surface} coverage`);
  if (url.pathname.includes("/tests/")) {
    assert.match(
      source,
      /\b(?:describe|it|test)\s*\(/u,
      `${id} ${surface} coverage does not define a test`
    );
  } else {
    assert.match(
      source,
      /\bassert(?:\.|\()/u,
      `${id} ${surface} coverage does not define an assertion`
    );
  }
}

describe("canonical user-flow regression registry", () => {
  it("covers the complete shipped listener, member, and admin inventory", () => {
    assert.equal(rows.length, 21);
    assert.equal(new Set(rows.map((row) => row.split("|")[1].trim())).size, 21);
  });

  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    const [id, persona, entry, success, alternates, health, coverage] = cells;

    it(`${id} defines usable UX and regression coverage`, async () => {
      assert.match(id, /^(?:LF|MF|AF)-\d{2}$/u);
      for (const value of [persona, entry, success, alternates]) {
        assert.ok(value.length >= 12, `${id} has an incomplete UX contract`);
      }
      assert.match(
        health,
        /^(?:Healthy|Healthy with disclosure|Fixed|Guarded)$/u
      );
      const website = coverage.match(/web: `([^`]+)`/u)?.[1];
      const worker = coverage.match(/worker: `([^`]+)`/u)?.[1];
      assert.match(website || "", /^dust-wave-new\/(?:tests|scripts)\//u);
      assert.match(worker || "", /^tests\//u);
      await regressionSource(
        new URL(`../${worker}`, import.meta.url),
        id,
        "Worker"
      );
      if (websiteCheckoutAvailable) {
        await regressionSource(
          new URL(website.replace(/^dust-wave-new\//u, ""), websiteRoot),
          id,
          "website"
        );
      }
    });
  }
});
