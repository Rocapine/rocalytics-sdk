import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "publish-attest.yml");

// npm trusted publishing for @rocapine/rocalytics-attest: npm trusts this exact
// filename and the `npm` environment, so renaming either breaks publishing.
describe("publish-attest workflow (npm trusted publishing)", () => {
  const yml = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, "utf8") : "";

  it("exists at .github/workflows/publish-attest.yml", () => {
    expect(fs.existsSync(WORKFLOW)).toBe(true);
  });

  it("runs on a published GitHub release only", () => {
    expect(yml).toMatch(/on:\s*\n\s+release:\s*\n\s+types:\s*\[published\]/);
    expect(yml).not.toMatch(/^\s+push:/m);
  });

  it("only runs for attest-v* release tags", () => {
    expect(yml).toMatch(/^ {4}if: \$\{\{ startsWith\(github\.event\.release\.tag_name, 'attest-v'\) \}\}$/m);
  });

  it("refuses a release tag that does not match native/attest/package.json's version", () => {
    expect(yml).toContain("GITHUB_REF_NAME#attest-v");
    expect(yml).toContain("require('./package.json').version");
    expect(yml).toMatch(/working-directory: native\/attest/);
  });

  it("gets an OIDC token and holds no npm token", () => {
    expect(yml).toMatch(/id-token:\s*write/);
    expect(yml).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|secrets\./);
  });

  it("publishes from the `npm` environment, which npm trusts", () => {
    expect(yml).toMatch(/^ {4}environment: npm$/m);
  });

  it("uses an npm new enough for trusted publishing (>= 11.5.1)", () => {
    expect(yml).toMatch(/npm install -g npm@\^11\.5\.1/);
  });

  it("installs and publishes from native/attest (npm publish runs prepack, which builds build/)", () => {
    expect(yml).toMatch(/^ +working-directory: native\/attest$/m);
    expect(yml).toMatch(/npm ci --legacy-peer-deps/);
    expect(yml).toMatch(/npm publish --tag/);
  });
});
