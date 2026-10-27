// `studio.variant_key`: which variant of a Studio onboarding was served ("main"
// for the parent). It is a Studio link, distinct from `onboarding.variant_key`,
// the app's own in-flow variant, and the two never share a key, in the snapshot
// or in the pre-v1 `onboarding_metadata`.
import { describe, expect, it } from "vitest";
import type { OnboardingRunSnapshot, StartOptions } from "../src/onboarding";
import { toOnboardingResponsePayload, toOnboardingRunBody } from "../src/client";
import { assertConformant } from "./contract";
import { IDENTITY, MANIFEST, harness } from "./harness";

async function startAndSend(options: unknown) {
  const h = harness();
  const run = h.tracker.start({ ...(options as object), manifest: MANIFEST } as unknown as StartOptions);
  run.enterStep("welcome");
  await h.tick();
  return h;
}

describe("studio.variantKey", () => {
  it.each([
    ["the reserved parent value", "main"],
    ["a variant key", "b"],
    ["128 characters", "v".repeat(128)],
    ["128 code points outside the BMP", "😀".repeat(128)],
  ])("%s is sent as studio.variant_key", async (_, variantKey) => {
    const h = await startAndSend({ studio: { onboardingId: "87", deploymentId: "412", variantKey } });
    expect(h.diagnostics.map((d) => d.code)).not.toContain("invalid-start");
    expect(h.sink.last!.studio).toEqual({ onboarding_id: "87", deployment_id: "412", variant_key: variantKey });
    assertConformant(h.sink.last!);
  });

  it.each([null, undefined])("%s is left out", async (variantKey) => {
    const h = await startAndSend({ studio: { onboardingId: "87", variantKey } });
    expect(h.sink.last!.studio).toEqual({ onboarding_id: "87" });
  });

  it.each([
    ["an empty string", ""],
    ["129 characters", "v".repeat(129)],
    ["a number", 3],
    ["a boolean", true],
  ])("%s is an invalid start: nothing is recorded", async (_, variantKey) => {
    const h = await startAndSend({ studio: { onboardingId: "87", variantKey } });
    expect(h.sink.received).toHaveLength(0);
    const start = h.diagnostics.find((d) => d.code === "invalid-start");
    expect(start?.message).toContain("studio.variant_key must be 1 to 128 characters");
  });

  it("a U+0000 is repaired like the other links", async () => {
    const h = await startAndSend({ studio: { onboardingId: "87", variantKey: "b\u0000" } });
    expect(h.sink.last!.studio).toEqual({ onboarding_id: "87", variant_key: "b" });
    expect(h.diagnostics.map((d) => d.code)).toContain("text-repaired");
  });
});

describe("studio.variant_key and onboarding.variant_key are kept apart", () => {
  it("a hand-coded run with only studio.variantKey keeps its own variant: variant_key alone does not make it Studio-served", async () => {
    const h = await startAndSend({ onboarding: { ...IDENTITY, variantKey: "short-intro" }, studio: { variantKey: "b" } });
    const s = h.sink.last!;
    expect(s.onboarding).toEqual({ key: "main", version: "3", variant_key: "short-intro" });
    expect(s.studio).toEqual({ variant_key: "b" });
    expect(h.diagnostics.map((d) => d.code)).not.toContain("studio-variant-dropped");
    const { onboarding_metadata } = toOnboardingResponsePayload(s);
    expect(onboarding_metadata).toMatchObject({ variant_key: "short-intro", studio_variant_key: "b" });
  });

  it("a Studio-served run still drops onboarding.variantKey, and keeps studio.variantKey", async () => {
    const h = await startAndSend({ onboarding: { ...IDENTITY, variantKey: "short-intro" }, studio: { onboardingId: "87", variantKey: "main" } });
    const s = h.sink.last!;
    expect(s.onboarding).toEqual({ key: "main", version: "3" });
    expect(s.studio).toEqual({ onboarding_id: "87", variant_key: "main" });
    expect(h.diagnostics.map((d) => d.code)).toContain("studio-variant-dropped");
    const { onboarding_metadata } = toOnboardingResponsePayload(s);
    expect(onboarding_metadata).toMatchObject({ studio_variant_key: "main" });
    expect(onboarding_metadata).not.toHaveProperty("variant_key");
  });

  it("a snapshot carrying both keeps both, under different metadata keys", () => {
    const snapshot: OnboardingRunSnapshot = {
      schema_version: 1,
      run_id: "0b0e7a9e-2f43-4c8b-9d1e-6a5f4c3b2a10",
      seq: 1,
      sent_at: "2026-01-10T08:00:01.000Z",
      status: "in_progress",
      started_at: "2026-01-10T08:00:00.000Z",
      completed_at: null,
      onboarding: { key: "main", version: "3", variant_key: "short-intro" },
      studio: { variant_key: "b" },
      context: { app_version: "1.0.0", build: "1", platform: "ios", os_version: "18.0", locale: "en-US", timezone: "Europe/Paris" },
      manifest: { steps: [{ step_key: "welcome" }] },
      steps: [{ step_key: "welcome", entered_at: "2026-01-10T08:00:00.000Z", exited_at: null, answers: [] }],
    };
    assertConformant(snapshot);
    const body = toOnboardingRunBody(snapshot);
    expect(body.onboarding.variant_key).toBe("short-intro");
    expect(body.studio?.variant_key).toBe("b");
    expect(body.onboarding_metadata?.variant_key).toBe("short-intro");
    expect(body.onboarding_metadata?.studio_variant_key).toBe("b");
  });

  it("a run without studio.variantKey sends no studio_variant_key", async () => {
    const h = await startAndSend({ studio: { onboardingId: "87", deploymentId: "412" } });
    expect(h.sink.last!.studio).not.toHaveProperty("variant_key");
    expect(toOnboardingResponsePayload(h.sink.last!).onboarding_metadata).not.toHaveProperty("studio_variant_key");
  });
});
