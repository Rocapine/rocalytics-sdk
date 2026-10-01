import { describe, expect, it } from "vitest";
import type { AnswerInput, OnboardingRun, OnboardingRunSnapshot } from "../src/onboarding";
import { SIZE_LIMIT, sizeOf } from "./contract";
import { IDENTITY, MANIFEST, harness, type Harness } from "./harness";

const BUDGET = 261_120;

/**
 * The size the tracker measures (D26): the snapshot in the form its completion
 * send would take, carrying `seq`. Timestamps are fixed-width, so which
 * timestamp fills an open exit does not change the size.
 */
function completionFormSize(s: OnboardingRunSnapshot, seq: number): number {
  const steps = s.steps.map((e) => ({ ...e, exited_at: e.exited_at ?? s.sent_at }));
  return sizeOf({ ...s, seq, status: "completed", completed_at: s.sent_at, steps });
}
/** What the tracker measured when it accepted the change that produced `s`. */
const measuredAt = (s: OnboardingRunSnapshot) => completionFormSize(s, s.seq);
/** Room left for the next change, which will be measured with the next seq. */
const roomAfter = (s: OnboardingRunSnapshot) => BUDGET - completionFormSize(s, s.seq + 1);

const texts = (n: number, prefix: string, len = 1000): AnswerInput[] =>
  Array.from({ length: n }, (_, i) => ({ questionKey: `${prefix}${i}`, kind: "text" as const, value: "x".repeat(len) }));

const ALTERNATE = ["goal", "experience"];

/**
 * Fills a run until its completion form is exactly `BUDGET - slack` bytes, as
 * measured by the tracker. Returns the snapshot that landed there.
 */
async function fillTo(h: Harness, run: OnboardingRun, slack: number): Promise<OnboardingRunSnapshot> {
  const PER_ENTRY = 45; // under the 50-answer cap, leaving room for the padding answer
  let entries = 0;
  let k = 0;
  let step = h.sink.last!.steps[h.sink.last!.steps.length - 1].step_key;
  let count = PER_ENTRY; // force a fresh entry first
  // Fill until about 1 KB is left: whole 1,000-character answers in batches, then one shorter one.
  while (roomAfter(h.sink.last!) > 1050) {
    if (count >= PER_ENTRY) {
      step = ALTERNATE[entries++ % 2];
      run.enterStep(step);
      await h.tick(1000);
      count = 0;
      continue;
    }
    const room = roomAfter(h.sink.last!) - 1050;
    const whole = Math.min(PER_ENTRY - count, Math.floor(room / 1100));
    const batch = whole > 0 ? texts(whole, `f${k++}q`) : texts(1, `f${k++}q`, Math.max(1, Math.min(1000, room - 60)));
    run.exitStep(step, { answers: batch });
    count += batch.length;
    await h.tick(1000);
  }
  // Then one padding answer sized so the completion form lands exactly `slack` bytes under the budget.
  const last = h.sink.last!;
  const hasAnswers = last.steps[last.steps.length - 1].answers.length > 0;
  const overhead = sizeOf({ question_key: "pad", kind: "text", value: "" }) + (hasAnswers ? 1 : 0);
  const length = roomAfter(last) - overhead - slack;
  expect(length).toBeGreaterThan(0);
  expect(length).toBeLessThanOrEqual(1000);
  run.exitStep(step, { answers: [{ questionKey: "pad", kind: "text", value: "x".repeat(length) }] });
  await h.tick(1000);
  return h.sink.last!;
}

describe("the 500-entry cap (D8, D26)", () => {
  it("keeps the first 500 entries, sets truncated, closes the last kept entry, and still completes", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    for (let i = 0; i < 600; i++) {
      await h.tick(10_000);
      run.enterStep(ALTERNATE[i % 2]);
    }
    await h.tick(10_000);
    const mid = h.sink.last!;
    expect(mid.status).toBe("in_progress");
    expect(mid.truncated).toBe(true);
    expect(mid.steps).toHaveLength(500);
    expect(mid.steps[0].step_key).toBe("welcome");
    // The 501st screen was not recorded, so the 500th was closed when it was entered.
    expect(Date.parse(mid.steps[499].exited_at!) - Date.parse(mid.steps[499].entered_at)).toBe(10_000);
    run.complete();
    await h.tick(0);
    const done = h.sink.last!;
    expect(done.status).toBe("completed");
    expect(done.truncated).toBe(true);
    expect(done.steps).toHaveLength(500);
    expect(done.steps[499].exited_at! < done.completed_at!).toBe(true);
    // Truncation only stops recording: one send reported it, later screens send nothing new.
    expect(h.sink.received.filter((s) => s.truncated).length).toBeLessThanOrEqual(3);
  });

  it("after truncation, answers and property changes are not recorded either", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    for (let i = 0; i < 501; i++) run.enterStep(ALTERNATE[i % 2]);
    await h.tick();
    const before = h.sink.last!;
    expect(before.truncated).toBe(true);
    run.exitStep(before.steps[499].step_key, { answers: [{ questionKey: "late", kind: "single", value: "x" }] });
    run.setProperties({ late: true });
    run.complete();
    await h.tick();
    const done = h.sink.last!;
    expect(done.steps).toEqual(before.steps);
    expect(done.properties).toBeUndefined();
    expect(h.diagnostics.map((d) => d.code)).toContain("truncated");
  });
});

describe("the 261,120-byte recording budget (D26)", () => {
  it("crossing it inside an entry keeps the answers that fit, stops recording, and still completes", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    for (let i = 0; i < 5; i++) {
      const step = ALTERNATE[i % 2];
      run.enterStep(step);
      await h.tick(1000);
      run.exitStep(step, { answers: texts(50, `e${i}q`) });
      await h.tick(1000);
    }
    const mid = h.sink.last!;
    expect(mid.truncated).toBe(true);
    const last = mid.steps[mid.steps.length - 1];
    expect(last.answers.length).toBeGreaterThan(0);
    expect(last.answers.length).toBeLessThan(50);
    expect(last.exited_at).not.toBeNull(); // the user left it: closed at once in a truncated run
    run.enterStep("summary");
    run.complete();
    await h.tick(0);
    const done = h.sink.last!;
    expect(done.status).toBe("completed");
    expect(done.truncated).toBe(true);
    expect(done.steps).toEqual(mid.steps);
    expect(sizeOf(done)).toBeLessThanOrEqual(SIZE_LIMIT);
  });

  it("is exactly 261,120 bytes: a change landing on it is recorded, one byte more is not", async () => {
    const atBudget = harness();
    const run = atBudget.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await atBudget.tick();
    const landed = await fillTo(atBudget, run, 0);
    expect(landed.truncated).toBeUndefined();
    expect(measuredAt(landed)).toBe(BUDGET);
    expect(landed.steps[landed.steps.length - 1].answers.some((a) => a.question_key === "pad")).toBe(true);

    const over = harness();
    const run2 = over.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run2.enterStep("welcome");
    await over.tick();
    const refused = await fillTo(over, run2, -1);
    expect(refused.truncated).toBe(true);
    expect(refused.steps[refused.steps.length - 1].answers.some((a) => a.question_key === "pad")).toBe(false);
  });

  it("a new or changed property counts against the budget too", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, properties: { plan: "a" } });
    run.enterStep("welcome");
    await h.tick();
    await fillTo(h, run, 5);
    run.setProperties({ plan: "a much longer value" });
    await h.tick();
    expect(h.sink.last!.truncated).toBe(true);
    expect(h.sink.last!.properties).toEqual({ plan: "a" });
  });

  it("filled to the byte with seq about to gain a digit, the run still completes within 256 KiB", async () => {
    const h = harness({}, { full: false }); // ~45 snapshots of ~260 KB: size-checked here, schema-checked below
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    while (h.sink.received.length < 950) {
      run.background();
      await h.tick(0);
    }
    const landed = await fillTo(h, run, 0);
    expect(landed.seq).toBeLessThan(999);
    expect(measuredAt(landed)).toBe(BUDGET); // zero slack, measured with a 3-digit seq
    while (h.sink.last!.seq < 1001) {
      run.background();
      await h.tick(0);
    }
    const step = landed.steps[landed.steps.length - 1].step_key;
    run.exitStep(step, { answers: [{ questionKey: "one_more", kind: "single", value: "x" }] });
    run.complete();
    await h.tick(0);
    const done = h.sink.last!;
    expect(done.seq).toBeGreaterThanOrEqual(1002);
    expect(done.status).toBe("completed");
    expect(done.truncated).toBe(true);
    for (const s of h.sink.received) expect(sizeOf(s)).toBeLessThanOrEqual(SIZE_LIMIT);
    const { assertConformant } = await import("./contract");
    for (const s of h.sink.received.slice(-5)) assertConformant(s);
  });
});
