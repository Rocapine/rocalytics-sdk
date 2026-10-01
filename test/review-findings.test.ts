// Regression tests for the findings of the first review of the tracker, one
// describe block per finding (F1 to F7), so each fix is pinned by name.
import { describe, expect, it } from "vitest";
import type { StartOptions } from "../src/onboarding";
import { IDENTITY, MANIFEST, harness } from "./harness";

describe("F1: a null Studio deployment id", () => {
  it("is treated as absent: the run is a draft, and the payload is schema-valid", async () => {
    const h = harness();
    const run = h.tracker.start({ studio: { onboardingId: "abc", deploymentId: null }, manifest: MANIFEST } as unknown as StartOptions);
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.received).toHaveLength(1); // the harness checks it against the schema
    expect(h.sink.last!.onboarding).toEqual({ key: "abc", version: "draft" });
    expect(h.sink.last!.studio).toEqual({ onboarding_id: "abc" });
  });

  it("a non-string identity is an invalid start, never coerced to a string", async () => {
    const bad = [
      { studio: { onboardingId: "abc", deploymentId: 412 } },
      { onboarding: { key: "main", version: null } },
      { onboarding: { key: "main", version: 3 } },
      { onboarding: { key: null, version: "3" } },
    ];
    for (const options of bad) {
      const h = harness();
      const run = h.tracker.start({ ...options, manifest: MANIFEST } as unknown as StartOptions);
      run.enterStep("welcome");
      await h.tick();
      expect(h.sink.received, JSON.stringify(options)).toHaveLength(0);
      expect(h.diagnostics.map((d) => d.code)).toContain("invalid-start");
    }
  });
});

describe("F5: variantKey on a hand-coded run with an empty studio object", () => {
  it.each([{}, { onboardingId: undefined }, { audienceId: null }])("studio %j carries no link, so the run is not Studio-served and keeps variant_key", async (studio) => {
    const h = harness();
    const run = h.tracker.start({ onboarding: { ...IDENTITY, variantKey: "short-intro" }, studio, manifest: MANIFEST } as unknown as StartOptions);
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.last!.onboarding).toEqual({ key: "main", version: "3", variant_key: "short-intro" });
    expect(h.sink.last!.studio).toBeUndefined();
    expect(h.diagnostics.map((d) => d.code)).not.toContain("studio-variant-dropped");
  });
});

describe("F6: the 20-property cap", () => {
  it("cannot be bypassed by a key that exists on Object.prototype", async () => {
    const h = harness();
    const props = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, i]));
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, properties: props });
    run.setProperties({ constructor: 1, valueof: 2, hasownproperty: 3 } as Record<string, number>);
    run.enterStep("welcome");
    await h.tick();
    expect(Object.keys(h.sink.last!.properties!)).toHaveLength(20);
    expect(Object.keys(h.sink.last!.properties!)).not.toContain("constructor");
  });

  it("a property named constructor is still accepted while under the cap", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, properties: { constructor: 1 } as Record<string, number> });
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.last!.properties).toEqual({ constructor: 1 });
  });
});
