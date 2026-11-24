import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

  it("the tag check exits 1 on a tag/version mismatch, 0 on a match", () => {
    const step = /- name: Release tag matches native\/attest\/package\.json version\n\s+run: \|\n((?:\s{10}.*\n)+)/.exec(yml);
    expect(step).not.toBeNull();
    const script = step![1]!.replace(/^ {10}/gm, "");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-tag-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
      const run = (tag: string) => spawnSync("bash", ["-c", script], { cwd: dir, env: { ...process.env, GITHUB_REF_NAME: tag }, encoding: "utf8" });
      const mismatch = run("attest-v0.2.0");
      expect(mismatch.status).toBe(1);
      expect(mismatch.stdout).toContain("::error::tag attest-v0.2.0 does not match native/attest/package.json version 0.1.0");
      expect(run("attest-v0.1.0").status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
