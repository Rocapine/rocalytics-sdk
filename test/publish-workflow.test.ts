import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "publish.yml");

// npm trusted publishing: the npm side is configured against this exact
// filename, so renaming the file silently breaks publishing.
describe("publish workflow (npm trusted publishing)", () => {
  const yml = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, "utf8") : "";

  it("exists at .github/workflows/publish.yml", () => {
    expect(fs.existsSync(WORKFLOW)).toBe(true);
  });

  it("runs on a published GitHub release only", () => {
    expect(yml).toMatch(/on:\s*\n\s+release:\s*\n\s+types:\s*\[published\]/);
    expect(yml).not.toMatch(/^\s+push:/m);
  });

  it("gets an OIDC token and holds no npm token", () => {
    expect(yml).toMatch(/id-token:\s*write/);
    expect(yml).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|secrets\./);
  });

  it("uses an npm new enough for trusted publishing (>= 11.5.1)", () => {
    expect(yml).toMatch(/npm install -g npm@\^11\.5\.1/);
  });

  it("refuses a release tag that does not match the package.json version", () => {
    expect(yml).toContain("GITHUB_REF_NAME#v");
    expect(yml).toContain("require('./package.json').version");
  });

  it("publishes with npm publish, which runs prepublishOnly's checks", () => {
    expect(yml).toMatch(/npm ci/);
    expect(yml).toMatch(/npm publish --tag/);
  });
});
