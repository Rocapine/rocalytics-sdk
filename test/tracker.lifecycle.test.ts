import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIBRARY_VERSION, createOnboardingRunTracker, onboardingRun, type OnboardingRun } from "../src/onboarding";
import { CONTEXT, IDENTITY, MANIFEST, harness } from "./harness";
import { MemorySink, ManualTime } from "./fakes";

const keys = (s: { steps: { step_key: string }[] }) => s.steps.map((e) => e.step_key);

describe("a run, start to completion", () => {
  it("records each shown step with its answers and completes", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, properties: { signup_source: "email" } });
    run.enterStep("welcome");
    await h.tick();
    run.exitStep("welcome");
    run.enterStep("goal");
    await h.tick();
    run.exitStep("goal", {
      answers: [
        { questionKey: "goal", kind: "single", value: "practice" },
        { questionKey: "topics", kind: "multi", value: ["vocabulary", "listening"] },
      ],
    });
    run.enterStep("summary");
    await h.tick();
    run.exitStep("summary", { answers: [{ questionKey: "daily_time", kind: "numeric", value: 15, unit: "minute" }] });
    run.complete();
    await h.tick(0);

    const done = h.sink.last!;
    expect(done.status).toBe("completed");
    expect(done.run_id).toBe(run.runId);
    expect(done.onboarding).toEqual({ key: "main", version: "3" });
    expect(done.manifest.steps[3]).toEqual({ step_key: "plan_quick", slot: "plan" });
    expect(done.properties).toEqual({ signup_source: "email" });
    expect(done.context).toEqual({
      app_version: "2.4.0",
      build: "412",
      platform: "ios",
      os_version: "18.1",
      locale: "en-US",
      timezone: "America/New_York",
      library_version: LIBRARY_VERSION,
    });
    expect(keys(done)).toEqual(["welcome", "goal", "summary"]);
    expect(done.started_at).toBe("2026-01-10T08:00:00.000Z");
    expect(done.steps[1]).toEqual({
      step_key: "goal",
      entered_at: "2026-01-10T08:00:10.000Z",
      exited_at: "2026-01-10T08:00:20.000Z",
      answers: [
        { question_key: "goal", kind: "single", value: "practice" },
        { question_key: "topics", kind: "multi", value: ["vocabulary", "listening"] },
      ],
    });
    expect(done.steps[2].answers).toEqual([{ question_key: "daily_time", kind: "numeric", value: 15, unit: "minute" }]);
    expect(done.completed_at).toBe("2026-01-10T08:00:30.000Z");
    expect(done.steps[2].exited_at).toBe(done.completed_at);
  });

  it("an in-progress snapshot leaves only the current screen open, even after exitStep", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.exitStep("welcome", { answers: [{ questionKey: "ready", kind: "single", value: "yes" }] });
    await h.tick(0);
    const mid = h.sink.last!;
    expect(mid.status).toBe("in_progress");
    expect(mid.completed_at).toBeNull();
    // Rule 6: the last entry of an in_progress run has a null exit; the answers are already there.
    expect(mid.steps[0].exited_at).toBeNull();
    expect(mid.steps[0].answers).toEqual([{ question_key: "ready", kind: "single", value: "yes" }]);
  });

  it("the exit recorded by exitStep is the one kept when the next step is entered", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick(5000);
    run.exitStep("welcome");
    await h.tick(2000); // a transition animation
    run.enterStep("goal");
    await h.tick(0);
    expect(h.sink.last!.steps[0].exited_at).toBe("2026-01-10T08:00:05.000Z");
    expect(h.sink.last!.steps[1].entered_at).toBe("2026-01-10T08:00:07.000Z");
  });

  it("entering the next step closes the current one at that moment when exitStep was never called", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick(3000);
    run.enterStep("goal");
    await h.tick(0);
    expect(h.sink.last!.steps[0].exited_at).toBe("2026-01-10T08:00:03.000Z");
  });

  it("nothing is sent before the first step is shown (a snapshot needs one entry)", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.setProperties({ cohort_week: 2 });
    run.background();
    run.complete();
    await h.tick();
    expect(h.sink.received).toHaveLength(0);
    expect(h.diagnostics.map((d) => d.code)).toContain("no-steps");
  });
});

describe("what the payload says, and does not say", () => {
  it("a declared step that is never shown has no entry: the skip is derived later, never reported", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    for (const step of ["welcome", "goal", "experience", "plan_quick", "summary"]) {
      run.enterStep(step);
      await h.tick();
    }
    run.complete();
    await h.tick(0);
    const done = h.sink.last!;
    expect(done.status).toBe("completed");
    expect(done.manifest.steps.map((s) => s.step_key)).toContain("permissions");
    expect(keys(done)).not.toContain("permissions");
    expect(JSON.stringify(h.sink.received)).not.toMatch(/skip/i);
    expect((run as unknown as Record<string, unknown>).skipStep).toBeUndefined();
    expect(Object.keys(run).filter((k) => /skip/i.test(k))).toEqual([]);
  });

  it("alternatives sharing a slot: the run shows one, and the manifest keeps the slot on both", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    for (const step of ["welcome", "goal", "experience", "plan_detailed", "summary"]) {
      run.enterStep(step);
      await h.tick();
    }
    run.complete();
    await h.tick(0);
    const done = h.sink.last!;
    expect(done.manifest.steps.filter((s) => s.slot === "plan").map((s) => s.step_key)).toEqual(["plan_quick", "plan_detailed"]);
    expect(keys(done)).toContain("plan_detailed");
    expect(keys(done)).not.toContain("plan_quick");
  });

  it("back navigation appends a repeated entry and never rewrites an earlier one", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    run.enterStep("goal");
    await h.tick();
    run.exitStep("goal", { answers: [{ questionKey: "goal", kind: "single", value: "learn" }] });
    run.enterStep("experience");
    await h.tick();
    const before = h.sink.last!.steps.slice(0, 2);
    run.enterStep("goal"); // back
    await h.tick();
    run.exitStep("goal", { answers: [{ questionKey: "goal", kind: "single", value: "practice" }] });
    run.enterStep("experience");
    await h.tick();
    const after = h.sink.last!;
    expect(keys(after)).toEqual(["welcome", "goal", "experience", "goal", "experience"]);
    expect(after.steps.slice(0, 2)).toEqual(before);
    expect(after.steps[3].answers).toEqual([{ question_key: "goal", kind: "single", value: "practice" }]);
  });

  it("a replay is a new run: a new run_id, seq from 1, and the first run is left as it was", async () => {
    const h = harness();
    const first = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    first.enterStep("welcome");
    first.enterStep("goal");
    await h.tick();
    const firstLast = h.sink.last!;
    const second = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    second.enterStep("welcome");
    await h.tick();
    expect(second.runId).not.toBe(first.runId);
    expect(h.sink.last!.run_id).toBe(second.runId);
    expect(h.sink.last!.seq).toBe(1);
    // The first run is never touched again: its last snapshot stays in progress.
    first.enterStep("summary");
    first.complete();
    await h.tick();
    const ofFirst = h.sink.received.filter((s) => s.run_id === first.runId);
    expect(ofFirst[ofFirst.length - 1]).toEqual(firstLast);
    expect(h.diagnostics.map((d) => d.code)).toContain("run-replaced");
  });

  it("context and manifest are captured once and repeated unchanged in every snapshot", async () => {
    let calls = 0;
    const h = harness({ context: () => ({ ...CONTEXT, locale: calls++ === 0 ? "fr-FR" : "de-DE" }) });
    const manifest = JSON.parse(JSON.stringify(MANIFEST));
    const run = h.tracker.start({ onboarding: IDENTITY, manifest });
    manifest.steps.push({ stepKey: "late_addition" }); // the host mutates its own object afterwards
    run.enterStep("welcome");
    await h.tick();
    run.enterStep("goal");
    await h.tick();
    run.complete();
    await h.tick();
    expect(h.sink.received.length).toBeGreaterThanOrEqual(3);
    const contexts = new Set(h.sink.received.map((s) => JSON.stringify(s.context)));
    const manifests = new Set(h.sink.received.map((s) => JSON.stringify(s.manifest)));
    expect(contexts.size).toBe(1);
    expect(manifests.size).toBe(1);
    expect(h.sink.last!.context.locale).toBe("fr-FR");
    expect(h.sink.last!.manifest.steps).toHaveLength(MANIFEST.steps.length);
  });

  it("never sends a country, even when the host's context object carries one", async () => {
    const h = harness({ context: { ...CONTEXT, country: "FR" } as typeof CONTEXT });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    expect(JSON.stringify(h.sink.received)).not.toMatch(/country/i);
  });

  it("an in-flow variant is sent as onboarding.variant_key", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: { ...IDENTITY, variantKey: "short-intro" }, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.last!.onboarding).toEqual({ key: "main", version: "3", variant_key: "short-intro" });
    expect(h.sink.last!.studio).toBeUndefined();
  });
});

describe("Studio-served identity", () => {
  it("defaults the key to the Studio onboarding id and the version to the deployment id", async () => {
    const h = harness();
    const run = h.tracker.start({ studio: { onboardingId: "6f1c2b0e", deploymentId: "412", audienceId: "7" }, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.last!.onboarding).toEqual({ key: "6f1c2b0e", version: "412" });
    expect(h.sink.last!.studio).toEqual({ onboarding_id: "6f1c2b0e", deployment_id: "412", audience_id: "7" });
  });

  it("a Studio-served draft sends the version \"draft\"", async () => {
    const h = harness();
    const run = h.tracker.start({ studio: { onboardingId: "6f1c2b0e", draft: true }, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.last!.onboarding).toEqual({ key: "6f1c2b0e", version: "draft" });
    expect(h.sink.last!.studio).toEqual({ onboarding_id: "6f1c2b0e" });
  });

  it("a Studio-served run with no deployment id is a draft", async () => {
    const h = harness();
    const run = h.tracker.start({ studio: { onboardingId: "6f1c2b0e" }, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.last!.onboarding.version).toBe("draft");
  });

  it("draft wins over a declared version, and says so", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, studio: { onboardingId: "6f1c2b0e", draft: true }, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.last!.onboarding).toEqual({ key: "main", version: "draft" });
    expect(h.diagnostics.map((d) => d.code)).toContain("draft-version");
  });

  it("a Studio-served run does not carry variant_key (D25)", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: { ...IDENTITY, variantKey: "b" }, studio: { onboardingId: "x", deploymentId: "1" }, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick();
    expect(h.sink.last!.onboarding.variant_key).toBeUndefined();
    expect(h.diagnostics.map((d) => d.code)).toContain("studio-variant-dropped");
  });
});

describe("input the ingest would reject is never sent", () => {
  it("an invalid manifest gives an inert run that sends nothing and does not throw", async () => {
    const bad = [
      { steps: [] },
      { steps: [{ stepKey: "a" }, { stepKey: "a" }] },
      { steps: [{ stepKey: "a", slot: "s" }, { stepKey: "b" }, { stepKey: "c", slot: "s" }] },
      { steps: [{ stepKey: "has space" }] },
      { steps: Array.from({ length: 201 }, (_, i) => ({ stepKey: `s${i}` })) },
      undefined,
    ];
    for (const manifest of bad) {
      const h = harness();
      let run!: OnboardingRun;
      expect(() => {
        run = h.tracker.start({ onboarding: IDENTITY, manifest: manifest as typeof MANIFEST });
        run.enterStep("a");
        run.exitStep("a");
        run.complete();
      }).not.toThrow();
      await h.tick();
      expect(h.sink.received).toHaveLength(0);
      expect(h.diagnostics.map((d) => d.code)).toContain("invalid-start");
    }
  });

  it("an invalid identity or context gives an inert run", async () => {
    const cases = [
      () => harness().tracker.start({ onboarding: { key: "", version: "1" }, manifest: MANIFEST }),
      () => harness().tracker.start({ onboarding: { key: "main", version: "has space" }, manifest: MANIFEST }),
      () => harness({ context: { ...CONTEXT, platform: "tvos" as "ios" } }).tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }),
      () => harness({ context: { ...CONTEXT, appVersion: "1".repeat(33) } }).tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }),
      () => harness({ context: () => { throw new Error("no device info"); } }).tracker.start({ onboarding: IDENTITY, manifest: MANIFEST }),
    ];
    for (const make of cases) {
      const run = make();
      expect(() => run.enterStep("welcome")).not.toThrow();
    }
  });

  it("an unknown step key is ignored and reported", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.enterStep("not_declared");
    await h.tick();
    expect(keys(h.sink.last!)).toEqual(["welcome"]);
    expect(h.diagnostics.map((d) => d.code)).toContain("unknown-step");
  });

  it("invalid answers and properties are dropped one by one, the valid ones kept", async () => {
    const h = harness();
    const run = h.tracker.start({
      onboarding: IDENTITY,
      manifest: MANIFEST,
      properties: { ok: 1, Bad: 2, nested: { a: 1 } as unknown as number, long: "x".repeat(257), inf: Infinity },
    });
    run.enterStep("goal");
    run.exitStep("goal", {
      answers: [
        { questionKey: "a", kind: "single", value: "fine" },
        { questionKey: "b", kind: "single", value: "not a key" },
        { questionKey: "c", kind: "numeric", value: NaN },
        { questionKey: "d", kind: "text", value: "😀".repeat(1001) },
        { questionKey: "e", kind: "text", value: "😀".repeat(1000) },
        { questionKey: "f", kind: "multi", value: ["x", "x", "y"] },
        { questionKey: "g", kind: "rating" as "single", value: "5" },
        { questionKey: "a", kind: "single", value: "changed" },
      ],
    });
    await h.tick();
    const snap = h.sink.last!;
    expect(snap.properties).toEqual({ ok: 1 });
    expect(snap.steps[0].answers).toEqual([
      { question_key: "a", kind: "single", value: "changed" },
      { question_key: "e", kind: "text", value: "😀".repeat(1000) },
      { question_key: "f", kind: "multi", value: ["x", "y"] },
    ]);
    const codes = h.diagnostics.map((d) => d.code);
    expect(codes.filter((c) => c === "invalid-property")).toHaveLength(4);
    expect(codes.filter((c) => c === "invalid-answer")).toHaveLength(4);
  });

  it("at most 50 answers per entry and 20 properties", async () => {
    const h = harness();
    const props = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, i]));
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, properties: props });
    run.enterStep("goal");
    run.exitStep("goal", { answers: Array.from({ length: 55 }, (_, i) => ({ questionKey: `q${i}`, kind: "single" as const, value: "v" })) });
    await h.tick();
    expect(Object.keys(h.sink.last!.properties!)).toHaveLength(20);
    expect(h.sink.last!.steps[0].answers).toHaveLength(50);
  });

  it("never throws on garbage arguments", () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    const anyRun = run as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(() => {
      anyRun.enterStep(undefined);
      anyRun.enterStep(42);
      anyRun.exitStep(null, { answers: "nope" });
      anyRun.exitStep("welcome", { answers: [null, 1, { kind: "multi" }] });
      anyRun.setProperties(null);
      anyRun.setProperties("x");
    }).not.toThrow();
  });

  it("a clock that goes backwards still yields ordered timestamps", async () => {
    const time = new ManualTime();
    let offset = 0;
    const h = harness({ time, clock: { now: () => time.clock.now() + offset } });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick(1000);
    offset = -60_000; // the user moves the device clock back a minute
    run.exitStep("welcome");
    run.enterStep("goal");
    run.complete();
    await h.tick();
    const done = h.sink.last!;
    expect(done.steps[1].entered_at >= done.steps[0].entered_at).toBe(true);
    expect(done.completed_at! >= done.steps[1].entered_at).toBe(true);
  });
});

describe("host lifecycle quirks", () => {
  it("the next screen mounting before the previous one unmounts: late exitStep answers land on the right entry", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await h.tick(1000);
    run.enterStep("goal");
    run.exitStep("welcome", { answers: [{ questionKey: "ready", kind: "single", value: "yes" }] });
    await h.tick();
    const snap = h.sink.last!;
    expect(snap.steps[0].answers).toEqual([{ question_key: "ready", kind: "single", value: "yes" }]);
    expect(snap.steps[0].exited_at).toBe("2026-01-10T08:00:01.000Z");
    expect(snap.steps[1].answers).toEqual([]);
  });

  it("entering the screen it is already on (a double-run mount effect) adds no entry", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    run.enterStep("welcome");
    await h.tick();
    expect(keys(h.sink.last!)).toEqual(["welcome"]);
  });
});

describe("the onboardingRun singleton", () => {
  it("start before configure returns an inert run instead of throwing", () => {
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...a: unknown[]) => warned.push(a);
    try {
      const run = onboardingRun.start({ onboarding: IDENTITY, manifest: MANIFEST });
      expect(() => { run.enterStep("welcome"); run.complete(); }).not.toThrow();
      expect(warned.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
  });

  it("once configured, starts real runs", async () => {
    const time = new ManualTime();
    const sink = new MemorySink();
    onboardingRun.configure({ sink, context: CONTEXT, clock: time.clock, timers: time.timers, debounceMs: 0 });
    const run = onboardingRun.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("welcome");
    await time.advance(0);
    expect(sink.received).toHaveLength(1);
    onboardingRun.dispose();
  });

  it("createOnboardingRunTracker gives independent instances", () => {
    const a = createOnboardingRunTracker({ sink: new MemorySink(), context: CONTEXT });
    const b = createOnboardingRunTracker({ sink: new MemorySink(), context: CONTEXT });
    expect(a).not.toBe(b);
    a.dispose();
    b.dispose();
  });
});

describe("LIBRARY_VERSION", () => {
  it("is the package version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    expect(LIBRARY_VERSION).toBe(pkg.version);
  });
});
