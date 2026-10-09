// Items 1 to 5 of rocalytics-sdk#5. Items 1, 2 and 5 are fixed, and item 3 on a
// reconfigure; the tests marked "fixed" pin the fix. What is still a limit (item
// 4, and item 3 when the app is killed without storage) is stated in the
// README's "Known limits of the tracker" section and pinned here, so a change
// to it also changes the README. Item 2 is pinned in review-findings.test.ts
// ("N-a"), and item 4's untruncated restore in tracker.restore.test.ts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../src/core";
import type { StartOptions } from "../src/onboarding";
import { ManualTime } from "./fakes";
import { IDENTITY, MANIFEST, freshProcess, harness } from "./harness";

// Recording 500 entries one tick at a time takes seconds, past Vitest's 5 s default under load.
const SLOW_MS = 20_000;

const KEY = "rocalytics-sdk:onboarding-run";
const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

describe("the README's known limits of the tracker", () => {
  const section = readme.split(/^## /m).find((s) => s.startsWith("Known limits of the tracker\n")) ?? "";

  it("has its own section", () => {
    expect(section).not.toBe("");
  });

  it.each([
    "An app killed without working storage.",
    "The resumed screen.",
  ])("names the limit %s", (label) => {
    expect(section).toContain(`**${label}**`);
  });
});

describe("item 1 (fixed): a replaced tracker's write that lands after the new tracker's bounded wait", () => {
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
    [500, "within"],
    [30_000, "past"],
  ] as const)("a write taking %i ms, %s the bound: the next launch can resume the new tracker's run", async (delayMs, _) => {
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
    await b.tick(30_000); // a write past the bound lands now, over B's; B writes its state again
    b.kill();

    expect(storedRunId(inner)).toBe(fresh.runId);
    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), create: await freshProcess() });
    const resumed = await next.tracker.resume();
    expect(resumed?.runId).toBe(fresh.runId);
  });

  // The replaced tracker's completion, whether or not its last attempt at
  // dispose delivered it, and whether or not its write lands within the bound:
  // delivered exactly once, counting the next launch. B's sink accepts.
  describe.each([
    [0, "a write within the bound"],
    [30_000, "a write past the bound"],
  ] as const)("%i ms: %s", (delayMs, _) => {
    it.each([
      ["accepted", true],
      ["accepted", false],
      ["transient", true],
      ["transient", false],
    ] as const)("A's last attempt answered %s, the new tracker writes again: %s: delivered once", async (lastAttempt, writesAgain) => {
      const { time, inner, state, storageA } = setUp(delayMs);
      const a = harness({ storage: storageA, time, storageReadTimeoutMs: 1000 });
      a.sink.respond = (body) => (body.status === "completed" ? { outcome: lastAttempt } : { outcome: "accepted" });
      const old = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
      old.enterStep("welcome");
      await a.tick(1000);
      await a.tracker.idle();

      state.slow = delayMs > 0;
      old.complete();
      a.tracker.dispose(); // one last attempt, and a write that may land past B's bound

      const b = harness({ storage: inner, time, storageReadTimeoutMs: 1000 });
      const fresh = b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
      fresh.enterStep("welcome");
      await b.tick(5000);
      await b.tick(30_000); // a late write of A's lands now
      if (writesAgain) {
        fresh.enterStep("goal");
        await b.tick(1000);
        await b.tracker.idle();
      }
      b.kill();

      const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), create: await freshProcess() });
      await next.tick(60_000);
      const completions = (h: typeof a) => h.sink.received.filter((s) => s.run_id === old.runId && s.status === "completed").length;
      const delivered = (lastAttempt === "accepted" ? completions(a) : 0) + completions(b) + completions(next);
      expect(delivered).toBe(1);
      expect(completions(b)).toBe(lastAttempt === "accepted" ? 0 : 1); // the new tracker delivers it this session
    });
  });
});

describe("item 1 (fixed): the new tracker calls resume() before a late write of the replaced tracker lands", () => {
  /** Tracker A, whose writes land 30 s late once `slow` is set, with storage or without. */
  async function setUp(withStorage: boolean) {
    const time = new ManualTime();
    const inner = memoryStorage();
    const state = { slow: false };
    const storageA = Object.assign({}, inner, {
      setItem: (k: string, v: string) =>
        state.slow ? new Promise<void>((r) => time.timers.setTimeout(() => r(inner.setItem(k, v)), 30_000)) : inner.setItem(k, v),
    });
    const storage = withStorage ? inner : undefined;
    const a = harness({ storage: withStorage ? storageA : undefined, time, storageReadTimeoutMs: 1000 });
    const old = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    old.enterStep("welcome");
    await a.tick(1000);
    await a.tracker.idle();
    state.slow = true;
    return { time, inner, storage, a, old };
  }

  // The new tracker reads the state written before the slow write: the run
  // still in progress at seq 1. It is handed the newer state instead.
  it.each(["accepted", "transient"] as const)("a run the replaced tracker completed (last attempt %s) is not resumed, and its completion is delivered once", async (lastAttempt) => {
    const { time, inner, a, old } = await setUp(true);
    a.sink.respond = (body) => (body.status === "completed" ? { outcome: lastAttempt } : { outcome: "accepted" });
    old.complete(); // seq 2, completed; its write lands 30 s later
    a.tracker.dispose();

    const b = harness({ storage: inner, time, storageReadTimeoutMs: 1000 });
    let resumed: unknown = "pending";
    void b.tracker.resume().then((r) => (resumed = r));
    await b.tick(60_000);
    expect(resumed).toBeNull();
    await b.tracker.idle();
    b.kill();

    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), create: await freshProcess() });
    expect(await next.tracker.resume()).toBeNull();
    await next.tick(60_000);
    const sent = [...b.sink.received, ...next.sink.received].filter((s) => s.run_id === old.runId);
    expect(sent.filter((s) => s.status === "in_progress")).toEqual([]); // no seq reused after completed
    const accepted = (lastAttempt === "accepted" ? 1 : 0) + sent.filter((s) => s.status === "completed").length;
    expect(accepted).toBe(1);
  });

  it.each([true, false])("a run still in progress is resumed from the replaced tracker's newest state (storage: %s), and its seq continues", async (withStorage) => {
    const { time, inner, storage, a, old } = await setUp(withStorage);
    old.enterStep("goal"); // seq 2; with storage, its write lands 30 s later
    await a.tick(2000);
    expect(a.sink.last).toMatchObject({ seq: 2, status: "in_progress" });
    a.tracker.dispose();

    const b = harness({ storage, time, storageReadTimeoutMs: 1000 });
    let resumed: { runId: string } | null = null;
    void b.tracker.resume().then((r) => (resumed = r));
    await b.tick(5000);
    expect(resumed!.runId).toBe(old.runId);
    expect(b.sink.received.map((s) => [s.seq, s.steps.map((e) => e.step_key)])).toEqual([[3, ["welcome", "goal", "goal"]]]);
    if (!withStorage) return;

    await b.tick(30_000); // A's late write lands; B writes its own state again
    await b.tracker.idle();
    b.kill();
    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), create: await freshProcess() });
    const again = await next.tracker.resume();
    await next.tick(0);
    expect(again?.runId).toBe(old.runId);
    expect(next.sink.last!.seq).toBe(4);
  });
});

describe("item 1 (fixed): the replaced tracker's last attempt still in flight when the new tracker starts", () => {
  it.each(["accepted", "transient"] as const)("answered %s after 2 s: the new tracker waits for the answer, and the completion is delivered once", async (answer) => {
    const time = new ManualTime();
    const storage = memoryStorage();
    const a = harness({ storage, time });
    a.sink.respond = (body) =>
      body.status === "completed" ? new Promise((r) => time.timers.setTimeout(() => r({ outcome: answer }), 2000)) : { outcome: "accepted" };
    const old = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    old.enterStep("welcome");
    await a.tick(1000);
    old.complete();
    await a.tick(0); // written, then handed to the sink: the attempt is in flight
    a.tracker.dispose();

    const b = harness({ storage, time });
    await b.tick(1000);
    expect(b.sink.received).toHaveLength(0); // not while A's attempt may still deliver it
    await b.tick(60_000);
    const completions = (h: typeof a) => h.sink.received.filter((s) => s.run_id === old.runId && s.status === "completed").length;
    expect(completions(b)).toBe(answer === "accepted" ? 0 : 1);
  });
});

describe("item 1 (fixed): the app killed while the replaced tracker's last attempt is unanswered", () => {
  // A's completion attempt answers only after 20 s; the app is killed at 6 s,
  // after a late write of A's (5 s) has landed over B's state. Whatever B did
  // meanwhile, storage must still hold the completion for the next launch.
  it.each([
    [0, false],
    [0, true],
    [5000, false],
    [5000, true],
  ] as const)("A's writes take %i ms, the new tracker starts a run: %s: the next launch delivers the completion", async (writeMs, bStarts) => {
    const time = new ManualTime();
    const inner = memoryStorage();
    const state = { slow: false };
    const storageA = Object.assign({}, inner, {
      setItem: (k: string, v: string) =>
        state.slow ? new Promise<void>((r) => time.timers.setTimeout(() => r(inner.setItem(k, v)), writeMs)) : inner.setItem(k, v),
    });
    const a = harness({ storage: storageA, time, storageReadTimeoutMs: 1000 });
    a.sink.respond = (body) =>
      body.status === "completed" ? new Promise((r) => time.timers.setTimeout(() => r({ outcome: "accepted" }), 20_000)) : { outcome: "accepted" };
    const old = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    old.enterStep("welcome");
    await a.tick(1000);
    await a.tracker.idle();
    state.slow = writeMs > 0;
    old.complete();
    a.tracker.dispose();

    const b = harness({ storage: inner, time, storageReadTimeoutMs: 1000 });
    const fresh = bStarts ? b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }) : null;
    fresh?.enterStep("welcome");
    await b.tick(6000);
    a.kill();
    b.kill(); // before A's attempt is answered

    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), create: await freshProcess() });
    const resumed = await next.tracker.resume();
    expect(resumed?.runId ?? null).toBe(fresh?.runId ?? null); // B's run stays resumable
    await next.tick(60_000);
    expect(next.sink.received.filter((s) => s.run_id === old.runId && s.status === "completed")).toHaveLength(1);
  });
});

describe("item 1 (fixed): a handoff through trackers created and disposed without a run", () => {
  /** Creates and disposes `idle` trackers on the key at once (two configure() in a row), then the one that stays. */
  function through(idle: number, storage: ReturnType<typeof memoryStorage> | undefined, time: ManualTime) {
    for (let i = 0; i < idle; i++) harness({ storage, time, storageReadTimeoutMs: 1000 }).tracker.dispose();
    return harness({ storage, time, storageReadTimeoutMs: 1000 });
  }

  /** A's run, with writes that land 30 s late once `slow` is set (with storage). */
  async function setUp(withStorage: boolean) {
    const time = new ManualTime();
    const inner = memoryStorage();
    const state = { slow: false };
    const storageA = Object.assign({}, inner, {
      setItem: (k: string, v: string) =>
        state.slow ? new Promise<void>((r) => time.timers.setTimeout(() => r(inner.setItem(k, v)), 30_000)) : inner.setItem(k, v),
    });
    const a = harness({ storage: withStorage ? storageA : undefined, time, storageReadTimeoutMs: 1000 });
    const old = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    old.enterStep("welcome");
    await a.tick(1000);
    await a.tracker.idle();
    state.slow = true;
    return { time, inner, storage: withStorage ? inner : undefined, a, old };
  }

  it("an idle tracker disposed seconds before the next one is created still passes on the old tracker's writes still to land", async () => {
    const { time, inner, a, old } = await setUp(true);
    old.enterStep("goal"); // seq 2; its write lands 30 s later
    await a.tick(2000);
    a.tracker.dispose();
    harness({ storage: inner, time, storageReadTimeoutMs: 1000 }).tracker.dispose(); // B: idle
    await a.tick(5000); // B's own writes are long done

    const c = harness({ storage: inner, time, storageReadTimeoutMs: 1000 });
    const resumed = await c.tracker.resume();
    expect(resumed?.runId).toBe(old.runId);
    await c.tick(60_000); // A's late write lands over C's state; C writes it again
    await c.tracker.idle();
    c.kill();

    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), create: await freshProcess() });
    expect((await next.tracker.resume())?.runId).toBe(old.runId);
    await next.tick(0);
    expect(next.sink.last!.steps.map((e) => e.step_key)).toEqual(["welcome", "goal", "goal", "goal"]);
  });

  describe.each([1, 2])("through %i idle tracker(s)", (idle) => {
    it.each([true, false])("a run in progress is resumed from its newest state (storage: %s)", async (withStorage) => {
      const { time, inner, storage, a, old } = await setUp(withStorage);
      old.enterStep("goal"); // seq 2; with storage, its write lands 30 s later
      await a.tick(2000);
      a.tracker.dispose();

      const last = through(idle, storage, time);
      let resumed: { runId: string } | null = null;
      void last.tracker.resume().then((r) => (resumed = r));
      await last.tick(5000);
      expect(resumed!.runId).toBe(old.runId);
      expect(last.sink.received.map((s) => [s.seq, s.steps.map((e) => e.step_key)])).toEqual([[3, ["welcome", "goal", "goal"]]]);
      if (!withStorage) return;

      await last.tick(60_000); // A's late writes land; the last tracker writes its state again
      await last.tracker.idle();
      last.kill();
      const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), create: await freshProcess() });
      expect((await next.tracker.resume())?.runId).toBe(old.runId);
      await next.tick(0);
      expect(next.sink.last!.seq).toBe(4);
    });

    it.each(["accepted", "transient"] as const)("a run A completed (last attempt %s) is not resumed, and its completion is delivered once", async (lastAttempt) => {
      const { time, inner, a, old } = await setUp(true);
      a.sink.respond = (body) => (body.status === "completed" ? { outcome: lastAttempt } : { outcome: "accepted" });
      old.complete(); // seq 2, completed; its write lands 30 s later
      a.tracker.dispose();

      const last = through(idle, inner, time);
      let resumed: unknown = "pending";
      void last.tracker.resume().then((r) => (resumed = r));
      await last.tick(60_000);
      expect(resumed).toBeNull();
      await last.tracker.idle();
      last.kill();

      const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), create: await freshProcess() });
      expect(await next.tracker.resume()).toBeNull();
      await next.tick(60_000);
      const sent = [...last.sink.received, ...next.sink.received].filter((s) => s.run_id === old.runId);
      expect(sent.filter((s) => s.status === "in_progress")).toEqual([]);
      expect((lastAttempt === "accepted" ? 1 : 0) + sent.filter((s) => s.status === "completed").length).toBe(1);
    });
  });
});

describe("item 3 (fixed on a reconfigure): a completion whose last attempt fails", () => {
  /** Completes a run with a sink that answers transient, then ends the tracker: disposed (a reconfigure) or killed. */
  async function completeThenEnd(storage: ReturnType<typeof memoryStorage> | undefined, end: "dispose" | "kill") {
    const time = new ManualTime();
    const a = harness({ storage, time });
    a.sink.respond = () => ({ outcome: "transient" });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    if (end === "dispose") {
      a.tracker.dispose();
      await a.tick(60_000);
      expect(a.sink.received.filter((s) => s.status === "completed")).toHaveLength(1); // the last attempt
      expect(time.pendingTimers).toBe(0); // and no retry timer is left
    } else {
      await a.tick(1000);
      a.kill();
    }
    const completions = (h: { sink: typeof a.sink }) => h.sink.received.filter((s) => s.run_id === run.runId && s.status === "completed");
    return { time, completions };
  }

  it("a reconfigure without storage: the next tracker delivers it", async () => {
    const { time, completions } = await completeThenEnd(undefined, "dispose");
    const b = harness({ storage: undefined, time });
    await b.tick(1000);
    expect(completions(b)).toHaveLength(1);
  });

  it("a reconfigure with working storage: the next tracker delivers it, and the next launch does not send it again", async () => {
    const storage = memoryStorage();
    const { time, completions } = await completeThenEnd(storage, "dispose");
    const b = harness({ storage, time });
    await b.tick(1000);
    expect(completions(b)).toHaveLength(1);
    await b.tracker.idle();
    b.kill();
    const next = harness({ storage, time, create: await freshProcess() });
    await next.tick(60_000);
    expect(completions(next)).toHaveLength(0);
  });

  it("the app killed with working storage: the next launch delivers it", async () => {
    const storage = memoryStorage();
    const { time, completions } = await completeThenEnd(storage, "kill");
    const next = harness({ storage, time, create: await freshProcess() });
    await next.tick(60_000);
    expect(completions(next)).toHaveLength(1);
  });

  // Still a limit. Only dispose() hands a snapshot over in memory, so a tracker
  // created after a kill, even in the same process and on the same key, gets
  // nothing; the reconfigure case above shows the same set-up delivering it.
  it("the app killed without storage: it is lost", async () => {
    const { time, completions } = await completeThenEnd(undefined, "kill");
    const b = harness({ storage: undefined, time });
    await b.tick(60_000);
    expect(completions(b)).toHaveLength(0);
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
  }, SLOW_MS);
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
