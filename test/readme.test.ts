import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkThrough, openOnboarding } from "../examples/hand-coded-onboarding";
import { onboardingRun } from "../src/onboarding";
import { ManualTime, MemorySink } from "./fakes";
import { CONTEXT } from "./harness";
import { assertConformant } from "./contract";
import type { OnboardingRunSnapshot } from "../src/onboarding";

const ROOT = path.join(__dirname, "..");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const example = fs.readFileSync(path.join(ROOT, "examples/hand-coded-onboarding.ts"), "utf8");

describe("the README's hand-coded onboarding example", () => {
  it("is examples/hand-coded-onboarding.ts verbatim, so tsc checks what the README shows", () => {
    expect(readme).toContain("```ts\n" + example + "```");
  });

  it("uses only the public /onboarding entry point", () => {
    const imports = [...example.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["@rocapine/studio-sdk/onboarding"]);
  });

  it.each([
    ["practice", true, ["welcome", "goal", "level_advanced", "done"]],
    ["learn", false, ["welcome", "goal", "level_beginner", "notifications", "done"]],
  ] as const)("run with goal %s (notifications granted: %s) sends a conformant completed run", async (goal, granted, path_) => {
    const time = new ManualTime();
    const sink = new MemorySink<OnboardingRunSnapshot>();
    onboardingRun.configure({ sink, context: CONTEXT, clock: time.clock, timers: time.timers, debounceMs: 0 });
    const run = await openOnboarding(false);
    walkThrough(run, goal, granted);
    await time.advance(0);
    for (const s of sink.received) assertConformant(s);
    expect(sink.last!.status).toBe("completed");
    expect(sink.last!.steps.map((s) => s.step_key)).toEqual(path_);
    onboardingRun.dispose();
  });

  it("with a storage read that never answers, opening with restorePosition falls back to start() after its timeout", async () => {
    const time = new ManualTime();
    const sink = new MemorySink<OnboardingRunSnapshot>();
    const hung = { getItem: () => new Promise<string | null>(() => {}), setItem: () => {}, removeItem: () => {} };
    // Its own key: nothing on this storage ever settles.
    onboardingRun.configure({ sink, context: CONTEXT, storage: hung, storageKey: "test:example-hung", clock: time.clock, timers: time.timers, debounceMs: 0, onDiagnostic: () => {} });
    const run = await openOnboarding(true, 10); // a real 10 ms timeout: resume() alone would never resolve
    walkThrough(run, "practice", true);
    await time.advance(1000); // persistTimeoutMs: sends do not wait for the read
    expect(sink.last!.status).toBe("completed");
    onboardingRun.dispose();
  });
});
