import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unsupportedKeywords } from "./miniJsonSchema";
import { DOCS, assertConformant, schema } from "./contract";
import { IN_FLOW_VARIANT, KITCHEN_SINK, OVERFLOW, WORKED_EXAMPLES } from "../docs/onboarding-run.examples";

const ROOT = path.join(__dirname, "..");

describe("the contract copy in docs/", () => {
  it("uses only schema keywords the test validator enforces", () => {
    expect(unsupportedKeywords(schema)).toEqual([]);
  });

  it("every example payload in the doc conforms (schema, section 4, size)", () => {
    const runs = [...KITCHEN_SINK, IN_FLOW_VARIANT, OVERFLOW, ...Object.values(WORKED_EXAMPLES).flatMap((e) => e.runs)];
    expect(runs.length).toBeGreaterThan(10);
    for (const r of runs) assertConformant(r.payload);
  });

  it("the package's public contract types are the doc's types file, byte for byte", () => {
    const docs = fs.readFileSync(path.join(DOCS, "onboarding-run.types.ts"), "utf8");
    const src = fs.readFileSync(path.join(ROOT, "src/onboarding/contract.ts"), "utf8");
    expect(src).toBe(docs);
  });
});

describe("public repository hygiene", () => {
  // The repository is public. These are patterns that should never appear in a
  // published file: local machine paths and private links.
  const files = [
    "README.md",
    ...fs.readdirSync(DOCS).map((f) => `docs/${f}`),
    ...listTs(path.join(ROOT, "src")).map((f) => path.relative(ROOT, f)),
  ];
  const denied = [/\/Users\//, /~\/Developer/, /claude\.ai\//];

  for (const f of files) {
    it(`${f} carries no local paths or private links`, () => {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const pattern of denied) expect(text).not.toMatch(pattern);
    });
  }
});

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listTs(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : [],
  );
}
