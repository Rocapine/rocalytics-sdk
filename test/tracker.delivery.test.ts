import { describe, expect, it } from "vitest";
import type { SinkResult } from "../src/core";
import { IDENTITY, MANIFEST, harness } from "./harness";

describe("seq and snapshots", () => {
  it("seq starts at 1 and rises with every send; each send is a full snapshot", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    for (const step of ["welcome", "goal", "experience", "summary"]) {
      run.enterStep(step);
      await h.tick();
    }
    run.background();
    run.complete();
    await h.tick();
    const seqs = h.sink.received.map((s) => s.seq);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    h.sink.received.forEach((s, i) => expect(s.steps.length).toBe(Math.min(i + 1, 4)));
  });

  it("a retry reuses the same seq and the same body", async () => {
    const h = harness();
    h.sink.respond = (_b, n) => (n < 3 ? { outcome: "transient" } : { outcome: "accepted" });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick(0);
    await h.tick(1000);
    await h.tick(2000);
    expect(h.sink.received).toHaveLength(3);
    expect(new Set(h.sink.received.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  it("changes within the debounce window go out as one send; complete() does not wait", async () => {
    const h = harness({ debounceMs: 500 });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.exitStep("welcome");
    run.enterStep("goal");
    await h.tick(499);
    expect(h.sink.received).toHaveLength(0);
    await h.tick(1);
    expect(h.sink.received).toHaveLength(1);
    expect(h.sink.last!.steps).toHaveLength(2);
    run.complete();
    await h.tick(0);
    expect(h.sink.last!.status).toBe("completed");
  });

  it("background() sends at once, so the server's last-received time moves", async () => {
    const h = harness({ debounceMs: 5000 });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.background();
    await h.tick(0);
    expect(h.sink.received).toHaveLength(1);
  });
});

describe("a failing sink", () => {
  it("never throws into the host, and the latest snapshot still arrives once the sink recovers", async () => {
    const h = harness();
    let down = true;
    h.sink.respond = () => {
      if (down) throw new Error("network down");
      return { outcome: "accepted" };
    };
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    expect(() => {
      run.enterStep("welcome");
      run.enterStep("goal");
      run.exitStep("goal", { answers: [{ questionKey: "goal", kind: "single", value: "learn" }] });
      run.enterStep("summary");
    }).not.toThrow();
    await h.tick(5000);
    down = false;
    await h.tick(60_000);
    const accepted = h.sink.last!;
    expect(accepted.steps.map((s) => s.step_key)).toEqual(["welcome", "goal", "summary"]);
    expect(accepted.steps[1].answers).toHaveLength(1);
  });

  it("an in-progress send in flight, then complete(), then a transient answer: the completed snapshot is what goes next", async () => {
    const h = harness();
    let release!: (r: SinkResult) => void;
    h.sink.respond = () => new Promise<SinkResult>((r) => (release = r));
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick(0);
    run.complete();
    await h.tick(0);
    expect(h.sink.received).toHaveLength(1);
    h.sink.respond = () => ({ outcome: "accepted" });
    release({ outcome: "transient" });
    await h.tick(60_000);
    expect(h.sink.received.map((s) => s.status)).toEqual(["in_progress", "completed"]);
  });

  it("a completed snapshot is retried on every unclear answer and never dropped", async () => {
    const h = harness();
    const unclear: SinkResult[] = [{ outcome: "transient" }, { outcome: "transient", reason: "401" }, { outcome: "transient", reason: "timeout" }];
    h.sink.respond = (_b, n) => unclear[n - 1] ?? { outcome: "accepted" };
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    await h.tick(60_000);
    const statuses = h.sink.received.map((s) => s.status);
    expect(statuses[statuses.length - 1]).toBe("completed");
    expect(h.sink.received.filter((s) => s.status === "completed").length).toBeGreaterThanOrEqual(3);
  });
});

describe("rejected versus transient", () => {
  it("a rejected snapshot is dropped, reported, and never resent unchanged", async () => {
    const h = harness();
    h.sink.respond = () => ({ outcome: "rejected", reason: "schema" });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick(60_000);
    expect(h.sink.received).toHaveLength(1);
    expect(h.diagnostics.find((d) => d.code === "rejected")?.message).toMatch(/schema/);
    h.sink.respond = () => ({ outcome: "accepted" });
    run.enterStep("goal");
    await h.tick();
    expect(h.sink.received.map((s) => s.seq)).toEqual([1, 2]);
  });

  it("ignored settles a send like accepted", async () => {
    const h = harness();
    h.sink.respond = () => ({ outcome: "ignored" });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick(60_000);
    expect(h.sink.received).toHaveLength(1);
  });
});

describe("completed is terminal", () => {
  it("after complete(), nothing records and every later send is the same completed snapshot", async () => {
    const h = harness();
    h.sink.respond = (_b, n) => (n === 2 ? { outcome: "transient" } : { outcome: "accepted" });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    run.enterStep("goal");
    run.exitStep("welcome", { answers: [{ questionKey: "late", kind: "single", value: "x" }] });
    run.setProperties({ late: true });
    run.background();
    run.complete();
    await h.tick(60_000);
    const completed = h.sink.received.filter((s) => s.status === "completed");
    expect(completed.length).toBeGreaterThanOrEqual(1);
    const first = h.sink.received.findIndex((s) => s.status === "completed");
    expect(h.sink.received.slice(first).every((s) => JSON.stringify(s) === JSON.stringify(completed[0]))).toBe(true);
    expect(completed[0].steps).toHaveLength(1);
    expect(h.diagnostics.map((d) => d.code)).toContain("run-completed");
  });
});
