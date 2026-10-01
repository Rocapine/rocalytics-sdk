import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A version bump without a changelog entry fails here.
const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const read = () => fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");

describe("CHANGELOG.md", () => {
  it("has an [Unreleased] section", () => {
    expect(read()).toMatch(/^## \[Unreleased\]$/m);
  });

  it("has a heading for the package's current version", () => {
    const version = pkg.version.replace(/\./g, "\\.");
    expect(read()).toMatch(new RegExp(`^## \\[${version}\\] - (\\d{4}-\\d{2}-\\d{2}|unreleased)$`, "m"));
  });

  it("dates every release heading YYYY-MM-DD, or 'unreleased' before it is published", () => {
    const headings = [...read().matchAll(/^## \[(\d+\.\d+\.\d+)\](.*)$/gm)];
    expect(headings.length).toBeGreaterThan(0);
    for (const [, , rest] of headings) expect(rest).toMatch(/^ - (\d{4}-\d{2}-\d{2}|unreleased)$/);
  });

  it("is shipped in the package", () => {
    expect(pkg.files).toContain("CHANGELOG.md");
  });
});
