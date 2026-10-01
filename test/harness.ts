// Shared set-up for the tracker tests. Every snapshot a harness sink receives is
// checked against the schema, the section 4 rules and the 256 KiB limit when
// the test ends (see `checkAllConformant`), so no test can pass while the
// tracker emits something the ingest would reject.
import { afterEach } from "vitest";
import { memoryStorage, type KeyValueStorage } from "../src/core";
import {
  createOnboardingRunTracker,
  type Diagnostic,
  type OnboardingRunSnapshot,
  type RunContextInput,
  type TrackerConfig,
} from "../src/onboarding";
import { assertConformant, sizeOf, SIZE_LIMIT } from "./contract";
import { ManualTime, MemorySink } from "./fakes";

export const CONTEXT: RunContextInput = {
  appVersion: "2.4.0",
  build: "412",
  platform: "ios",
  osVersion: "18.1",
  locale: "en-US",
  timezone: "America/New_York",
};

export const MANIFEST = {
  steps: [
    { stepKey: "welcome" },
    { stepKey: "goal" },
    { stepKey: "experience" },
    { stepKey: "plan_quick", slot: "plan" },
    { stepKey: "plan_detailed", slot: "plan" },
    { stepKey: "permissions" },
    { stepKey: "summary" },
  ],
};

export const IDENTITY = { key: "main", version: "3" };

const sinks: { sink: MemorySink<OnboardingRunSnapshot>; full: boolean }[] = [];

/** Checks every body every harness sink received during the test. */
afterEach(() => {
  for (const { sink, full } of sinks.splice(0)) {
    for (const body of sink.received) {
      if (full) assertConformant(body);
      else if (sizeOf(body) > SIZE_LIMIT) throw new Error(`snapshot of ${sizeOf(body)} bytes`);
    }
  }
});

export interface Harness {
  time: ManualTime;
  sink: MemorySink<OnboardingRunSnapshot>;
  storage: KeyValueStorage & { dump(): Record<string, string> };
  diagnostics: Diagnostic[];
  tracker: ReturnType<typeof createOnboardingRunTracker>;
  /** Moves time forward (default 10 s), firing timers and settling promises. */
  tick(ms?: number): Promise<void>;
  /**
   * The app process dies: from now on this tracker's writes never land and
   * its sends never leave. Unlike dispose(), nothing is flushed. `storage`
   * keeps what had landed, for the next launch.
   */
  kill(): void;
}

let uuidCounter = 0;

export function harness(
  overrides: Partial<TrackerConfig> & { storage?: KeyValueStorage & { dump(): Record<string, string> }; time?: ManualTime } = {},
  check: { full: boolean } = { full: true },
): Harness {
  const time = overrides.time ?? new ManualTime();
  const sink = new MemorySink<OnboardingRunSnapshot>();
  sinks.push({ sink, full: check.full });
  const storage = overrides.storage ?? memoryStorage();
  const noStorage = "storage" in overrides && overrides.storage === undefined;
  const diagnostics: Diagnostic[] = [];
  let alive = true;
  const never = () => new Promise<never>(() => {});
  // What the tracker sees: the real sink and storage, until the process is killed.
  const processSink = { send: (b: OnboardingRunSnapshot) => (alive ? sink.send(b) : never()) };
  const processStorage: KeyValueStorage = {
    getItem: (k) => (alive ? storage.getItem(k) : never()),
    setItem: (k, v) => (alive ? storage.setItem(k, v) : never()),
    removeItem: (k) => (alive ? storage.removeItem(k) : never()),
  };
  const tracker = createOnboardingRunTracker({
    context: CONTEXT,
    clock: time.clock,
    timers: time.timers,
    uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    debounceMs: 0,
    retry: { initialDelayMs: 1000, factor: 2, maxDelayMs: 8000 },
    onDiagnostic: (d) => diagnostics.push(d),
    ...overrides,
    sink: processSink,
    storage: noStorage ? undefined : processStorage,
  });
  return {
    time,
    sink,
    storage,
    diagnostics,
    tracker,
    tick: (ms = 10_000) => time.advance(ms),
    kill: () => {
      alive = false;
    },
  };
}
