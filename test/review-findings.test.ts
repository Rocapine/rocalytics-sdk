// Regression tests for the review findings, one describe block per finding
// (round 1: F1 to F7; round 2: B1, B2, N2), so each fix is pinned by name.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryStorage } from "../src/core";
import type { OnboardingRunSnapshot, StartOptions } from "../src/onboarding";
import { onboardingRun } from "../src/onboarding";
import { ManualTime, MemorySink, flushMicrotasks } from "./fakes";
import { CONTEXT, IDENTITY, MANIFEST, harness } from "./harness";

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

describe("F3: the seq is persisted before the snapshot is handed to the sink", () => {
  /** A storage whose writes can be held (never landing, as when the app dies first), or that runs a hook as each lands. */
  function gatedStorage() {
    const inner = memoryStorage();
    const gate = { hold: false, onWrite: null as null | (() => void) };
    const storage = {
      ...inner,
      setItem(k: string, v: string) {
        if (gate.hold) return new Promise<void>(() => {});
        inner.setItem(k, v);
        gate.onWrite?.();
      },
    };
    return { storage, inner, gate };
  }

  /** Over both launches, one seq never carries two different bodies (the server would keep the first). */
  function expectNoSeqReuse(...bodies: OnboardingRunSnapshot[][]) {
    const bySeq = new Map<string, string>();
    for (const body of bodies.flat()) {
      const k = `${body.run_id}:${body.seq}`;
      const text = JSON.stringify(body);
      if (bySeq.has(k)) expect(text, `seq ${body.seq} sent with two bodies`).toBe(bySeq.get(k));
      bySeq.set(k, text);
    }
  }

  it("killed after the send was prepared but before its write landed: the resumed run never reuses that seq", async () => {
    const { storage, inner, gate } = gatedStorage();
    const time = new ManualTime();
    const a = harness({ storage: storage as typeof inner, time });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick(10_000);
    gate.hold = true; // from here, no write lands
    run.enterStep("goal");
    await a.tick(100); // the app dies 100 ms later
    a.kill();

    const b = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000) });
    await b.tracker.resume();
    await b.tick(0);
    expectNoSeqReuse(a.sink.received, b.sink.received);
    expect(a.sink.received.map((s) => s.seq)).toEqual([1]); // seq 2 never left before it was stored
  });

  it("killed after the write landed but before the send: the snapshot is not lost, even without resume", async () => {
    const { storage, inner, gate } = gatedStorage();
    const time = new ManualTime();
    const a = harness({ storage: storage as typeof inner, time });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick(10_000);
    let writes = 0;
    gate.onWrite = () => {
      if (++writes === 1) a.kill(); // the app dies the moment the first write lands
    };
    run.enterStep("goal");
    await a.tick(1000);
    expect(a.sink.received.map((s) => s.seq)).toEqual([1]);

    const b = harness({ storage: inner, time: new ManualTime(time.clock.now() + 60_000) });
    b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }); // not resumed
    await b.tick(0);
    const old = b.sink.received.filter((s) => s.run_id === run.runId);
    expect(old.map((s) => s.steps.map((e) => e.step_key))).toEqual([["welcome", "goal"]]);
    expectNoSeqReuse(a.sink.received, b.sink.received);
  });

  it("a storage that never finishes a write delays a send by at most persistTimeoutMs", async () => {
    const { storage, gate } = gatedStorage();
    gate.hold = true;
    const h = harness({ storage: storage as ReturnType<typeof memoryStorage>, persistTimeoutMs: 1000 });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick(999);
    expect(h.sink.received).toHaveLength(0);
    await h.tick(1);
    expect(h.sink.received).toHaveLength(1);
  });

  it("without storage, a send is not delayed at all", async () => {
    const h = harness({ storage: undefined });
    h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }).enterStep("welcome");
    await flushMicrotasks();
    expect(h.sink.received).toHaveLength(1);
  });
});

describe("F4: a run started this session abandons the previous launch's run, even if it already completed", () => {
  it("start and complete before storage is read: the old run is not resumable, and its unsent change is delivered", async () => {
    const time = new ManualTime();
    const a = harness({ debounceMs: 5000, time });
    const old = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    old.enterStep("welcome");
    old.background();
    await a.tick(1000);
    old.enterStep("goal"); // waiting on the debounce when the app dies
    await a.tracker.idle();
    a.kill();

    const b = harness({ storage: a.storage, time: new ManualTime(time.clock.now() + 60_000) });
    const fresh = b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }); // before the first storage read
    fresh.enterStep("welcome");
    fresh.complete();
    await b.tracker.idle();
    expect(await b.tracker.resume()).toBeNull();
    await b.tick(0);
    const ofOld = b.sink.received.filter((s) => s.run_id === old.runId);
    expect(ofOld.map((s) => s.steps.map((e) => e.step_key))).toEqual([["welcome", "goal"]]);
    await b.tracker.idle();
    const stored = b.storage.dump()[KEY];
    expect(stored === undefined || JSON.parse(stored).current === null).toBe(true);
  });
});

describe("F7: restore after a kill that followed exitStep", () => {
  it("closes the pre-kill entry at the exitStep time when it is later than last_active_at", async () => {
    const time = new ManualTime();
    const a = harness({ debounceMs: 60_000, time });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick(5_000);
    run.background(); // last_active_at = 5 s
    await a.tick(15_000);
    run.exitStep("welcome"); // left the screen at 20 s; not sent yet (debounce)
    await a.tick(5_000);
    await a.tracker.idle();
    a.kill();

    const b = harness({ storage: a.storage, time: new ManualTime(time.clock.now() + 600_000) });
    await b.tracker.resume();
    await b.tick(0);
    expect(b.sink.last!.steps[0].exited_at).toBe("2026-01-10T08:00:20.000Z");
  });

  it("keeps last_active_at when it is the later of the two", async () => {
    const time = new ManualTime();
    const a = harness({ debounceMs: 60_000, time });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick(5_000);
    run.exitStep("welcome"); // 5 s
    await a.tick(10_000);
    run.background(); // 15 s: still in the foreground on this screen
    await a.tick(1_000);
    await a.tracker.idle();
    a.kill();

    const b = harness({ storage: a.storage, time: new ManualTime(time.clock.now() + 600_000) });
    await b.tracker.resume();
    await b.tick(0);
    expect(b.sink.last!.steps[0].exited_at).toBe("2026-01-10T08:00:15.000Z");
  });
});

// ---------------------------------------------------------------------------
// Second review round.
// ---------------------------------------------------------------------------

describe("B1: dispose() never loses a staged snapshot", () => {
  it("complete() then dispose() at once: the completion reaches the sink, and the next launch does not resume the run", async () => {
    const time = new ManualTime();
    const a = harness({ time });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick(1000);
    run.complete();
    a.tracker.dispose();
    await a.tick(5000);
    expect(a.sink.received.map((s) => [s.seq, s.status])).toEqual([[1, "in_progress"], [2, "completed"]]);

    const b = harness({ storage: a.storage, time: new ManualTime(time.clock.now() + 60_000) });
    expect(await b.tracker.resume()).toBeNull();
    await b.tick(60_000);
    expect(b.sink.received.every((s) => s.status === "completed" && s.seq === 2)).toBe(true);
  });

  it("onboardingRun.configure() again right after complete(): the completion is not lost", async () => {
    const time = new ManualTime();
    const storage = memoryStorage();
    const sink = new MemorySink<OnboardingRunSnapshot>();
    const cfg = { sink, context: CONTEXT, storage, clock: time.clock, timers: time.timers, debounceMs: 0, onDiagnostic: () => {} };
    onboardingRun.configure(cfg);
    const run = onboardingRun.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await time.advance(1000);
    run.complete();
    onboardingRun.configure(cfg); // disposes the first tracker
    await time.advance(5000);
    // The new tracker may send the same completion again (no write after dispose
    // records that it was accepted): same seq, same body, which the ingest ignores.
    const completions = sink.received.filter((s) => s.status === "completed");
    expect(completions.length).toBeGreaterThanOrEqual(1);
    expect(new Set(completions.map((s) => JSON.stringify(s))).size).toBe(1);
    expect(await onboardingRun.resume()).toBeNull();
    await time.advance(60_000);
    expect(sink.received.filter((s) => s.status === "in_progress" && s.seq >= 2)).toEqual([]);
    onboardingRun.dispose();
  });

  it("background() then dispose(), with a change still on the debounce: both survive, and resume() picks them up", async () => {
    const time = new ManualTime();
    const a = harness({ time, debounceMs: 5000 });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.background();
    await a.tick(1000);
    run.enterStep("goal"); // on the debounce
    a.tracker.dispose();
    await a.tick(5000);
    expect(a.sink.last!.steps.map((s) => s.step_key)).toEqual(["welcome", "goal"]);

    const b = harness({ storage: a.storage, time: new ManualTime(time.clock.now() + 60_000) });
    const resumed = await b.tracker.resume();
    await b.tick(0);
    expect(resumed?.runId).toBe(run.runId);
    expect(b.sink.last!.steps.map((s) => s.step_key)).toEqual(["welcome", "goal", "goal"]);
    expect(b.sink.last!.seq).toBe(a.sink.last!.seq + 1);
  });

  it("a completion the sink cannot take at dispose time is kept in storage and delivered by the next launch", async () => {
    const time = new ManualTime();
    const a = harness({ time });
    a.sink.respond = () => ({ outcome: "transient" });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    a.tracker.dispose();
    await a.tick(60_000);
    const attempts = a.sink.received.filter((s) => s.status === "completed").length;
    expect(attempts).toBe(1); // one last attempt, then no retry timers after dispose
    expect(time.pendingTimers).toBe(0);

    const b = harness({ storage: a.storage, time: new ManualTime(time.clock.now() + 60_000) });
    await b.tick(0);
    expect(b.sink.received.map((s) => s.status)).toEqual(["completed"]);
  });

  it("dispose() twice is harmless", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    expect(() => {
      h.tracker.dispose();
      h.tracker.dispose();
    }).not.toThrow();
    await h.tick(60_000);
    expect(h.sink.received.filter((s) => s.status === "completed")).toHaveLength(1);
  });

  it("dispose() with a storage that never finishes: the completion still reaches the sink within persistTimeoutMs", async () => {
    const hanging = Object.assign(memoryStorage(), { setItem: () => new Promise<void>(() => {}) });
    const h = harness({ storage: hanging, persistTimeoutMs: 1000 });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    expect(() => h.tracker.dispose()).not.toThrow();
    await h.tick(1000);
    expect(h.sink.received.map((s) => s.status)).toContain("completed");
  });

  it("after dispose(), the run records nothing more and no new run starts", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    h.tracker.dispose();
    run.enterStep("goal");
    h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }).enterStep("welcome");
    await h.tick(60_000);
    expect(h.sink.received).toHaveLength(1);
  });
});

describe("B2: a failed storage read never deletes or overwrites what it did not read", () => {
  const completedBody = (runId: string) => ({
    schema_version: 1, run_id: runId, seq: 2, status: "completed",
    started_at: "2026-01-10T07:00:00.000Z", completed_at: "2026-01-10T07:00:10.000Z", sent_at: "2026-01-10T07:00:10.000Z",
    onboarding: { key: "main", version: "3" },
    context: { app_version: "2.4.0", build: "412", platform: "ios", os_version: "18.1", locale: "en-US", timezone: "America/New_York" },
    manifest: { steps: [{ step_key: "welcome" }] },
    steps: [{ step_key: "welcome", entered_at: "2026-01-10T07:00:00.000Z", exited_at: "2026-01-10T07:00:10.000Z", answers: [] }],
  });
  const RUN = "00000000-0000-4000-8000-0000000000cc";
  const blob = JSON.stringify({ format: 1, current: null, outboxes: { [RUN]: { seq: 2, body: completedBody(RUN) } } });

  function flakyStorage(failures: number) {
    const inner = memoryStorage();
    inner.setItem(KEY, blob);
    let left = failures;
    return {
      inner,
      storage: Object.assign({}, inner, {
        getItem: (k: string) => (left-- > 0 ? Promise.reject(new Error("read failed")) : inner.getItem(k)),
      }),
    };
  }

  it("a read that fails twice: the stored completion is left untouched, even after a whole run this session", async () => {
    const { inner, storage } = flakyStorage(2);
    const a = harness({ storage: storage as typeof inner });
    a.sink.respond = () => ({ outcome: "transient" });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    await a.tick(5000);
    await a.tracker.idle();
    expect(inner.dump()[KEY]).toBe(blob);
    expect(a.diagnostics.map((d) => d.code)).toContain("storage");
    expect(a.sink.received.some((s) => s.status === "completed")).toBe(true); // this session's run is still sent
    a.tracker.dispose();

    const b = harness({ storage: inner });
    await b.tick(0);
    expect(b.sink.received).toEqual([completedBody(RUN)]);
  });

  it("a read that fails once is retried, and the stored completion is delivered in the same session", async () => {
    const { storage } = flakyStorage(1);
    const h = harness({ storage: storage as ReturnType<typeof memoryStorage> });
    await h.tick(0);
    expect(h.sink.received).toEqual([completedBody(RUN)]);
  });
});

describe("N2: a stored value of an unknown (future) format", () => {
  it("is left untouched, and the session runs without persistence", async () => {
    const storage = memoryStorage();
    const future = JSON.stringify({ format: 2, runs: { r: { unsent: true } } });
    storage.setItem(KEY, future);
    const h = harness({ storage });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    await h.tick(5000);
    await h.tracker.idle();
    expect(storage.dump()[KEY]).toBe(future);
    expect(h.sink.received.map((s) => s.status)).toEqual(["in_progress", "completed"]);
    expect(h.diagnostics.some((d) => d.code === "storage" && /format/.test(d.message))).toBe(true);
    expect(await h.tracker.resume()).toBeNull();
  });
});

describe("B1 follow-up: a write that never settles does not hang the next tracker on the same storage", () => {
  it("configure() after a hanging write: resume() and idle() still resolve within storageReadTimeoutMs, and the session stops writing", async () => {
    const time = new ManualTime();
    const inner = memoryStorage();
    inner.setItem(KEY, JSON.stringify({ format: 1, current: null, outboxes: {} }));
    let hang = true;
    const storage = { ...inner, setItem: (k: string, v: string) => (hang ? new Promise<void>(() => {}) : inner.setItem(k, v)) };
    const sink = new MemorySink<OnboardingRunSnapshot>();
    const diagnostics: string[] = [];
    const cfg = {
      sink, context: CONTEXT, storage, clock: time.clock, timers: time.timers, debounceMs: 0, persistTimeoutMs: 1000, storageReadTimeoutMs: 1000,
      onDiagnostic: (d: { code: string }) => diagnostics.push(d.code),
    };
    onboardingRun.configure(cfg);
    const run = onboardingRun.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    await time.advance(1000);
    onboardingRun.configure(cfg); // the second tracker's read queues behind the hanging write
    hang = false;

    let resumed: unknown = "pending";
    void onboardingRun.resume().then((r) => (resumed = r));
    let idled = false;
    void onboardingRun.idle().then(() => (idled = true));
    await time.advance(1000);
    expect(resumed).toBeNull();
    expect(idled).toBe(true);
    expect(diagnostics).toContain("storage");
    expect(sink.received.some((s) => s.status === "completed")).toBe(true);
    onboardingRun.dispose();
  });
});
