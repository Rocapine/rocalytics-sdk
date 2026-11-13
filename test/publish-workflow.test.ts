import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "publish.yml");

// npm trusted publishing: the npm side is configured against this exact
// filename, so renaming the file silently breaks publishing.
describe("publish workflow (npm trusted publishing)", () => {
  const yml = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, "utf8") : "";
  // The publish job, up to the next job; the notify job after it may use secrets.
  const publishJob = yml.split(/^ {2}publish:$/m)[1]?.split(/^ {2}\S/m)[0] ?? "";

  it("exists at .github/workflows/publish.yml", () => {
    expect(fs.existsSync(WORKFLOW)).toBe(true);
  });

  it("runs on a published GitHub release only", () => {
    expect(yml).toMatch(/on:\s*\n\s+release:\s*\n\s+types:\s*\[published\]/);
    expect(yml).not.toMatch(/^\s+push:/m);
  });

  it("gets an OIDC token and holds no npm token", () => {
    expect(yml).toMatch(/id-token:\s*write/);
    expect(yml).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/);
    expect(publishJob).toMatch(/npm publish/);
    expect(publishJob).not.toMatch(/secrets\./);
  });

  it("publishes from the `npm` environment, which npm trusts", () => {
    expect(publishJob).toMatch(/^ {4}environment: npm$/m);
  });

  it("tells roca-chandler about the release only after it is published", () => {
    expect(yml).toMatch(/^ {2}notify-roca-chandler:\n {4}needs: publish$/m);
    expect(yml).toContain("repos/Rocapine/roca-chandler/dispatches");
    expect(yml).toContain("event_type=sdk-released");
  });

  it("gives the notify job no inherited permissions (it only uses the App token it mints)", () => {
    expect(yml).toMatch(/^ {2}notify-roca-chandler:\n {4}needs: publish\n {4}permissions: \{\}$/m);
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
