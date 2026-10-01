import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { schema } from "./contract";
import { schemaToTs } from "./schemaToTs";

// Lock 1 of 2 on drift between the JSON Schema and the public types: the type
// generated from the schema is checked in, and must be what the schema
// generates today. Lock 2 is test/contract-types.typetest.ts, which `tsc`
// (`npm run type:check:tests`) fails unless that generated type equals the
// public `OnboardingRunSnapshot`, field for field.
//
// Regenerate after a schema change: `npm run gen:schema-types`.

const GENERATED = path.join(__dirname, "schema-types.generated.ts");
const HEADER = [
  "// Generated from docs/onboarding-run.schema.json by test/schema-types.test.ts.",
  "// Do not edit. Regenerate with `npm run gen:schema-types`.",
  "",
].join("\n");

describe("schema -> TypeScript", () => {
  const generated = `${HEADER}export type SnapshotFromSchema = ${schemaToTs(schema)};\n`;

  if (process.env.UPDATE_SCHEMA_TYPES === "1") fs.writeFileSync(GENERATED, generated);

  it("the checked-in generated type is what the schema generates", () => {
    expect(fs.readFileSync(GENERATED, "utf8")).toBe(generated);
  });

  it("refuses a keyword it does not understand rather than ignoring it", () => {
    expect(() => schemaToTs({ type: "string", format: "date-time" })).toThrow(/format/);
    expect(() => schemaToTs({ type: "object", properties: { a: { type: "string" } } })).toThrow(/additionalProperties/);
  });

  it("maps the shapes the contract uses", () => {
    expect(schemaToTs({ const: 1 })).toBe("1");
    expect(schemaToTs({ enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(schemaToTs({ type: ["string", "null"] })).toBe("string | null");
    expect(schemaToTs({ type: "array", items: { type: "integer" } })).toBe("Array<number>");
    expect(
      schemaToTs({ type: "object", required: ["a"], additionalProperties: false, properties: { a: { type: "boolean" }, b: { type: "string" } } }),
    ).toBe("{\n  a: boolean;\n  b?: string;\n}");
  });
});
