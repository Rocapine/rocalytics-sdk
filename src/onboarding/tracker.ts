import { captureRunContext, type RunContextInput } from "../core/context";
import { createDelivery, type Delivery, type Outbound, type RetryPolicy } from "../core/delivery";
import { consoleDiagnostics, safeDiagnostics, type DiagnosticHandler } from "../core/diagnostics";
import { createUuid } from "../core/ids";
import type { Sink } from "../core/sink";
import { createSerialStore, type KeyValueStorage, type SerialStore } from "../core/storage";
import { systemClock, systemTimers, type Clock, type Timers } from "../core/time";
import { LIBRARY_VERSION } from "../version";
import type { OnboardingRunSnapshot, Properties } from "./contract";
import { mergeProperties, toAnswer, validateStart, type AnswerInput, type StartOptions } from "./input";
import { parsePersisted, type Persisted } from "./persisted";
import {
  completeState,
  enter,
  exit,
  floorMs,
  restore,
  setProperties as setPropertiesOn,
  toSnapshot,
  type Note,
  type Result,
  type RunState,
} from "./state";

export interface TrackerConfig {
  /** Where snapshots go. `createHttpSink` is the stock one. */
  sink: Sink<OnboardingRunSnapshot>;
  /** Device and app facts, or a function returning them, read once per run at start. */
  context: RunContextInput | (() => RunContextInput);
  /**
   * Persists the run so it can be resumed after the app is killed, and keeps an
   * unsent snapshot across restarts. AsyncStorage fits as is. Without it,
   * nothing survives a restart and `resume()` always resolves null.
   */
  storage?: KeyValueStorage;
  /** Storage key. Default `studio-sdk:onboarding-run`. One restorable run per key. */
  storageKey?: string;
  clock?: Clock;
  timers?: Timers;
  /** Run id minter. Must return a lowercase UUID. Default: UUIDv7. */
  uuid?: () => string;
  /** Changes within this window go out as one send. Default 500 ms. Completion and background are sent at once. */
  debounceMs?: number;
  retry?: RetryPolicy;
  /** A send with no answer after this long is retried. Default 30,000 ms. */
  attemptTimeoutMs?: number;
  /** Receives what the tracker declined to do. Default: `console.warn`. */
  onDiagnostic?: DiagnosticHandler;
}

export interface ExitOptions {
  /** What was answered on this visit. Values are stable option keys, never displayed labels. */
  answers?: AnswerInput[];
}

/** One pass through an onboarding. Every method is safe to call at any time and never throws. */
export interface OnboardingRun {
  /** Lowercase UUID, minted when the run starts. */
  readonly runId: string;
  /** The step of the latest entry: the screen to show when resuming. Null before the first step. */
  readonly currentStepKey: string | null;
  /** A screen is shown. Call it again for the same step after going back to it. */
  enterStep(stepKey: string): void;
  /** The user leaves a screen, with what they answered there. */
  exitStep(stepKey: string, options?: ExitOptions): void;
  /** Adds or changes run properties. */
  setProperties(properties: Properties): void;
  /** The onboarding is finished. Final: the run records nothing after it. */
  complete(): void;
  /** The app moved to the background: records the moment and sends now. */
  background(): void;
}

export interface OnboardingRunTracker {
  /** Starts a new run. A run already in progress is left as it is, and stays in progress (a replay is a new run). */
  start(options: StartOptions): OnboardingRun;
  /**
   * Resumes the run that was in progress when the app was killed, or resolves
   * null. Call it only when the app restores the user's position; otherwise
   * call `start`.
   */
  resume(): Promise<OnboardingRun | null>;
  /** Resolves once queued storage writes are done. */
  idle(): Promise<void>;
  /** Stops all timers. The tracker records and sends nothing afterwards. */
  dispose(): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOTE_MESSAGES: Record<Note, string> = {
  truncated: "the run reached a recording limit (500 entries or 261,120 bytes): recording has stopped",
  "too-many-answers": "an entry holds at most 50 answers: the extra answer was dropped",
};

function inertRun(runId: string): OnboardingRun {
  return {
    runId,
    currentStepKey: null,
    enterStep() {},
    exitStep() {},
    setProperties() {},
    complete() {},
    background() {},
  };
}

export function createOnboardingRunTracker(config: TrackerConfig): OnboardingRunTracker {
  const clock = config.clock ?? systemClock;
  const timers = config.timers ?? systemTimers;
  const report = safeDiagnostics(config.onDiagnostic);
  const fallbackUuid = createUuid(clock);
  const debounceMs = config.debounceMs ?? 500;
  // Set when storage held something unusable, so the first write replaces it.
  let rewrite = false;
  const store: SerialStore<unknown> | null = config.storage
    ? createSerialStore<unknown>(config.storage, config.storageKey ?? "studio-sdk:onboarding-run", (e) => {
        rewrite = true;
        report({ code: "storage", message: `storage failed: ${String(e)}` });
      })
    : null;

  const deliveries = new Map<string, Delivery<OnboardingRunSnapshot>>();
  const outboxes = new Map<string, Outbound<OnboardingRunSnapshot>>();
  let live: Controller | null = null;
  let persistedCurrent: RunState | null = null;
  let disposed = false;

  const mintRunId = () => {
    try {
      const id = config.uuid ? String(config.uuid()).toLowerCase() : fallbackUuid();
      if (UUID.test(id)) return id;
      report({ code: "invalid-uuid", message: `the uuid option returned "${id}", not a UUID: using the default` });
    } catch (e) {
      report({ code: "invalid-uuid", message: `the uuid option threw: ${String(e)}` });
    }
    return fallbackUuid();
  };

  const compose = (): Persisted | null => {
    const current = live && live.state.status === "in_progress" ? live.state : persistedCurrent;
    if (!current && outboxes.size === 0) return null;
    return { format: 1, current, outboxes: Object.fromEntries(outboxes) };
  };

  // Persisted outboxes are merged in before anything is written, so a write
  // composed this session never drops a snapshot left by the previous one.
  // Every stored part is validated first; an invalid one is dropped, reported,
  // and the stored value rewritten without it. This promise never rejects.
  const loaded: Promise<void> = store
    ? store
        .load()
        .then((raw) => {
          if (raw === null) return;
          const { current, outboxes: stored, problems } = parsePersisted(raw);
          if (problems.length) {
            rewrite = true;
            report({ code: "storage", message: `${problems.join("; ")}: discarded` });
          }
          for (const [runId, item] of stored) {
            if (!outboxes.has(runId) && !disposed) deliveryFor(runId).enqueue(item);
          }
          if (current && current.status === "in_progress") {
            if (!live) persistedCurrent = current;
            else sendAbandoned(current); // a new run started before storage was read
          }
        })
        .catch((e) => {
          rewrite = true;
          report({ code: "storage", message: `reading stored state failed: ${String(e)}` });
        })
        .then(() => {
          if (rewrite && store && !disposed) store.save(compose());
          rewrite = false;
        })
    : Promise.resolve();

  /**
   * A run left in progress by the previous launch and not resumed: if it holds
   * a change that never went into a send (killed inside the debounce window),
   * send it now, so the latest snapshot is not lost (section 5).
   */
  function sendAbandoned(state: RunState) {
    if (disposed || !state.dirty || state.steps.length === 0) return;
    const seq = state.lastSeq + 1;
    deliveryFor(state.runId).enqueue({ seq, body: toSnapshot(state, seq, Math.max(clock.now(), floorMs(state))) });
  }

  const persist = () => {
    if (!store || disposed) return;
    loaded
      .then(() => {
        if (!disposed) store.save(compose());
      })
      .catch((e) => report({ code: "storage", message: `saving failed: ${String(e)}` }));
  };

  function deliveryFor(runId: string): Delivery<OnboardingRunSnapshot> {
    let d = deliveries.get(runId);
    if (!d) {
      d = createDelivery<OnboardingRunSnapshot>({
        sink: config.sink,
        timers,
        retry: config.retry,
        attemptTimeoutMs: config.attemptTimeoutMs,
        onPendingChange: (pending) => {
          if (pending) outboxes.set(runId, pending);
          else outboxes.delete(runId);
          persist();
        },
        onSettled: (item, result) => {
          if (result.outcome === "rejected") {
            report({
              code: "rejected",
              runId,
              message: `snapshot seq ${item.seq} was rejected by the ingest${result.reason ? `: ${result.reason}` : ""}`,
            });
          }
        },
      });
      deliveries.set(runId, d);
    }
    return d;
  }

  class Controller implements OnboardingRun {
    state: RunState;
    active = true;
    private debounce: unknown = null;

    constructor(state: RunState) {
      this.state = state;
    }

    get runId() {
      return this.state.runId;
    }
    get currentStepKey() {
      return this.state.steps[this.state.steps.length - 1]?.step_key ?? null;
    }

    private now() {
      return Math.max(clock.now(), floorMs(this.state));
    }

    private diag(code: string, message: string) {
      report({ code, message, runId: this.state.runId });
    }

    /** Runs a public method body: never throws, and refuses once the run is over. */
    private guard(name: string, body: () => void, allowCompleted = false) {
      try {
        if (disposed) return;
        if (!this.active) return this.diag("run-inactive", `${name}: a newer run was started; this one records nothing more`);
        if (this.state.status === "completed" && !allowCompleted) {
          return this.diag("run-completed", `${name}: the run is completed and records nothing more`);
        }
        body();
      } catch (e) {
        this.diag("internal-error", `${name}: ${String(e)}`);
      }
    }

    private apply(result: Result, send: "debounced" | "now") {
      for (const note of result.notes) this.diag(note, NOTE_MESSAGES[note]);
      this.state = result.changed ? { ...result.state, dirty: true } : result.state;
      persist();
      if (!result.changed) return;
      if (send === "now" || debounceMs <= 0) this.sendNow();
      else if (this.debounce === null) this.debounce = timers.setTimeout(() => this.sendNow(), debounceMs);
    }

    sendNow() {
      if (this.debounce !== null) timers.clearTimeout(this.debounce);
      this.debounce = null;
      if (disposed || this.state.steps.length === 0) return;
      const now = this.now();
      const seq = this.state.lastSeq + 1;
      const body = toSnapshot(this.state, seq, now);
      this.state = {
        ...this.state,
        lastSeq: seq,
        lastActiveAt: this.state.status === "in_progress" ? now : this.state.lastActiveAt,
        dirty: false,
      };
      persist();
      deliveryFor(this.state.runId).enqueue({ seq, body });
    }

    deactivate() {
      if (this.debounce !== null) this.sendNow(); // a change waiting on the debounce still goes out
      this.active = false;
    }

    enterStep(stepKey: string) {
      this.guard("enterStep", () => {
        if (typeof stepKey !== "string" || !this.state.manifest.steps.some((s) => s.step_key === stepKey)) {
          return this.diag("unknown-step", `enterStep: "${String(stepKey)}" is not in the manifest`);
        }
        const last = this.state.steps[this.state.steps.length - 1];
        if (last && last.step_key === stepKey && last.exited_at === null) {
          return this.diag("already-on-step", `enterStep: already on "${stepKey}"`);
        }
        this.apply(enter(this.state, stepKey, this.now()), "debounced");
      });
    }

    exitStep(stepKey: string, options?: ExitOptions) {
      this.guard("exitStep", () => {
        const steps = this.state.steps;
        let index = -1;
        if (steps[steps.length - 1]?.step_key === stepKey) index = steps.length - 1;
        else if (steps[steps.length - 2]?.step_key === stepKey) index = steps.length - 2;
        if (index < 0) return this.diag("not-current-step", `exitStep: "${String(stepKey)}" is not the current step`);
        const raw = options && Array.isArray(options.answers) ? options.answers : [];
        if (options?.answers !== undefined && !Array.isArray(options.answers)) {
          this.diag("invalid-answer", "exitStep: answers must be an array");
        }
        const answers = [];
        for (const input of raw) {
          const r = toAnswer(input);
          if (r.ok) answers.push(r.answer);
          else this.diag("invalid-answer", r.error);
        }
        this.apply(exit(this.state, index, answers, this.now()), "debounced");
      });
    }

    setProperties(properties: Properties) {
      this.guard("setProperties", () => {
        const { value, problems } = mergeProperties(this.state.properties ?? {}, properties);
        for (const [code, message] of problems) this.diag(code, message);
        this.apply(setPropertiesOn(this.state, value, this.now()), "debounced");
      });
    }

    complete() {
      this.guard("complete", () => {
        if (this.state.steps.length === 0) return this.diag("no-steps", "complete: no step was entered, so there is no run to send");
        this.state = completeState(this.state, this.now());
        if (live === this) live = null;
        this.sendNow();
        deliveryFor(this.state.runId).flush();
      });
    }

    background() {
      this.guard("background", () => {
        if (this.state.status === "completed") return deliveryFor(this.state.runId).flush();
        if (this.state.steps.length === 0) return this.diag("no-steps", "background: no step was entered yet");
        this.state = { ...this.state, lastActiveAt: this.now() };
        this.sendNow();
        deliveryFor(this.state.runId).flush();
      }, true);
    }
  }

  return {
    start(options) {
      try {
        if (disposed) return inertRun(mintRunId());
        let contextInput: RunContextInput;
        try {
          contextInput = typeof config.context === "function" ? config.context() : config.context;
        } catch (e) {
          report({ code: "invalid-start", message: `the context function threw: ${String(e)}` });
          return inertRun(mintRunId());
        }
        const context = captureRunContext(contextInput, LIBRARY_VERSION);
        const valid = validateStart(options);
        const errors = [...(context.ok ? [] : context.errors), ...(valid.ok ? [] : valid.errors)];
        if (!context.ok || !valid.ok) {
          report({ code: "invalid-start", message: `run not started, nothing will be sent: ${errors.join("; ")}` });
          return inertRun(mintRunId());
        }
        for (const [code, message] of valid.value.warnings) report({ code, message });

        if (live && live.state.status === "in_progress") {
          report({ code: "run-replaced", runId: live.runId, message: "a new run was started; the previous one stays in progress" });
          live.deactivate();
        }
        if (persistedCurrent) sendAbandoned(persistedCurrent);
        persistedCurrent = null;
        const { onboarding, studio, manifest, properties } = valid.value;
        const state: RunState = {
          runId: mintRunId(),
          lastSeq: 0,
          onboarding,
          ...(studio ? { studio } : {}),
          context: context.context,
          manifest,
          ...(properties ? { properties } : {}),
          steps: [],
          provisionalExit: false,
          truncated: false,
          status: "in_progress",
          completedAt: null,
          lastActiveAt: clock.now(),
        };
        live = new Controller(state);
        persist();
        return live;
      } catch (e) {
        report({ code: "internal-error", message: `start: ${String(e)}` });
        return inertRun(fallbackUuid());
      }
    },

    async resume() {
      try {
        await loaded;
        if (disposed || live || !persistedCurrent) return null;
        const state = persistedCurrent;
        persistedCurrent = null;
        const now = Math.max(clock.now(), floorMs(state), state.lastActiveAt);
        const controller = new Controller(state);
        live = controller;
        const result = restore(state, now);
        for (const note of result.notes) report({ code: note, runId: state.runId, message: NOTE_MESSAGES[note] });
        controller.state = result.state;
        persist();
        controller.sendNow();
        return controller;
      } catch (e) {
        report({ code: "internal-error", message: `resume: ${String(e)}` });
        return null;
      }
    },

    async idle() {
      try {
        await loaded;
        for (let i = 0; i < 3; i++) {
          await store?.idle();
          await Promise.resolve();
        }
      } catch {
        // idle() never rejects into the host
      }
    },

    dispose() {
      disposed = true;
      for (const d of deliveries.values()) d.stop();
    },
  };
}

let instance: OnboardingRunTracker | null = null;

/**
 * The app-wide tracker. Call `configure` once at startup, then `start` (or
 * `resume`) for each run. Before `configure`, `start` returns a run that
 * records nothing, and warns.
 */
export const onboardingRun = {
  configure(config: TrackerConfig): void {
    instance?.dispose();
    instance = createOnboardingRunTracker(config);
  },
  start(options: StartOptions): OnboardingRun {
    if (instance) return instance.start(options);
    consoleDiagnostics({ code: "not-configured", message: "onboardingRun.start was called before onboardingRun.configure: nothing is tracked" });
    return inertRun("00000000-0000-0000-0000-000000000000");
  },
  resume(): Promise<OnboardingRun | null> {
    return instance ? instance.resume() : Promise.resolve(null);
  },
  idle(): Promise<void> {
    return instance ? instance.idle() : Promise.resolve();
  },
  dispose(): void {
    instance?.dispose();
    instance = null;
  },
};
