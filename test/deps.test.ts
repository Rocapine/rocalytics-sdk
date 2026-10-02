import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The package has no runtime dependency. The tracking core (/onboarding and
// /core) has no dependency of any kind, not even a peer: no source file under
// it imports anything but a relative path. /rocalytics talks to Expo native
// modules, so it declares them as OPTIONAL peers and loads them lazily, from
// one file, with string-literal requires a bundler can see. `npm run
// check:exports` repeats these checks on the built output, transitively.

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** The only packages /rocalytics may load, all optional peers. */
const ROCALYTICS_PEERS = [
  "expo-application",
  "expo-crypto",
  "expo-device",
  "expo-modules-core",
  "expo-network",
  "expo-secure-store",
  "react-native",
];

const listTs = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listTs(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : [],
  );

const IMPORT = /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE = /require\(\s*["']([^"']+)["']\s*\)/g;
const specifiers = (file: string, pattern: RegExp) =>
  [...fs.readFileSync(file, "utf8").matchAll(pattern)].map((m) => m[1] ?? m[2]);
const isRelative = (s: string) => s.startsWith("./") || s.startsWith("../");

describe("dependencies", () => {
  it("the package declares no runtime, optional or bundled dependency", () => {
    for (const field of ["dependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) {
      expect(Object.keys(pkg[field] ?? {}), field).toEqual([]);
    }
  });

  it("its only peers are the /rocalytics native modules, every one of them optional", () => {
    expect(Object.keys(pkg.peerDependencies ?? {}).sort()).toEqual(ROCALYTICS_PEERS);
    expect(Object.keys(pkg.peerDependenciesMeta ?? {}).sort()).toEqual(ROCALYTICS_PEERS);
    for (const name of ROCALYTICS_PEERS) expect(pkg.peerDependenciesMeta[name], name).toEqual({ optional: true });
  });

  it("every peer range is unconstrained: the client's runtime presence probe is the compatibility guard", () => {
    // npm checks an optional peer the app already has, so any range would
    // stop some app that only uses /onboarding from installing the package.
    expect(Object.values(pkg.peerDependencies)).toEqual(ROCALYTICS_PEERS.map(() => "*"));
  });

  it("/onboarding and /core import nothing but relative paths, and require nothing", () => {
    const files = [...listTs(path.join(ROOT, "src/onboarding")), ...listTs(path.join(ROOT, "src/core")), path.join(ROOT, "src/version.ts")];
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      for (const spec of specifiers(f, IMPORT)) expect(isRelative(spec), `${path.relative(ROOT, f)} imports "${spec}"`).toBe(true);
      expect(specifiers(f, REQUIRE), path.relative(ROOT, f)).toEqual([]);
    }
  });

  it("/rocalytics imports only relative paths, and requires its peers from native.ts only", () => {
    const files = listTs(path.join(ROOT, "src/rocalytics"));
    expect(files.length).toBeGreaterThan(3);
    const required: string[] = [];
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      for (const spec of specifiers(f, IMPORT)) expect(isRelative(spec), `${rel} imports "${spec}"`).toBe(true);
      const reqs = specifiers(f, REQUIRE);
      if (rel !== path.join("src", "rocalytics", "native.ts")) expect(reqs, rel).toEqual([]);
      required.push(...reqs);
    }
    expect([...new Set(required)].sort()).toEqual(ROCALYTICS_PEERS);
  });

  it("the tracking module never imports from /rocalytics or a remote-control subpath", () => {
    for (const f of [...listTs(path.join(ROOT, "src/onboarding")), ...listTs(path.join(ROOT, "src/core"))]) {
      const text = fs.readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/from\s+["'][^"']*remote/);
      expect(text, f).not.toMatch(/from\s+["'][^"']*rocalytics/);
    }
  });

  it("exports exactly the shipped subpaths: /onboarding, /core and /rocalytics", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(["./core", "./onboarding", "./package.json", "./rocalytics"]);
    expect(Object.keys(pkg.typesVersions["*"]).sort()).toEqual(["core", "onboarding", "rocalytics"]);
    expect(pkg.files).toContain("rocalytics");
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, "rocalytics/package.json"), "utf8"))).toEqual({
      main: "../dist/rocalytics/index.js",
      types: "../dist/rocalytics/index.d.ts",
    });
  });

  it("packing (npm pack / npm publish) builds dist first, so a clean checkout cannot ship without it", () => {
    expect(pkg.scripts.prepack).toBe("npm run build");
  });
});
