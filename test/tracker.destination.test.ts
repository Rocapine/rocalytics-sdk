// A sink's destination: a reconfigure hands nothing to a tracker that sends
// somewhere else, and stored state written for one destination is never sent
// to another. Test runs sent to a staging collector must never reach the
// production one because both trackers used the same storageKey.
import { describe, expect, it } from "vitest";
import { createHttpSink, memoryStorage } from "../src/core";
import { RocalyticsClient, createRocalyticsOnboardingSink } from "../src/rocalytics";
import type { OnboardingRunSnapshot } from "../src/onboarding";
import { ManualTime, MemorySink } from "./fakes";
import { IDENTITY, MANIFEST, freshProcess, harness } from "./harness";

const KEY = "studio-sdk:onboarding-run";
const STAGING = "https://staging.example.com/v1/onboarding-runs";
const PRODUCTION = "https://collector.example.com/v1/onboarding-runs";

describe("the stock sinks' destination", () => {
  it("createHttpSink: its URL; none when a fetch is injected, which may never reach that URL", () => {
    expect(createHttpSink({ url: PRODUCTION }).destination).toBe(PRODUCTION);
    expect(createHttpSink({ url: PRODUCTION, fetch: async () => ({ text: async () => "" }) }).destination).toBeUndefined();
  });

  it("createRocalyticsOnboardingSink: the client's onboarding endpoint; none when the client has an injected fetch", () => {
    expect(createRocalyticsOnboardingSink(new RocalyticsClient({ onDiagnostic: () => {} })).destination).toBe(
      "https://rocalytics-api.rocapine.io/functions/v1/onboarding-response",
    );
    expect(createRocalyticsOnboardingSink(new RocalyticsClient({ baseUrl: "https://staging.rocapine.io", onDiagnostic: () => {} })).destination).toBe(
      "https://staging.rocapine.io/functions/v1/onboarding-response",
    );
    const mocked = new RocalyticsClient({ fetch: async () => ({ ok: true, status: 204, json: async () => ({}) }) as never, onDiagnostic: () => {} });
    expect(createRocalyticsOnboardingSink(mocked).destination).toBeUndefined();
  });
});

/**
 * Tracker A on the staging destination leaves, in storage and in memory, an
 * in-progress run and another run's completion its sink did not take. Its
 * writes take `writeMs` once A is done.
 */
async function stagingLeftovers(writeMs: number, destination: string | null = STAGING) {
  const time = new ManualTime();
  const inner = memoryStorage();
  const state = { slow: false };
  const storageA = Object.assign({}, inner, {
    setItem: (k: string, v: string) =>
      state.slow && writeMs > 0 ? new Promise<void>((r) => time.timers.setTimeout(() => r(inner.setItem(k, v)), writeMs)) : inner.setItem(k, v),
  });
  const a = harness({ storage: storageA, time, destination, storageReadTimeoutMs: 1000 });
  a.sink.respond = (body) => (body.status === "completed" ? { outcome: "transient" } : { outcome: "accepted" });
  const done = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
  done.enterStep("welcome");
  done.complete();
  await a.tick(1000);
  const open = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
  open.enterStep("welcome");
  await a.tick(1000);
  await a.tracker.idle();
  state.slow = true;
  open.enterStep("goal"); // its write takes writeMs
  await a.tick(0);
  return { time, inner, a, runs: [done.runId, open.runId] };
}

const fromRuns = (runs: string[], received: { run_id: string }[]) => received.filter((s) => runs.includes(s.run_id));

describe("a reconfigure to another destination", () => {
  it.each([0, 30_000])("hands nothing over, and sends nothing of the old tracker's, stored or in memory (writes taking %i ms)", async (writeMs) => {
    const { time, inner, a, runs } = await stagingLeftovers(writeMs);
    a.tracker.dispose();

    const b = harness({ storage: inner, time, destination: PRODUCTION, storageReadTimeoutMs: 1000 });
    let resumed: unknown = "pending";
    void b.tracker.resume().then((r) => (resumed = r));
    await b.tick(60_000); // any late write of A's lands
    expect(resumed).toBeNull();
    expect(fromRuns(runs, b.sink.received)).toEqual([]);
    expect(b.diagnostics.map((d) => d.code)).toContain("destination-changed");
    await b.tracker.idle();
    expect(inner.dump()[KEY] ?? "").not.toMatch(new RegExp(runs.join("|"))); // discarded, a late write's included
    b.kill();

    // Nor does the next launch, on the production destination.
    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), destination: PRODUCTION, create: await freshProcess() });
    expect(await next.tracker.resume()).toBeNull();
    await next.tick(60_000);
    expect(fromRuns(runs, next.sink.received)).toEqual([]);
  });

  it("a new run started before the read is sent, and nothing of the old tracker's", async () => {
    const { time, inner, a, runs } = await stagingLeftovers(30_000);
    a.tracker.dispose();
    const b = harness({ storage: inner, time, destination: PRODUCTION, storageReadTimeoutMs: 1000 });
    const fresh = b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    fresh.enterStep("welcome");
    await b.tick(60_000);
    expect(b.sink.received.map((s) => s.run_id)).toEqual([fresh.runId]);
    expect(fromRuns(runs, b.sink.received)).toEqual([]);
    await b.tracker.idle();
    b.kill();
    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), destination: PRODUCTION, create: await freshProcess() });
    expect((await next.tracker.resume())?.runId).toBe(fresh.runId);
  });

  it("without storage: nothing is handed over", async () => {
    const time = new ManualTime();
    const a = harness({ storage: undefined, time, destination: STAGING });
    a.sink.respond = () => ({ outcome: "transient" });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick(1000);
    a.tracker.dispose();
    const b = harness({ storage: undefined, time, destination: PRODUCTION });
    expect(await b.tracker.resume()).toBeNull();
    await b.tick(60_000);
    expect(b.sink.received).toEqual([]);
  });

  it("through an idle tracker: nothing reaches the tracker after it either", async () => {
    const { time, inner, a, runs } = await stagingLeftovers(30_000);
    a.tracker.dispose();
    harness({ storage: inner, time, destination: PRODUCTION, storageReadTimeoutMs: 1000 }).tracker.dispose();
    const c = harness({ storage: inner, time, destination: PRODUCTION, storageReadTimeoutMs: 1000 });
    let resumed: unknown = "pending";
    void c.tracker.resume().then((r) => (resumed = r));
    await c.tick(60_000);
    expect(resumed).toBeNull();
    expect(fromRuns(runs, c.sink.received)).toEqual([]);
    await c.tracker.idle();
    c.kill();
    const next = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000), destination: PRODUCTION, create: await freshProcess() });
    await next.tick(60_000);
    expect(fromRuns(runs, next.sink.received)).toEqual([]);
  });

  it("sinks without a destination count as different unless they are the same object", async () => {
    const { time, inner, a, runs } = await stagingLeftovers(0, null);
    a.tracker.dispose();
    const b = harness({ storage: inner, time, destination: null });
    await b.tick(60_000);
    expect(fromRuns(runs, b.sink.received)).toEqual([]);
    expect(b.diagnostics.map((d) => d.code)).toContain("destination-changed");
  });
});

describe("a reconfigure to the same destination", () => {
  it.each([
    ["the same URL, on a fresh sink object", PRODUCTION, false],
    ["no destination, the same sink object", null, true],
  ] as const)("%s: the old tracker's unsent snapshots and run are handed over", async (_, destination, reuseSink) => {
    const time = new ManualTime();
    const storage = memoryStorage();
    // With reuseSink, both trackers get one sink object, which forwards to the current MemorySink.
    const target = { sink: new MemorySink<OnboardingRunSnapshot>() };
    const shared = { send: (b: OnboardingRunSnapshot) => target.sink.send(b) };
    const a = harness({ storage, time, destination, ...(reuseSink ? { sinkObject: shared } : {}) });
    (reuseSink ? target.sink : a.sink).respond = () => ({ outcome: "transient" });
    const done = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    done.enterStep("welcome");
    done.complete();
    const open = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    open.enterStep("welcome");
    await a.tick(1000);
    a.tracker.dispose();

    target.sink = new MemorySink<OnboardingRunSnapshot>();
    const b = harness({ storage, time, destination, ...(reuseSink ? { sinkObject: shared } : {}) });
    const received = reuseSink ? target.sink.received : b.sink.received;
    const resumed = await b.tracker.resume();
    await b.tick(1000);
    expect(resumed?.runId).toBe(open.runId);
    expect(received.filter((s) => s.run_id === done.runId).map((s) => s.status)).toEqual(["completed"]);
    expect(b.diagnostics.map((d) => d.code)).not.toContain("destination-changed");
  });
});

describe("stored state written for another destination, at the next launch", () => {
  /** Launch 1 on `first` leaves an in-progress run with a change it never sent, and an unsent completion, then is killed. */
  async function killedLaunch(first: string | null) {
    const time = new ManualTime();
    const storage = memoryStorage();
    const a = harness({ storage, time, destination: first, debounceMs: 5000 });
    a.sink.respond = () => ({ outcome: "transient" });
    const done = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    done.enterStep("welcome");
    done.complete();
    const open = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    open.enterStep("welcome"); // on the debounce: stored as a change never sent
    await a.tick(1000);
    await a.tracker.idle();
    a.kill();
    return { time, storage, runs: [done.runId, open.runId] };
  }

  it.each([
    ["staging, then production", STAGING, PRODUCTION],
    ["a sink without a destination (a mock), then production", null, PRODUCTION],
    ["production, then a sink without a destination", PRODUCTION, null],
  ] as const)("%s: discarded, never sent, and reported", async (_, first, second) => {
    const { time, storage, runs } = await killedLaunch(first);
    const next = harness({ storage, time: new ManualTime(time.clock.now() + 60_000), destination: second, create: await freshProcess() });
    expect(await next.tracker.resume()).toBeNull();
    next.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }); // would send the abandoned run's unsent change
    await next.tick(60_000);
    expect(fromRuns(runs, next.sink.received)).toEqual([]);
    expect(next.diagnostics.map((d) => d.code)).toContain("destination-changed");
    await next.tracker.idle();
    expect(storage.dump()[KEY] ?? "").not.toMatch(new RegExp(runs.join("|")));
  });

  it.each([
    ["the same URL", PRODUCTION],
    ["no destination either time", null],
  ] as const)("%s: kept and delivered", async (_, destination) => {
    const { time, storage, runs } = await killedLaunch(destination);
    const next = harness({ storage, time: new ManualTime(time.clock.now() + 60_000), destination, create: await freshProcess() });
    expect((await next.tracker.resume())?.runId).toBe(runs[1]);
    await next.tick(60_000);
    expect(next.sink.received.some((s) => s.run_id === runs[0] && s.status === "completed")).toBe(true);
  });
});
