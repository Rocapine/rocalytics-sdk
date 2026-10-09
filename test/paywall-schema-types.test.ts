import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { presentationSchema } from "./paywall-contract";
import { schemaToTs } from "./schemaToTs";

// Lock 1 of 2 on drift between the paywall presentation schema and its public
// types. Lock 2 is test/paywall-contract-types.typetest.ts.
// Regenerate after a schema change: `npm run gen:schema-types`.
const GENERATED = path.join(__dirname, "paywall-schema-types.generated.ts");
const HEADER = [
  "// Generated from docs/paywall-presentation.schema.json by test/paywall-schema-types.test.ts.",
  "// Do not edit. Regenerate with `npm run gen:schema-types`.",
  "",
].join("\n");

describe("paywall schema -> TypeScript", () => {
  const generated = `${HEADER}export type PresentationFromSchema = ${schemaToTs(presentationSchema)};\n`;
  if (process.env.UPDATE_SCHEMA_TYPES === "1") fs.writeFileSync(GENERATED, generated);
  it("the checked-in generated type is what the schema generates", () => {
    expect(fs.readFileSync(GENERATED, "utf8")).toBe(generated);
  });
});
