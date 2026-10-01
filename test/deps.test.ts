import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The tracking core has no dependency on a renderer, router or UI library:
// it has no dependency at all. Proven two ways: the manifest declares none,
// and no source file imports anything but a relative path. `npm run
// check:exports` repeats the second check on the built output.

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const listTs = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listTs(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : [],
  );

describe("dependencies", () => {
  it("the package declares no runtime, peer, optional or bundled dependency", () => {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) {
      expect(Object.keys(pkg[field] ?? {}), field).toEqual([]);
    }
  });

  it("no source file imports a package: every import is relative", () => {
    const files = listTs(path.join(ROOT, "src"));
    expect(files.length).toBeGreaterThan(5);
    const specifier = /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(specifier)) {
        const spec = m[1] ?? m[2] ?? m[3];
        expect(spec.startsWith("./") || spec.startsWith("../"), `${path.relative(ROOT, f)} imports "${spec}"`).toBe(true);
      }
    }
  });

  it("the tracking module never imports from a remote-control subpath", () => {
    for (const f of listTs(path.join(ROOT, "src/onboarding"))) {
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/from\s+["'][^"']*remote/);
    }
  });

  it("exports exactly the shipped subpaths: /onboarding and /core", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(["./core", "./onboarding", "./package.json"]);
  });
});
