import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLATFORM_COMMIT = "d075c3e1a29134d3ba6e4631b76dc63212347d14";
const PLATFORM_REMOTE = "https://github.com/aindaco1/dust-wave-platform.git";
const PLATFORM_PACKAGES = {
  "@dustwave/admin-shell": "0.10.2",
  "@dustwave/media-core": "0.3.0",
  "@dustwave/tax-core": "0.2.0",
  "@dustwave/timed-text": "0.5.0",
  "@dustwave/worker-core": "0.7.0"
};
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function readJson(path) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

describe("shared platform pin", () => {
  it("uses the reviewed immutable checkout and canonical HTTPS remote", () => {
    const checkout = execFileSync(
      "git",
      ["-C", "shared/dust-wave-platform", "rev-parse", "HEAD"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    ).trim();
    const gitmodules = readFileSync(
      new URL("../.gitmodules", import.meta.url),
      "utf8"
    );

    expect(checkout).toBe(PLATFORM_COMMIT);
    expect(gitmodules).toContain(`url = ${PLATFORM_REMOTE}`);
  });

  it("keeps every local package dependency and lock entry aligned", () => {
    const manifest = readJson("package.json");
    const lock = readJson("package-lock.json");

    for (const [name, version] of Object.entries(PLATFORM_PACKAGES)) {
      const directory = name.slice("@dustwave/".length);
      const packagePath = `shared/dust-wave-platform/packages/${directory}`;
      const sharedManifest = readJson(`${packagePath}/package.json`);

      expect(manifest.dependencies?.[name]).toBe(`file:${packagePath}`);
      expect(sharedManifest).toMatchObject({ name, version });
      expect(lock.packages?.[`node_modules/${name}`]).toMatchObject({
        resolved: packagePath,
        link: true
      });
      expect(lock.packages?.[packagePath]).toMatchObject({ name, version });
    }
  });
});
