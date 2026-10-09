import { describe, expect, it } from "vitest";
import { createPaywallTracker, type PaywallPresentationSnapshot } from "../src/paywall";
import { ManualTime, MemorySink } from "./fakes";
import { CONTEXT } from "./harness";
import { assertPresentationConformant } from "./paywall-contract";

const INFO = { moment: "settings_upgrade", paywallId: "pw-1", audienceId: null, renderMode: "custom", billing: "store", surface: "present" } as const;

function setup() {
  const time = new ManualTime();
  const sink = new MemorySink<PaywallPresentationSnapshot>();
  const diagnostics: string[] = [];
  const tracker = createPaywallTracker({ sink, context: CONTEXT, clock: time.clock, timers: time.timers, onDiagnostic: (d) => diagnostics.push(d.code) });
  return { time, sink, diagnostics, tracker };
}

describe("createPaywallTracker", () => {
  it("sends start, shown and end, each conformant, for one presentation", async () => {
    const { time, sink, tracker } = setup();
    const h = tracker.start(INFO)!;
    h.shown();
    await time.advance(1_000);
    h.end({ status: "dismissed" });
    await time.advance(0);
    expect(sink.received.map((s) => [s.seq, s.status])).toEqual([[1, "in_progress"], [2, "in_progress"], [3, "ended"]]);
    for (const s of sink.received) assertPresentationConformant(s);
    expect(new Set(sink.received.map((s) => s.presentation_id)).size).toBe(1);
  });

  it("two presentations get distinct ids", async () => {
    const { time, sink, tracker } = setup();
    tracker.start(INFO)!.end({ status: "dismissed" });
    tracker.start(INFO)!.end({ status: "dismissed" });
    await time.advance(0);
    expect(new Set(sink.received.map((s) => s.presentation_id)).size).toBe(2);
  });

  it("presentation B never supersedes A's unsent end", async () => {
    const { time, sink, tracker } = setup();
    sink.respond = () => ({ outcome: "transient" });
    const a = tracker.start(INFO)!;
    a.shown();
    a.end({ status: "purchased", transaction: { originalTransactionIdentifier: "2000000123" } });
    tracker.start({ ...INFO, paywallId: "pw-2" })!.end({ status: "dismissed" });
    await time.advance(0);
    sink.respond = () => ({ outcome: "accepted" });
    await time.advance(120_000);
    const ended = sink.received.filter((s) => s.status === "ended");
    expect(new Set(ended.map((s) => s.paywall.paywall_id))).toEqual(new Set(["pw-1", "pw-2"]));
  });

  it("start never throws: invalid info, a throwing context and a throwing sink", async () => {
    const time = new ManualTime();
    const diagnostics: string[] = [];
    const bad = createPaywallTracker({
      sink: { send: () => { throw new Error("boom"); } },
      context: () => { throw new Error("no context"); },
      clock: time.clock, timers: time.timers, onDiagnostic: (d) => diagnostics.push(d.code),
    });
    expect(bad.start(INFO)).toBeUndefined();
    expect(bad.start({ ...INFO, paywallId: "" } as never)).toBeUndefined();
    expect(diagnostics).toEqual(expect.arrayContaining(["invalid-context", "invalid-info"]));

    const ok = createPaywallTracker({ sink: { send: () => { throw new Error("boom"); } }, context: CONTEXT, clock: time.clock, timers: time.timers, onDiagnostic: () => {} });
    const h = ok.start(INFO)!;
    expect(() => { h.shown(); h.end({ status: "dismissed" }); }).not.toThrow();
    await time.advance(1_000);
  });

  it("a handle used wrongly reports a diagnostic and sends nothing more", async () => {
    const { time, sink, diagnostics, tracker } = setup();
    const h = tracker.start(INFO)!;
    h.end({ status: "dismissed" });
    h.end({ status: "purchased" });
    h.shown();
    await time.advance(0);
    expect(sink.received.filter((s) => s.status === "ended")).toHaveLength(1);
    expect(diagnostics).toEqual(expect.arrayContaining(["already-ended", "after-end"]));
  });

  it("a rejected snapshot is reported and not retried", async () => {
    const { time, sink, diagnostics, tracker } = setup();
    sink.respond = () => ({ outcome: "rejected", reason: "schema" });
    tracker.start(INFO);
    await time.advance(120_000);
    expect(sink.received).toHaveLength(1);
    expect(diagnostics).toContain("rejected");
  });

  it("captures context once per presentation, from a function", async () => {
    const time = new ManualTime();
    let calls = 0;
    const sink = new MemorySink<PaywallPresentationSnapshot>();
    const t = createPaywallTracker({ sink, context: () => (calls++, CONTEXT), clock: time.clock, timers: time.timers });
    const h = t.start(INFO)!;
    h.shown();
    h.end({ status: "dismissed" });
    await time.advance(0);
    expect(calls).toBe(1);
  });
});
