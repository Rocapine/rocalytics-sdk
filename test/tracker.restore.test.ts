import { describe, expect, it } from "vitest";
import { memoryStorage } from "../src/core";
import { accept } from "./contract";
import { ManualTime } from "./fakes";
import { IDENTITY, MANIFEST, harness, type Harness } from "./harness";

// Recording 500 entries one tick at a time takes seconds, past Vitest's 5 s default under load.
const SLOW_MS = 20_000;

const T0 = Date.parse("2026-01-10T08:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

/** The app is killed: its in-memory tracker is gone, only storage survives. */
async function kill(h: Harness) {
  await h.tracker.idle();
  h.kill();
}
/** The app is launched again, `seconds` after T0, on the same storage. */
const relaunch = (h: Harness, seconds: number, overrides = {}) =>
  harness({ storage: h.storage, time: new ManualTime(T0 + seconds * 1000), ...overrides });

describe("resume after relaunch (3.2)", () => {
  it("same run_id; the pre-kill entry closes at last_active_at; the restored screen gets a new entry; seq goes on", async () => {
    const a = harness();
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick(10_000);
    run.enterStep("goal");
    await a.tick(5_000);
    run.background(); // last_active_at = 15 s
    await a.tick(20_000);
    const beforeKill = a.sink.last!;
    await kill(a);

    const b = relaunch(a, 600);
    const resumed = await b.tracker.resume();
    expect(resumed).not.toBeNull();
    expect(resumed!.runId).toBe(run.runId);
    expect(resumed!.currentStepKey).toBe("goal");
    await b.tick(0);
    const restored = b.sink.last!;
    expect(restored.run_id).toBe(run.runId);
    expect(restored.seq).toBe(beforeKill.seq + 1);
    expect(restored.steps.map((s) => s.step_key)).toEqual(["welcome", "goal", "goal"]);
    expect(restored.steps[1].exited_at).toBe(at(15));
    expect(restored.steps[2]).toEqual({ step_key: "goal", entered_at: at(600), exited_at: null, answers: [] });
    expect(accept(beforeKill, restored)).toBe("accepted");

    resumed!.enterStep("summary");
    resumed!.complete();
    await b.tick(0);
    expect(b.sink.last!.status).toBe("completed");
    expect(accept(restored, b.sink.last!)).toBe("accepted");
  });

  it("without a background event, last_active_at is the last entry or send", async () => {
    const a = harness();
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick(10_000);
    run.enterStep("goal");
    await a.tick(50_000);
    await kill(a);
    const b = relaunch(a, 3600);
    await b.tracker.resume();
    await b.tick(0);
    expect(b.sink.last!.steps[1].exited_at).toBe(at(10));
  });

  it("answers recorded before the kill survive it", async () => {
    const a = harness();
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, properties: { cohort_week: 2 } });
    run.enterStep("goal");
    run.exitStep("goal", { answers: [{ questionKey: "goal", kind: "single", value: "learn" }] });
    await a.tick();
    await kill(a);
    const b = relaunch(a, 600);
    await b.tracker.resume();
    await b.tick(0);
    expect(b.sink.last!.steps[0].answers).toEqual([{ question_key: "goal", kind: "single", value: "learn" }]);
    expect(b.sink.last!.properties).toEqual({ cohort_week: 2 });
  });

  it("an unsent snapshot is not lost: the restored send supersedes it with the persisted seq + 1", async () => {
    const a = harness();
    a.sink.respond = () => ({ outcome: "transient" });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.enterStep("goal");
    await a.tick(1000);
    const lastSeq = Math.max(...a.sink.received.map((s) => s.seq));
    await kill(a);
    const b = relaunch(a, 600);
    await b.tracker.resume();
    await b.tick(60_000);
    expect(b.sink.last!.seq).toBe(lastSeq + 1);
    expect(b.sink.last!.steps.map((s) => s.step_key)).toEqual(["welcome", "goal", "goal"]);
  });

  it("a truncated run appends no entry on restore and keeps its last exit, then completes", async () => {
    const a = harness();
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    for (let i = 0; i < 501; i++) {
      run.enterStep(i % 2 ? "goal" : "experience");
      await a.tick(1000);
    }
    const beforeKill = a.sink.last!;
    expect(beforeKill.truncated).toBe(true);
    await kill(a);

    const b = relaunch(a, 3600);
    const resumed = await b.tracker.resume();
    await b.tick(0);
    const restored = b.sink.last!;
    expect(restored.steps).toEqual(beforeKill.steps);
    expect(restored.truncated).toBe(true);
    expect(restored.seq).toBe(beforeKill.seq + 1);
    resumed!.complete();
    await b.tick(0);
    expect(b.sink.last!.status).toBe("completed");
    expect(b.sink.last!.steps[499].exited_at).toBe(beforeKill.steps[499].exited_at);
    expect(accept(restored, b.sink.last!)).toBe("accepted");
  }, SLOW_MS);

  it("restored at exactly 500 entries: stops recording instead of appending entry 501", async () => {
    const a = harness();
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    for (let i = 0; i < 500; i++) {
      run.enterStep(i % 2 ? "goal" : "experience");
      await a.tick(1000);
    }
    expect(a.sink.last!.truncated).toBeUndefined();
    await kill(a);
    const b = relaunch(a, 3600);
    await b.tracker.resume();
    await b.tick(0);
    const restored = b.sink.last!;
    expect(restored.steps).toHaveLength(500);
    expect(restored.truncated).toBe(true);
    expect(restored.steps[499].exited_at).toBe(at(499)); // its last entry, the last activity
  }, SLOW_MS);

  it("a completed run cannot be resumed, and its undelivered completion still arrives after the restart", async () => {
    const a = harness();
    a.sink.respond = () => ({ outcome: "transient" });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.complete();
    await a.tick(1000);
    const completion = a.sink.received.find((s) => s.status === "completed")!;
    await kill(a);

    const b = relaunch(a, 600); // no resume() call at all
    await b.tick(0);
    expect(b.sink.received[0]).toEqual(completion);
    expect(await b.tracker.resume()).toBeNull();
    await b.tick(60_000);
    expect(b.sink.received.every((s) => JSON.stringify(s) === JSON.stringify(completion))).toBe(true);
    // Once delivered, nothing is left behind.
    await b.tracker.idle();
    const c = relaunch(b, 1200);
    await c.tick(60_000);
    expect(c.sink.received).toHaveLength(0);
  });

  it("starting a new run instead of resuming abandons the old one: it is never resumed later", async () => {
    const a = harness();
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick();
    await kill(a);
    const b = relaunch(a, 600);
    const fresh = b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    fresh.enterStep("welcome");
    await b.tick();
    await kill(b);
    const c = relaunch(b, 1200);
    const resumed = await c.tracker.resume();
    expect(resumed!.runId).toBe(fresh.runId);
  });

  it("a change still inside the debounce window when the app is killed reaches the server even if the run is not resumed", async () => {
    for (const startBeforeLoad of [false, true]) {
      const a = harness({ debounceMs: 5000 });
      const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
      run.enterStep("welcome");
      run.background(); // sent: welcome only
      await a.tick(1000);
      run.enterStep("goal"); // waiting on the debounce when the app dies
      await a.tick(1000);
      expect(a.sink.received.map((s) => s.steps.length)).toEqual([1]);
      await kill(a);

      const b = relaunch(a, 600, { debounceMs: 5000 });
      if (!startBeforeLoad) await b.tracker.idle();
      b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }); // not resumed: abandoned
      await b.tick(0);
      const ofOld = b.sink.received.filter((s) => s.run_id === run.runId);
      expect(ofOld.map((s) => s.steps.map((e) => e.step_key)), `start before load: ${startBeforeLoad}`).toEqual([["welcome", "goal"]]);
      expect(ofOld[0].seq).toBe(a.sink.last!.seq + 1);
      expect(ofOld[0].status).toBe("in_progress");
    }
  });

  it("an abandoned run with nothing unsent is not sent again", async () => {
    const a = harness();
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await a.tick();
    await kill(a);
    const b = relaunch(a, 600);
    await b.tracker.idle();
    b.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    await b.tick(60_000);
    expect(b.sink.received.filter((s) => s.run_id === run.runId)).toEqual([]);
  });

  it("with no storage, or unreadable storage, there is nothing to resume and nothing throws", async () => {
    const none = harness({ storage: undefined });
    expect(await none.tracker.resume()).toBeNull();
    const corrupt = memoryStorage();
    corrupt.setItem("studio-sdk:onboarding-run", "{not json");
    const h = harness({ storage: corrupt });
    expect(await h.tracker.resume()).toBeNull();
    expect(h.diagnostics.map((d) => d.code)).toContain("storage");
  });

  it("resume() after start() in the same session does not hijack the live run", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    expect(await h.tracker.resume()).toBeNull();
  });
});
