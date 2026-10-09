import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

describe("package identity", () => {
  it("is @rocapine/rocalytics-sdk", () => {
    expect(pkg.name).toBe("@rocapine/rocalytics-sdk");
    expect(pkg.repository.url).toBe("https://github.com/Rocapine/rocalytics-sdk.git");
  });

  it("ships /onboarding, /core, /client and /paywall, and no /rocalytics", () => {
    const subpaths = Object.keys(pkg.exports).filter((k) => k !== "./package.json").sort();
    expect(subpaths).toEqual(["./client", "./core", "./onboarding", "./paywall"]);
    expect(Object.keys(pkg.typesVersions["*"]).sort()).toEqual(["client", "core", "onboarding", "paywall"]);
    expect(fs.existsSync(path.join(ROOT, "client", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "rocalytics"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src", "rocalytics"))).toBe(false);
  });

  it("no source, test, script or doc names the old package or subpath", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", ".git", ".superpowers"].includes(d.name)) continue;
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (/\.(ts|mts|mjs|json|md|yml)$/.test(d.name) && d.name !== "CHANGELOG.md" && d.name !== "package-lock.json") {
          const text = fs.readFileSync(p, "utf8");
          if (text.includes("studio-sdk") || /sdk\/rocalytics\b/.test(text)) hits.push(path.relative(ROOT, p));
        }
      }
    };
    walk(ROOT);
    expect(hits.filter((h) => h !== "test/package-name.test.ts")).toEqual([]);
  });
});

describe("public repo hygiene", () => {
  // Built by concatenation so this file does not match itself.
  const banned = [["super", "wall"].join(""), ["onboarding", "studio"].join("-")];

  it("no tracked file names a third-party paywall vendor or a private repo", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", ".git", ".superpowers"].includes(d.name)) continue;
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (/\.(ts|mts|mjs|js|json|md|yml)$/.test(d.name) && d.name !== "package-lock.json") {
          const text = fs.readFileSync(p, "utf8").toLowerCase();
          for (const b of banned) if (text.includes(b)) hits.push(`${path.relative(ROOT, p)}: ${b}`);
        }
      }
    };
    walk(ROOT);
    expect(hits).toEqual([]);
  });
});
