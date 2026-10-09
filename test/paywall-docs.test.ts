import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unsupportedKeywords } from "./miniJsonSchema";
import { DOCS, acceptPresentation, assertPresentationConformant, presentationSchema } from "./paywall-contract";
import { ALL_EXAMPLES, PURCHASED_ANDROID, RENDER_ERROR } from "../docs/paywall-presentation.examples";

const ROOT = path.join(__dirname, "..");
const withoutImport = (s: string) => s.replace(/^import type \{ RunContext, Timestamp \} from "[^"]+";$/m, "");

describe("paywall presentation contract copy in docs/", () => {
  it("uses only schema keywords the test validator enforces", () => {
    expect(unsupportedKeywords(presentationSchema)).toEqual([]);
  });

  it("every example payload conforms", () => {
    for (const p of ALL_EXAMPLES) assertPresentationConformant(p);
  });

  it("src/paywall/contract.ts is the docs types file, except its import line", () => {
    const docs = fs.readFileSync(path.join(DOCS, "paywall-presentation.types.ts"), "utf8");
    const src = fs.readFileSync(path.join(ROOT, "src/paywall/contract.ts"), "utf8");
    expect(withoutImport(src)).toBe(withoutImport(docs));
    expect(src).toMatch(/from "\.\.\/onboarding\/contract";/);
  });

  it("acceptance: higher seq replaces, ended is terminal, immutable fields are enforced", () => {
    const [s1, s2, s3] = PURCHASED_ANDROID;
    expect(acceptPresentation(null, s1)).toBe("accepted");
    expect(acceptPresentation(s1, s2)).toBe("accepted");
    expect(acceptPresentation(s2, s1)).toBe("ignored");
    expect(acceptPresentation(s3, { ...s2, seq: 9 })).toBe("ignored");
    expect(acceptPresentation(s1, { ...s2, paywall: { ...s2.paywall, paywall_id: "other" } })).toBe("rejected");
    expect(acceptPresentation(null, { ...RENDER_ERROR, outcome: { status: "dismissed", reason: "x" } })).toBe("rejected");
  });

  it("rejects a purchase transaction on a non-purchase outcome, and an empty transaction", () => {
    const end = PURCHASED_ANDROID[2];
    expect(acceptPresentation(null, { ...end, outcome: { status: "dismissed", transaction: { product_id: "p" } } })).toBe("rejected");
    expect(acceptPresentation(null, { ...end, outcome: { status: "purchased", transaction: {} } })).toBe("rejected");
  });

  it("P12: a price or any unknown transaction field is rejected", () => {
    const end = PURCHASED_ANDROID[2];
    const withPrice = { ...end, outcome: { status: "purchased", transaction: { product_id: "p", price: 9.99 } } };
    expect(acceptPresentation(null, withPrice)).toBe("rejected");
  });
});
