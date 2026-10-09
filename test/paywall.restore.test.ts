import { describe, expect, it } from "vitest";
import { createPaywallTracker, memoryStorage, type PaywallPresentationSnapshot } from "../src/paywall";
import { flushMicrotasks, ManualTime, MemorySink } from "./fakes";
import { CONTEXT } from "./harness";

const INFO = { moment: "settings_upgrade", paywallId: "pw-1", audienceId: null, renderMode: "custom", billing: "store", surface: "present" } as const;

function launch(storage: ReturnType<typeof memoryStorage>, respond: "accepted" | "transient") {
  const time = new ManualTime();
  const sink = new MemorySink<PaywallPresentationSnapshot>();
  sink.respond = () => ({ outcome: respond });
  const diagnostics: string[] = [];
  const tracker = createPaywallTracker({ sink, context: CONTEXT, storage, clock: time.clock, timers: time.timers, onDiagnostic: (d) => diagnostics.push(d.code) });
  return { time, sink, tracker, diagnostics };
}

describe("paywall tracker persistence", () => {
  it("resends the stored in-progress snapshot unchanged and never fabricates an end", async () => {
    const storage = memoryStorage();
    const first = launch(storage, "transient");
    first.tracker.start(INFO)!.shown();
    await first.time.advance(0);
    await first.tracker.idle();
    first.tracker.dispose();
    // The latest snapshot (seq 2, shown) superseded seq 1 while it was in flight; that is what is stored.
    const stored = Object.values(JSON.parse(Object.values(storage.dump())[0]) as Record<string, { body: PaywallPresentationSnapshot }>);
    expect(stored).toHaveLength(1);
    const lastQueued = stored[0].body;
    expect(lastQueued.seq).toBe(2);

    const second = launch(storage, "accepted");
    await flushMicrotasks();
    await second.time.advance(0);
    expect(second.sink.received).toEqual([lastQueued]);
    expect(second.sink.received.every((s) => s.status === "in_progress")).toBe(true);
    await second.tracker.idle();
    expect(storage.dump()).toEqual({});
  });

  it("an accepted snapshot is removed from storage", async () => {
    const storage = memoryStorage();
    const { time, tracker } = launch(storage, "accepted");
    tracker.start(INFO)!.end({ status: "dismissed" });
    await time.advance(0);
    await tracker.idle();
    expect(storage.dump()).toEqual({});
  });

  it("caps storage at MAX_STORED_PRESENTATIONS, dropping the oldest", async () => {
    const storage = memoryStorage();
    const { time, tracker, diagnostics } = launch(storage, "transient");
    for (let i = 0; i < 22; i++) {
      tracker.start(INFO);
      await time.advance(10);
    }
    await tracker.idle();
    const stored = JSON.parse(Object.values(storage.dump())[0]);
    expect(Object.keys(stored)).toHaveLength(20);
    expect(diagnostics.filter((c) => c === "storage-cap")).toHaveLength(2);
  });

  it("ignores garbage in storage with a diagnostic", async () => {
    const storage = memoryStorage();
    storage.setItem("rocalytics-sdk:paywall-presentations", JSON.stringify({ x: { seq: "no", body: 3 } }));
    const { sink, diagnostics, time } = launch(storage, "accepted");
    await flushMicrotasks();
    await time.advance(0);
    expect(sink.received).toEqual([]);
    expect(diagnostics).toContain("invalid-stored");
  });

  it("start() during the initial load keeps both the restored and the new presentation", async () => {
    const storage = memoryStorage();
    const first = launch(storage, "transient");
    first.tracker.start(INFO);
    await first.time.advance(0);
    await first.tracker.idle();
    first.tracker.dispose();
    const second = launch(storage, "transient");
    second.tracker.start({ ...INFO, paywallId: "pw-2" }); // before load resolves
    await flushMicrotasks();
    await second.tracker.idle();
    const stored = JSON.parse(Object.values(storage.dump())[0]) as Record<string, { body: PaywallPresentationSnapshot }>;
    expect(Object.values(stored).map((o) => o.body.paywall.paywall_id).sort()).toEqual(["pw-1", "pw-2"]);
  });

  it("a failed storage read leaves storage untouched and runs without persistence", async () => {
    const writes: string[] = [];
    const storage = {
      getItem: () => { throw new Error("unavailable"); },
      setItem: (_k: string, v: string) => { writes.push(v); },
      removeItem: () => { writes.push("<removed>"); },
    };
    const time = new ManualTime();
    const sink = new MemorySink<PaywallPresentationSnapshot>();
    sink.respond = () => ({ outcome: "transient" });
    const diagnostics: string[] = [];
    const tracker = createPaywallTracker({ sink, context: CONTEXT, storage, clock: time.clock, timers: time.timers, onDiagnostic: (d) => diagnostics.push(d.code) });
    tracker.start(INFO);
    await flushMicrotasks();
    await time.advance(0);
    await tracker.idle();
    expect(writes).toEqual([]);
    expect(diagnostics).toContain("storage");
  });

  it("start() during the initial load never writes a map without the stored entries", async () => {
    const backing = memoryStorage();
    const first = launch(backing, "transient");
    first.tracker.start(INFO);
    await first.time.advance(0);
    await first.tracker.idle();
    first.tracker.dispose();
    const written: string[][] = [];
    const slow = {
      getItem: async (k: string) => { await flushMicrotasks(5); return backing.getItem(k); },
      setItem: async (k: string, v: string) => {
        written.push(Object.values(JSON.parse(v) as Record<string, { body: PaywallPresentationSnapshot }>).map((o) => o.body.paywall.paywall_id).sort());
        backing.setItem(k, v);
      },
      removeItem: async (k: string) => { backing.removeItem(k); },
    };
    const time = new ManualTime();
    const sink = new MemorySink<PaywallPresentationSnapshot>();
    sink.respond = () => ({ outcome: "transient" });
    const second = createPaywallTracker({ sink, context: CONTEXT, storage: slow, clock: time.clock, timers: time.timers });
    second.start({ ...INFO, paywallId: "pw-2" }); // before the load resolves
    await flushMicrotasks();
    await second.idle();
    expect(written.length).toBeGreaterThan(0);
    for (const w of written) expect(w).toContain("pw-1");
  });
});
