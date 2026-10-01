import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpSink, createOnboardingRunTracker, memoryStorage, type Diagnostic, type OnboardingRunSnapshot } from "../src/onboarding";
import { accept, assertConformant } from "./contract";
import { CONTEXT } from "./harness";

// End to end over real HTTP: the tracker, the stock HTTP sink, and a mock
// collector that applies the contract's acceptance rules (section 5) and
// answers with an outcome body. Real timers throughout.

interface Collector {
  url: string;
  stored: Map<string, OnboardingRunSnapshot>;
  received: OnboardingRunSnapshot[];
  /** Answer the next n requests with this instead of processing them. */
  failNext(n: number, status: number): void;
  close(): Promise<void>;
}

async function mockCollector(): Promise<Collector> {
  const stored = new Map<string, OnboardingRunSnapshot>();
  const received: OnboardingRunSnapshot[] = [];
  let failures: { n: number; status: number } = { n: 0, status: 503 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (failures.n > 0) {
        failures.n -= 1;
        res.writeHead(failures.status);
        return res.end();
      }
      let body: OnboardingRunSnapshot;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end('{"outcome":"rejected","reason":"not json"}');
      }
      received.push(body);
      const outcome = accept(stored.get(body.run_id) ?? null, body);
      if (outcome === "accepted") stored.set(body.run_id, body);
      res.writeHead(outcome === "rejected" ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ outcome }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/onboarding-runs`,
    stored,
    received,
    failNext: (n, status) => (failures = { n, status }),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let collector: Collector | null = null;
afterEach(async () => {
  await collector?.close();
  collector = null;
});

/** The README's hand-coded onboarding, driven as a user would. */
function handCodedOnboarding(tracker: ReturnType<typeof createOnboardingRunTracker>) {
  const run = tracker.start({
    onboarding: { key: "main", version: "3" },
    manifest: {
      steps: [
        { stepKey: "welcome" },
        { stepKey: "goal" },
        { stepKey: "level_beginner", slot: "level" },
        { stepKey: "level_advanced", slot: "level" },
        { stepKey: "notifications" },
        { stepKey: "done" },
      ],
    },
    properties: { signup_source: "email" },
  });
  run.enterStep("welcome");
  run.exitStep("welcome");
  run.enterStep("goal");
  run.exitStep("goal", { answers: [{ questionKey: "goal", kind: "single", value: "practice" }] });
  run.enterStep("level_advanced");
  run.exitStep("level_advanced", { answers: [{ questionKey: "daily_minutes", kind: "numeric", value: 15, unit: "minute" }] });
  // notifications already granted: not shown, not reported
  run.enterStep("done");
  run.complete();
  return run;
}

describe("a hand-coded onboarding against a mock collector", () => {
  it("the collector stores the completed run, and every payload it received validates", async () => {
    collector = await mockCollector();
    const diagnostics: Diagnostic[] = [];
    const tracker = createOnboardingRunTracker({
      sink: createHttpSink({ url: collector.url }),
      context: CONTEXT,
      storage: memoryStorage(),
      debounceMs: 0,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    const run = handCodedOnboarding(tracker);
    await until(() => collector!.stored.get(run.runId)?.status === "completed");
    const stored = collector.stored.get(run.runId)!;
    assertConformant(stored);
    expect(stored.steps.map((s) => s.step_key)).toEqual(["welcome", "goal", "level_advanced", "done"]);
    expect(stored.steps[1].answers).toEqual([{ question_key: "goal", kind: "single", value: "practice" }]);
    for (const p of collector.received) assertConformant(p);
    expect(diagnostics.filter((d) => d.code === "rejected")).toEqual([]);
    tracker.dispose();
  });

  it("an outage of gateway errors with no outcome body is retried until the completed run is stored", async () => {
    collector = await mockCollector();
    collector.failNext(4, 503);
    const tracker = createOnboardingRunTracker({
      sink: createHttpSink({ url: collector.url }),
      context: CONTEXT,
      debounceMs: 0,
      retry: { initialDelayMs: 20, factor: 2, maxDelayMs: 100 },
      onDiagnostic: () => {},
    });
    const run = handCodedOnboarding(tracker);
    await until(() => collector!.stored.get(run.runId)?.status === "completed");
    assertConformant(collector.stored.get(run.runId)!);
    tracker.dispose();
  });

  it("a 401 or 413 with no outcome body is transient too, never a reason to drop the completion", async () => {
    for (const status of [401, 404, 413]) {
      collector = await mockCollector();
      collector.failNext(3, status);
      const tracker = createOnboardingRunTracker({
        sink: createHttpSink({ url: collector.url }),
        context: CONTEXT,
        debounceMs: 0,
        retry: { initialDelayMs: 20, factor: 1, maxDelayMs: 20 },
        onDiagnostic: () => {},
      });
      const run = handCodedOnboarding(tracker);
      await until(() => collector!.stored.get(run.runId)?.status === "completed");
      tracker.dispose();
      await collector.close();
      collector = null;
    }
  });
});
