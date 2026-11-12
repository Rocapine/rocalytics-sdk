import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/release.mjs and scripts/changelog-section.mjs, run as the release
// does, on a temp copy. The fixtures are the files before and after the 0.10.0
// release commit (61efd05), so "reproduces its 4-file shape" is byte-exact.
const ROOT = path.join(__dirname, "..");
const FIXTURES = path.join(ROOT, "test", "fixtures", "release");
const FILES = ["package.json", "package-lock.json", "src/version.ts", "CHANGELOG.md"];

const run = (script: string, args: string[]) =>
  spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8" });

const temps: string[] = [];
const tempCopy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-script-"));
  temps.push(dir);
  fs.cpSync(path.join(FIXTURES, "before"), dir, { recursive: true });
  return dir;
};
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scripts/release.mjs", () => {
  it("reproduces the 0.10.0 release commit's four files byte for byte", () => {
    const dir = tempCopy();
    const res = run("release.mjs", ["0.10.0", "--root", dir, "--date", "2026-11-10"]);
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    for (const file of FILES) expect(read(dir, file), file).toBe(read(path.join(FIXTURES, "after"), file));
  });

  it("leaves a dependency's version in the lockfile alone", () => {
    const dir = tempCopy();
    run("release.mjs", ["0.10.0", "--root", dir, "--date", "2026-11-10"]);
    expect(JSON.parse(read(dir, "package-lock.json")).packages["node_modules/vitest"].version).toBe("0.9.0");
  });

  it("makes src/version.ts export the new version", () => {
    const dir = tempCopy();
    run("release.mjs", ["0.10.0", "--root", dir, "--date", "2026-11-10"]);
    expect(read(dir, "src/version.ts")).toContain('export const LIBRARY_VERSION = "0.10.0";');
  });

  it("accepts a prerelease above the current version", () => {
    const dir = tempCopy();
    expect(run("release.mjs", ["0.10.0-rc.1", "--root", dir, "--date", "2026-11-10"]).status).toBe(0);
    expect(JSON.parse(read(dir, "package.json")).version).toBe("0.10.0-rc.1");
  });

  it.each([
    ["is not semver", "0.10"],
    ["is not semver (leading v)", "v0.10.0"],
    ["equals the current version", "0.9.0"],
    ["is below the current version", "0.8.9"],
    ["is a prerelease of the current version", "0.9.0-rc.1"],
  ])("refuses a version that %s, and changes nothing", (_why, version) => {
    const dir = tempCopy();
    const res = run("release.mjs", [version, "--root", dir, "--date", "2026-11-10"]);
    expect(res.status).toBe(1);
    expect(res.stderr).not.toBe("");
    for (const file of FILES) expect(read(dir, file), file).toBe(read(path.join(FIXTURES, "before"), file));
  });

  it("refuses when [Unreleased] is empty, and changes nothing", () => {
    const dir = tempCopy();
    fs.cpSync(path.join(FIXTURES, "after"), dir, { recursive: true });
    const res = run("release.mjs", ["0.11.0", "--root", dir, "--date", "2026-11-12"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Unreleased/);
    for (const file of FILES) expect(read(dir, file), file).toBe(read(path.join(FIXTURES, "after"), file));
  });
});

describe("scripts/changelog-section.mjs", () => {
  const changelog = path.join(FIXTURES, "after", "CHANGELOG.md");

  it("prints the body of a version's section, up to the next section", () => {
    const res = run("changelog-section.mjs", ["0.10.0", "--file", changelog]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^### Added\n- `getRandomValues` option/);
    expect(res.stdout).toMatch(/A `reset\(\)` before the load still starts a new one\.\n$/);
    expect(res.stdout).not.toContain("## [");
  });

  it("matches the whole version literally, not a prefix or a pattern", () => {
    expect(run("changelog-section.mjs", ["0.10", "--file", changelog]).status).toBe(1);
    const dir = tempCopy();
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "## [Unreleased]\n\n## [1x2x3] - 2026-01-01\n- x\n");
    expect(run("changelog-section.mjs", ["1.2.3", "--file", path.join(dir, "CHANGELOG.md")]).status).toBe(1);
  });

  it("exits 1 for a version with no section", () => {
    const res = run("changelog-section.mjs", ["9.9.9", "--file", changelog]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(/9\.9\.9/);
  });

  it("reads the repo's CHANGELOG.md by default", () => {
    const res = run("changelog-section.mjs", ["0.9.0"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("@rocapine/rocalytics-sdk/analytics");
  });
});
