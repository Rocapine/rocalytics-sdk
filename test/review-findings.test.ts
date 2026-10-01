// Regression tests for the findings of the first review of the tracker, one
// describe block per finding (F1 to F7), so each fix is pinned by name.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryStorage } from "../src/core";
import type { StartOptions } from "../src/onboarding";
import { IDENTITY, MANIFEST, harness } from "./harness";

const KEY = "studio-sdk:onboarding-run";

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

describe("F2: malformed stored state", () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  beforeEach(() => {
    rejections.length = 0;
    process.on("unhandledRejection", onRejection);
  });
  afterEach(() => {
    process.off("unhandledRejection", onRejection);
  });

  const VALID_OUTBOX_BODY = {
    schema_version: 1, run_id: "00000000-0000-4000-8000-0000000000aa", seq: 3, status: "in_progress",
    started_at: "2026-01-10T07:00:00.000Z", completed_at: null, sent_at: "2026-01-10T07:00:00.000Z",
    onboarding: { key: "main", version: "3" },
    context: { app_version: "2.4.0", build: "412", platform: "ios", os_version: "18.1", locale: "en-US", timezone: "America/New_York" },
    manifest: { steps: [{ step_key: "welcome" }] },
    steps: [{ step_key: "welcome", entered_at: "2026-01-10T07:00:00.000Z", exited_at: null, answers: [] }],
  };

  const blobs: [string, string][] = [
    ["a null outbox item", JSON.stringify({ format: 1, current: null, outboxes: { x: null } })],
    ["an outbox item with a string seq", JSON.stringify({ format: 1, current: null, outboxes: { x: { seq: "1", body: {} } } })],
    ["an outbox item with no body", JSON.stringify({ format: 1, current: null, outboxes: { x: { seq: 1 } } })],
    ["outboxes as an array", JSON.stringify({ format: 1, current: null, outboxes: [1, 2] })],
    ["a dirty current with no steps", JSON.stringify({ format: 1, current: { status: "in_progress", dirty: true }, outboxes: {} })],
    ["a current that is a string", JSON.stringify({ format: 1, current: "nope", outboxes: {} })],
    ["a current whose steps are not a list", JSON.stringify({ format: 1, current: { status: "in_progress", dirty: true, steps: "x", lastSeq: 1, runId: "r" }, outboxes: {} })],
    ["a number", "42"],
    ["a list", "[]"],
    ["an unknown format", JSON.stringify({ format: 2 })],
    ["not JSON", "{not json"],
  ];

  for (const [name, blob] of blobs) {
    for (const order of ["start before load", "resume", "start after load"] as const) {
      it(`${name} (${order}): no throw, no unhandled rejection, a diagnostic, and the blob is overwritten`, async () => {
        const storage = memoryStorage();
        storage.setItem(KEY, blob);
        const h = harness({ storage });
        if (order === "start before load") h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }).enterStep("welcome");
        if (order === "resume") expect(await h.tracker.resume()).toBeNull();
        if (order === "start after load") {
          await h.tracker.idle();
          h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }).enterStep("welcome");
        }
        await expect(h.tracker.idle()).resolves.toBeUndefined();
        await h.tick();
        await h.tracker.idle();
        await new Promise((r) => setTimeout(r, 0));
        expect(rejections).toEqual([]);
        expect(h.diagnostics.map((d) => d.code)).toContain("storage");
        const stored = storage.dump()[KEY];
        if (order === "resume") {
          expect(stored).toBeUndefined(); // nothing valid to keep: the blob is removed
        } else {
          expect(JSON.parse(stored).format).toBe(1);
          expect(JSON.parse(stored).current.steps[0].step_key).toBe("welcome");
          expect(h.sink.last!.steps[0].step_key).toBe("welcome"); // and the new run is tracked normally
        }
      });
    }
  }

  it("a valid outbox next to an invalid one is still delivered", async () => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify({ format: 1, current: null, outboxes: { bad: null, [VALID_OUTBOX_BODY.run_id]: { seq: 3, body: VALID_OUTBOX_BODY } } }));
    const h = harness({ storage });
    await h.tick();
    expect(h.sink.received).toEqual([VALID_OUTBOX_BODY]);
    expect(h.diagnostics.map((d) => d.code)).toContain("storage");
    expect(rejections).toEqual([]);
  });

  it("a storage whose writes always fail never rejects into the host", async () => {
    const h = harness({
      storage: Object.assign(memoryStorage(), { setItem: () => Promise.reject(new Error("disk full")) }),
    });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await expect(h.tracker.idle()).resolves.toBeUndefined();
    await h.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(rejections).toEqual([]);
    expect(h.sink.received).toHaveLength(1);
  });
});
