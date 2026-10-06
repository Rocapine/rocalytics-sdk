// The tracker's known limits, as the README's "Known limits of the tracker"
// section states them (studio-sdk#5, items 1 to 5). Each is intended
// behaviour, pinned here so a change to it also changes the README. Item 2 is
// already pinned in review-findings.test.ts ("N-a"), and item 4's untruncated
// restore in tracker.restore.test.ts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../src/core";
import type { StartOptions } from "../src/onboarding";
import { ManualTime } from "./fakes";
import { IDENTITY, MANIFEST, harness } from "./harness";

const KEY = "studio-sdk:onboarding-run";
const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

describe("the README's known limits of the tracker", () => {
  const section = readme.split(/^## /m).find((s) => s.startsWith("Known limits of the tracker\n")) ?? "";

  it("has its own section", () => {
    expect(section).not.toBe("");
  });

  it.each([
    "A late write from a replaced tracker.",
    "Slow storage.",
    "No working storage at dispose.",
    "The resumed screen.",
    "Numeric Studio ids.",
  ])("names the limit %s", (label) => {
    expect(section).toContain(`**${label}**`);
  });
});

describe("item 1: a replaced tracker's write that lands after the new tracker's bounded wait", () => {
  /** Tracker A's storage: writes made once `slow` is set land `delayMs` later. */
  function setUp(delayMs: number) {
    const time = new ManualTime();
    const inner = memoryStorage();
    const state = { slow: false };
    const storageA = Object.assign({}, inner, {
      setItem: (k: string, v: string) =>
        state.slow ? new Promise<void>((r) => time.timers.setTimeout(() => r(inner.setItem(k, v)), delayMs)) : inner.setItem(k, v),
    });
    return { time, inner, state, storageA };
  }

  const storedRunId = (inner: ReturnType<typeof memoryStorage>) =>
    (JSON.parse(inner.dump()[KEY]) as { current: { runId: string } | null }).current?.runId ?? null;

  it.each([
    [500, "within", true],
    [30_000, "past", false],
  ] as const)("a write taking %i ms, %s the bound: the next launch can resume the new tracker's run: %s", async (delayMs, _, resumable) => {
    const { time, inner, state, storageA } = setUp(delayMs);
    const a = harness({ storage: storageA, time, storageReadTimeoutMs: 1000 });
    const old = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    old.enterStep("welcome");
    await a.tick(1000);
    await a.tracker.idle();

    state.slow = true;
    old.complete(); // its write is queued, and takes delayMs to land
    a.tracker.dispose(); // B's read waits for A's writes, at most A's idle() bound (about 1,000 ms here)

    const b = harness({ storage: inner, time, storageReadTimeoutMs: 1000 });
    const fresh = b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    fresh.enterStep("welcome");
    await b.tick(5000);
    await b.tick(30_000); // a write past the bound lands now, over B's
    b.kill();

    expect(storedRunId(inner) === fresh.runId).toBe(resumable);
    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000) });
    const resumed = await next.tracker.resume();
    expect(resumed?.runId === fresh.runId).toBe(resumable);
  });
});

describe("item 3: a completion whose last attempt at dispose() fails", () => {
  /** Completes a run, disposes with a sink that answers transient, then launches again on `storage`. */
  async function disposeThenRelaunch(storage: ReturnType<typeof memoryStorage> | undefined) {
    const time = new ManualTime();
    const a = harness({ storage, time });
    a.sink.respond = () => ({ outcome: "transient" });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    a.tracker.dispose();
    await a.tick(60_000);
    expect(a.sink.received.filter((s) => s.status === "completed")).toHaveLength(1); // the last attempt
    expect(time.pendingTimers).toBe(0); // and no retry timer is left

    const next = harness({ storage: storage ?? memoryStorage(), time });
    await next.tick(60_000);
    return next.sink.received.filter((s) => s.run_id === run.runId && s.status === "completed");
  }

  it("is kept for the next launch with working storage", async () => {
    expect(await disposeThenRelaunch(memoryStorage())).toHaveLength(1);
  });

  it("is lost without storage", async () => {
    expect(await disposeThenRelaunch(undefined)).toHaveLength(0);
  });
});

describe("item 4: resuming a truncated run", () => {
  it("records no entry for the restored screen, and currentStepKey is the last step recorded before the limit", async () => {
    const time = new ManualTime();
    const a = harness({ time });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    for (let i = 0; i < 501; i++) {
      run.enterStep(i % 2 ? "goal" : "experience");
      await a.tick(1000);
    }
    run.enterStep("summary"); // the screen the user is on: past the limit, so not recorded
    await a.tick(1000);
    const beforeKill = a.sink.last!;
    expect(beforeKill.truncated).toBe(true);
    await a.tracker.idle();
    a.kill();

    const b = harness({ storage: a.storage, time: new ManualTime(time.clock.now() + 60_000) });
    const resumed = await b.tracker.resume();
    await b.tick(0);
    expect(resumed?.currentStepKey).toBe(beforeKill.steps[beforeKill.steps.length - 1].step_key);
    expect(resumed?.currentStepKey).not.toBe("summary");
    expect(b.sink.last!.steps).toHaveLength(beforeKill.steps.length);
  });
});

describe("item 5: Studio links must be strings, and studio an object or absent", () => {
  it.each([
    ["studio: null", { onboarding: IDENTITY, studio: null }],
    ["a numeric onboardingId", { studio: { onboardingId: 87 } }],
    ["a numeric deploymentId", { studio: { onboardingId: "87", deploymentId: 412 } }],
    ["a numeric audienceId", { onboarding: IDENTITY, studio: { audienceId: 5 } }],
  ])("%s is an invalid start: nothing is recorded", async (_, options) => {
    const h = harness();
    const run = h.tracker.start({ ...options, manifest: MANIFEST } as unknown as StartOptions);
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.received).toHaveLength(0);
    expect(h.diagnostics.map((d) => d.code)).toContain("invalid-start");
  });

  it("the same id as a decimal string is sent", async () => {
    const h = harness();
    const run = h.tracker.start({ studio: { onboardingId: String(87), deploymentId: String(412), audienceId: String(5) }, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.last!.studio).toEqual({ onboarding_id: "87", deployment_id: "412", audience_id: "5" });
    expect(h.sink.last!.onboarding).toEqual({ key: "87", version: "412" });
  });
});
