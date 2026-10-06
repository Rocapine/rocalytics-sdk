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

  // The same late write, when the replaced tracker's completion was not taken
  // at dispose: it lands in storage, but the new tracker never read it, so the
  // new tracker's next write (any change) composes only its own outboxes and
  // erases it. Without that next write, the next launch still delivers it.
  it.each([
    [true, 0],
    [false, 1],
  ] as const)("the new tracker writes again: %s, so the next launch delivers %i completion of the old run", async (writesAgain, delivered) => {
    const { time, inner, state, storageA } = setUp(30_000);
    const a = harness({ storage: storageA, time, storageReadTimeoutMs: 1000 });
    a.sink.respond = () => ({ outcome: "transient" });
    const old = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    old.enterStep("welcome");
    await a.tick(1000);
    await a.tracker.idle();

    state.slow = true;
    old.complete();
    a.tracker.dispose(); // one last attempt, answered transient, and a write that lands past B's bound

    const b = harness({ storage: inner, time, storageReadTimeoutMs: 1000 });
    const fresh = b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    fresh.enterStep("welcome");
    await b.tick(5000); // B has read storage, before A's write lands
    await b.tick(30_000); // A's write lands now, holding the old run's completion
    if (writesAgain) {
      fresh.enterStep("goal");
      await b.tick(1000);
      await b.tracker.idle();
    }
    b.kill();

    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000) });
    await next.tick(60_000);
    const completions = next.sink.received.filter((s) => s.run_id === old.runId && s.status === "completed");
    expect(completions).toHaveLength(delivered);
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

  // Without storage the relaunch starts empty, so its 0 cannot fail on its own:
  // what pins the loss is the helper's checks that the one last attempt was the
  // only one and that no retry timer is left.
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

describe("item 5 (fixed): a numeric Studio id is sent in decimal", () => {
  it.each([
    ["onboardingId", { studio: { onboardingId: 87 } }, { onboarding_id: "87" }, { key: "87", version: "draft" }],
    ["deploymentId", { studio: { onboardingId: "87", deploymentId: 412 } }, { onboarding_id: "87", deployment_id: "412" }, { key: "87", version: "412" }],
    ["audienceId", { onboarding: IDENTITY, studio: { audienceId: 5 } }, { audience_id: "5" }, { key: "main", version: "3" }],
    ["each id at once, 0 included", { studio: { onboardingId: 0, deploymentId: Number.MAX_SAFE_INTEGER, audienceId: 0 } }, { onboarding_id: "0", deployment_id: "9007199254740991", audience_id: "0" }, { key: "0", version: "9007199254740991" }],
  ])("%s as a number, passed at run time, is sent as its decimal string", async (_, options, studio, onboarding) => {
    const h = harness();
    const run = h.tracker.start({ ...options, manifest: MANIFEST } as unknown as StartOptions);
    run.enterStep("welcome");
    await h.tick();
    expect(h.diagnostics.map((d) => d.code)).not.toContain("invalid-start");
    expect(h.sink.last!.studio).toEqual(studio);
    expect(h.sink.last!.onboarding).toEqual(onboarding);
  });

  it.each([
    ["studio: null", { onboarding: IDENTITY, studio: null }],
    ["a fractional deploymentId", { studio: { onboardingId: "87", deploymentId: 412.5 } }],
    ["a negative onboardingId", { studio: { onboardingId: -87 } }],
    ["a NaN audienceId", { onboarding: IDENTITY, studio: { audienceId: NaN } }],
    ["an infinite audienceId", { onboarding: IDENTITY, studio: { audienceId: Infinity } }],
    ["an unsafe integer deploymentId", { studio: { onboardingId: "87", deploymentId: 2 ** 53 } }],
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
