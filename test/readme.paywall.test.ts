import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const example = fs.readFileSync(path.join(ROOT, "examples/native-paywall.ts"), "utf8");

describe("README: paywall", () => {
  it("lists /paywall as a public subpath, not a placeholder", () => {
    expect(readme).toMatch(/\| `@rocapine\/rocalytics-sdk\/paywall` \| The paywall presentation tracker\. Public API\. \|/);
    expect(readme).not.toMatch(/paywall` \| Placeholder/);
  });
  it("embeds examples/native-paywall.ts verbatim", () => {
    expect(readme).toContain(example.trim());
  });

  it("the example takes platform and locale from the device, never hard-coded", () => {
    expect(example).not.toMatch(/platform: "(ios|android)",/);
    expect(example).not.toMatch(/locale: "[a-z]{2}-[A-Z]{2}",/);
  });
});
