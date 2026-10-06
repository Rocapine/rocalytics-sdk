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
   * nothing survives a restart, and `resume()` resolves null unless a tracker
   * disposed in this process on the same `storageKey` handed it a run.
   */
  storage?: KeyValueStorage;
  /** Storage key. Default `studio-sdk:onboarding-run`. One restorable run per key. */
  storageKey?: string;
  clock?: Clock;
  timers?: Timers;
  /** Run id minter. Must return a lowercase UUID. Default: UUIDv7. */
  uuid?: () => string;
  /**
   * Changes within this window go out as one send. Default 500 ms. Completion
   * and background skip the debounce, but with `storage` every send, these
   * included, first waits for its snapshot to be written: up to
   * `persistTimeoutMs` (default 1,000 ms) later.
   */
  debounceMs?: number;
  retry?: RetryPolicy;
  /** A send with no answer after this long is retried. Default 30,000 ms. */
  attemptTimeoutMs?: number;
  /**
   * Each snapshot is stored (with its seq) before it is handed to the sink, so
   * a kill in between can never make a resumed run reuse that seq for a
   * different body. A storage slower than this does not hold the send back any
   * longer: it goes out anyway, and only then can a kill in that window cost
   * the guarantee. Default 1,000 ms. Ignored without `storage`.
   */
  persistTimeoutMs?: number;
  /**
   * How long a storage read may take before it is reported as slow. It does
   * not cut `resume()` short: `resume()` waits for the read however long it
   * takes. It bounds `idle()`, which waits at most this long for the read and
   * as long again for queued writes, so up to about twice this; and with it,
   * how long a tracker created after a `dispose()` on the same `storageKey`
   * waits for the disposed one's writes before it reads. `start()` never waits
   * for the read. Default 5,000 ms.
   */
  storageReadTimeoutMs?: number;
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
  /**
   * The step of the last RECORDED entry; null before the first step. In a
   * truncated run recording has stopped, so this can be an earlier screen than
   * the one the user was on: restore the position from the app's own
   * navigation state, not from this.
   */
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
   * call `start`. The restored screen is recorded as a new entry for the last
   * recorded step. A truncated run is still returned (so it can complete) but
   * records no new entry. Null once a run was started this session.
   *
   * After a reconfigure, the run is the one the disposed tracker on this
   * `storageKey` was recording, in its newest state, with storage or without;
   * null if that tracker completed it or started another.
   *
   * It waits for the stored state to be read, however long that takes: a
   * storage that never answers the read means it never resolves. An app that
   * cannot wait should race it with its own timeout and call `start` instead.
   */
  resume(): Promise<OnboardingRun | null>;
  /** Resolves once queued storage writes are done. */
  idle(): Promise<void>;
  /**
   * Stops recording without dropping what was recorded: a change on the
   * debounce is sent, writes already queued land, and each unsent snapshot
   * gets one last attempt (no retry timers). One the sink does not take is
   * handed, in memory, to the next tracker created on the same `storageKey`
   * (as `configure()` does), which sends it with its own sink and retries,
   * with or without storage, provided its sink has the same `destination`
   * (or, without one, is the same object). That tracker keeps this one's
   * unsent snapshots in its writes from the start, sends none of them until
   * these last attempts are answered, and drops any they delivered. A tracker
   * disposed without a run of its own passes on what it was handed. With
   * working storage the snapshot also stays stored for the next launch;
   * without it, a snapshot is lost if the app is killed before a next tracker
   * is created. Safe to call twice.
   */
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

/** What a disposed tracker hands to the next one on its key. */
interface Handoff {
  /** Per run, the snapshot the sink has not taken. */
  unsent: Map<string, Outbound<OnboardingRunSnapshot>>;
  /** Per run, the highest seq the sink settled: storage may still hold it, since nothing is written after dispose(). */
  settled: Map<string, number>;
}

// Per storage key, process-wide, so they hold whichever storage object a host
// passes (a fresh adapter on every configure() included):
// - the last disposed tracker's writes: `drain`, bounded by its idle(), which a
//   new tracker's first read waits for, so it sees what the old one staged;
//   `landed`, unbounded; and each queued write, its predecessors' still to land
//   included, so a new tracker that read before one landed writes its own
//   state again;
// - what the last disposed tracker hands over, with storage or without, taken
//   by the next tracker. Known at dispose(), and newer than any write still to
//   land: its run, when it started or resumed one (null once that run is
//   completed or replaced), or else the run it was handed; and its unsent
//   snapshots, which the next tracker holds (and writes) from the start. Then,
//   once its last attempts are over, what is still unsent and what was settled.
//   A tracker disposed without a run passes on what it was handed;
// - how many live trackers use the key: two at once overwrite each other.
const lastDrainOnKey = new Map<string, { drain: Promise<void>; landed: Promise<void>; writes: Promise<void>[] }>();
//   Only a tracker whose sink has the same destination takes it: one that
//   sends elsewhere takes nothing, and discards the stored state it reads;
const handoffOnKey = new Map<
  string,
  {
    sink: Sink<OnboardingRunSnapshot>;
    destination: string | undefined;
    run?: { current: RunState | null };
    outboxes: Map<string, Outbound<OnboardingRunSnapshot>>;
    left: Promise<Handoff>;
  }
>();
const liveOnKey = new Map<string, number>();

export function createOnboardingRunTracker(config: TrackerConfig): OnboardingRunTracker {
  const clock = config.clock ?? systemClock;
  const timers = config.timers ?? systemTimers;
  const report = safeDiagnostics(config.onDiagnostic);
  const fallbackUuid = createUuid(clock);
  const debounceMs = config.debounceMs ?? 500;
  // Set only when the stored value was READ and found unparseable or malformed,
  // so it is rewritten without the bad part. A failed read never sets it.
  let rewrite = false;
  // Set when the stored value must not be touched: storage could not be read
  // (twice), or it holds a format this version does not know. The session then
  // runs without persistence, and the stored value is left as it is.
  let persistenceOff = false;
  // The slow read was reported (once).
  let readSlow = false;
  const storageKey = config.storageKey ?? "studio-sdk:onboarding-run";
  const store: SerialStore<unknown> | null = config.storage
    ? createSerialStore<unknown>(config.storage, storageKey, (e) =>
        report({ code: "storage", message: `storage failed: ${String(e)}` }),
      )
    : null;
  if (store) {
    const others = liveOnKey.get(storageKey) ?? 0;
    if (others > 0) {
      report({
        code: "storage",
        message: `another live tracker already uses storageKey "${storageKey}": trackers running at once must each use their own storageKey, or they overwrite each other's unsent snapshots`,
      });
    }
    liveOnKey.set(storageKey, others + 1);
  }

  const deliveries = new Map<string, Delivery<OnboardingRunSnapshot>>();
  const outboxes = new Map<string, Outbound<OnboardingRunSnapshot>>();
  // Per run, the highest seq a sink settled, here or in the predecessor.
  const settledSeqs = new Map<string, number>();
  // Sends waiting for their snapshot's write (at most persistTimeoutMs).
  const staging = new Set<Promise<void>>();
  // Writes queued and not yet done.
  const writing = new Set<Promise<void>>();
  // Where this tracker's snapshots go; stamped on what it stores.
  const destination = typeof config.sink?.destination === "string" ? config.sink.destination : undefined;
  // Taken once: a later tracker on this key gets this one's handoff, not the predecessor's.
  const offered = handoffOnKey.get(storageKey);
  handoffOnKey.delete(storageKey);
  // A predecessor that sent elsewhere: nothing it left is taken, in memory or from storage.
  const destinationChanged =
    !!offered &&
    (offered.destination !== undefined && destination !== undefined ? offered.destination !== destination : offered.sink !== config.sink);
  if (destinationChanged) {
    report({
      code: "destination-changed",
      message: `the tracker this one replaces on storageKey "${storageKey}" sent to another destination: nothing it left is sent here, and the stored state is discarded`,
    });
  }
  const handed = destinationChanged ? undefined : offered;
  const predecessor = handed?.left;
  // The predecessor's run: when set, it replaces the stored one, which a late write may not have updated.
  const handedRun = handed?.run;
  const priorWrites = store ? lastDrainOnKey.get(storageKey) : undefined;
  // The predecessor's unsent snapshots, and stored outboxes read before its last
  // attempts were over: kept (so every write holds them), and sent after them.
  const heldBack = new Map<string, Outbound<OnboardingRunSnapshot>>(handed?.outboxes);
  for (const [runId, item] of heldBack) outboxes.set(runId, item);
  let inheritedDone = !predecessor;
  let live: Controller | null = null;
  // A run was started (or resumed) this session: the previous launch's run is then abandoned,
  // whether or not the run started here is still live.
  let startedThisSession = false;
  let persistedCurrent: RunState | null = handedRun?.current ?? null;
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

  const delivered = (runId: string, item: Outbound<OnboardingRunSnapshot>) => item.seq <= (settledSeqs.get(runId) ?? 0);

  const compose = (): Persisted | null => {
    const current = live && live.state.status === "in_progress" ? live.state : persistedCurrent;
    if (!current && outboxes.size === 0) return null;
    return { format: 1, ...(destination === undefined ? {} : { destination }), current, outboxes: Object.fromEntries(outboxes) };
  };

  // Persisted outboxes are merged in before anything is written, so a write
  // composed this session never drops a snapshot left by the previous one.
  // Every stored part is validated first; an invalid one is dropped, reported,
  // and the stored value rewritten without it. This promise never rejects.
  const loaded: Promise<void> = store
    ? store
        .read(priorWrites?.drain) // after a disposed predecessor's last writes
        .then((result) => {
          if (result.status === "failed") {
            persistenceOff = true;
            return report({
              code: "storage",
              message: `reading stored state failed twice (${String(result.error)}): it is left untouched, and this session runs without persistence`,
            });
          }
          if (result.status === "invalid") {
            rewrite = true;
            return report({ code: "storage", message: "the stored state is not JSON: discarded" });
          }
          const raw = result.value;
          if (raw === null) return;
          const format = (raw as { format?: unknown }).format;
          if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof format === "number" && format !== 1) {
            persistenceOff = true;
            return report({
              code: "storage",
              message: `the stored state has format ${format}, which this version does not know: it is left untouched, and this session runs without persistence`,
            });
          }
          // Written for another destination: never sent here, so discarded.
          if (destinationChanged || (raw as { destination?: unknown }).destination !== destination) {
            rewrite = true;
            return report({
              code: "destination-changed",
              message: `the stored state was written for another destination than this sink's: discarded, nothing of it is sent`,
            });
          }
          const { current, outboxes: stored, problems } = parsePersisted(raw);
          if (problems.length) {
            rewrite = true;
            report({ code: "storage", message: `${problems.join("; ")}: discarded` });
          }
          // Merged even after dispose(), so a write still queued keeps them; but
          // sent only before it, and only once the predecessor's last attempts
          // are over (the snapshots they deliver are dropped, not sent again).
          for (const [runId, item] of stored) {
            if ((outboxes.get(runId)?.seq ?? 0) >= item.seq) continue;
            if (delivered(runId, item)) rewrite = true;
            else if (!inheritedDone) {
              outboxes.set(runId, item);
              heldBack.set(runId, item);
            } else if (disposed) outboxes.set(runId, item);
            else deliveryFor(runId).enqueue(item);
          }
          if (current && current.status === "in_progress" && !handedRun) {
            if (!startedThisSession) persistedCurrent = current;
            else sendAbandoned(current); // a new run started before storage was read
          }
        })
        .catch((e) => report({ code: "storage", message: `loading stored state failed: ${String(e)}` }))
        .then(() => {
          if (rewrite && !persistenceOff && !disposed) void persist();
          rewrite = false;
        })
    : Promise.resolve();

  /**
   * The predecessor's handoff, once its last attempts are over: what it left
   * unsent is kept and sent from here, with the stored outboxes held back for
   * it. Per run, only a snapshot newer than the one held here and than any the
   * predecessor's sink settled. Never rejects.
   */
  const inherited: Promise<void> = predecessor
    ? predecessor
        .then((handoff) => {
          for (const [runId, seq] of handoff.settled) settledSeqs.set(runId, Math.max(seq, settledSeqs.get(runId) ?? 0));
          let dropped = false;
          for (const [runId, item] of [...heldBack, ...handoff.unsent]) {
            const held = outboxes.get(runId);
            if (delivered(runId, item)) {
              if (held === item) {
                outboxes.delete(runId);
                dropped = true;
              }
            } else if (!held || held === item || held.seq < item.seq) {
              if (disposed) outboxes.set(runId, item); // passed on to the next tracker
              else deliveryFor(runId).enqueue(item); // persisted by onPendingChange
            }
          }
          heldBack.clear();
          if (dropped) persist();
        })
        .catch((e) => report({ code: "internal-error", message: `adopting a disposed tracker's snapshots: ${String(e)}` }))
        .then(() => {
          inheritedDone = true;
        })
    : Promise.resolve();

  // Each predecessor write that lands after this tracker read storage replaces
  // what it wrote: this tracker writes its state again once it holds a state
  // at least as new, that is once it has a run of its own or was handed the
  // predecessor's. (Otherwise start() or resume() writes it anyway.)
  if (priorWrites) {
    let drained = false;
    void priorWrites.drain.then(() => (drained = true));
    for (const write of priorWrites.writes) {
      void write.then(() => {
        if (drained && (startedThisSession || handedRun || destinationChanged)) persist();
      });
    }
  }

  /**
   * A run left in progress by the previous launch and not resumed: if it holds
   * a change that never went into a send (killed inside the debounce window),
   * send it now, so the latest snapshot is not lost (section 5).
   */
  function sendAbandoned(state: RunState) {
    if (!state.dirty || state.steps.length === 0) return;
    const seq = state.lastSeq + 1;
    stageAndSend(state.runId, { seq, body: toSnapshot(state, seq, Math.max(clock.now(), floorMs(state))) }, false);
  }

  const persistTimeoutMs = config.persistTimeoutMs ?? 1000;
  const storageReadTimeoutMs = config.storageReadTimeoutMs ?? 5000;

  /** `p`, or `false` once `ms` have passed without it settling. Never rejects. */
  const within = <T>(p: Promise<T>, ms: number): Promise<T | false> =>
    new Promise((resolve) => {
      const timer = timers.setTimeout(() => resolve(false), ms);
      p.then(
        (v) => {
          timers.clearTimeout(timer);
          resolve(v);
        },
        () => {
          timers.clearTimeout(timer);
          resolve(false);
        },
      );
    });

  /**
   * Waits for the stored state to be read, at most storageReadTimeoutMs, and
   * reports a read that takes longer. The read itself goes on: resume() still
   * waits for it, and writes, each queued behind it and composed after it, go
   * on with what it found once it lands.
   */
  const waitLoaded = async (): Promise<boolean> => {
    if (!store) return true;
    const ok = await within(loaded.then(() => true), storageReadTimeoutMs);
    if (!ok && !readSlow) {
      readSlow = true;
      report({
        code: "storage",
        message: `the stored state has not been read within ${storageReadTimeoutMs} ms: resume() waits for it`,
      });
    }
    return ok;
  };

  /**
   * Queues a write of the whole tracker state, in order, right away; its value
   * is composed when its turn comes (after the stored state was read). A write
   * queued before dispose() still happens: that is how dispose() keeps a
   * staged snapshot. Never rejects; resolves once the write is done or failed.
   */
  const persist = (): Promise<void> => {
    if (!store || disposed) return Promise.resolve();
    const write = store.saveWith(async () => {
      await loaded;
      return persistenceOff ? undefined : compose();
    });
    writing.add(write);
    void write.then(() => writing.delete(write));
    return write;
  };

  /**
   * Stores a snapshot as the run's unsent one, together with the state that
   * assigned its seq, and only then hands it to the sink (3.2: persist on
   * every change). Waits at most `persistTimeoutMs` for the write.
   */
  function stageAndSend(runId: string, item: Outbound<OnboardingRunSnapshot>, flush: boolean) {
    outboxes.set(runId, item);
    // Not gated on dispose(): a snapshot staged before it is still sent (once; see deliveryFor).
    const send = () => {
      const d = deliveryFor(runId);
      d.enqueue(item);
      if (flush) d.flush();
    };
    if (!store) return send();
    let done = false;
    let sent = () => {};
    const staged = new Promise<void>((resolve) => (sent = resolve));
    staging.add(staged);
    const once = () => {
      if (done) return;
      done = true;
      timers.clearTimeout(timer);
      staging.delete(staged);
      send();
      sent();
    };
    const timer = timers.setTimeout(once, persistTimeoutMs);
    void persist().then(once);
  }

  function deliveryFor(runId: string): Delivery<OnboardingRunSnapshot> {
    let d = deliveries.get(runId);
    if (!d) {
      d = createDelivery<OnboardingRunSnapshot>({
        sink: config.sink,
        timers,
        retry: config.retry,
        attemptTimeoutMs: config.attemptTimeoutMs,
        onPendingChange: (pending) => {
          // Only ever moves forward: a newer snapshot may already be staged for this run.
          if (pending && (outboxes.get(runId)?.seq ?? 0) <= pending.seq) {
            outboxes.set(runId, pending);
            persist();
          }
        },
        onSettled: (item, result) => {
          settledSeqs.set(runId, Math.max(item.seq, settledSeqs.get(runId) ?? 0));
          const staged = outboxes.get(runId);
          if (staged && staged.seq <= item.seq) {
            outboxes.delete(runId);
            persist();
          }
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
      if (disposed) d.close(); // after dispose(): one last attempt per snapshot, no retry timers
    }
    return d;
  }

  /** Resolves once queued storage writes are done, however long they take. */
  const writesDone = async () => {
    if (!store) return;
    for (let i = 0; i < 3; i++) {
      await store.idle();
      await Promise.resolve();
    }
  };

  /** Waits up to storageReadTimeoutMs for the read, then as long again for `writes`. */
  const idleWithin = async (writes: Promise<void>) => {
    if (!store || !(await waitLoaded())) return;
    await within(writes, storageReadTimeoutMs);
  };

  /**
   * What this disposed tracker leaves unsent, once its last attempts are
   * over: the predecessor's handoff taken in, every send that waited for its
   * write handed to the sink, and no attempt in flight. Each attempt is bounded
   * by attemptTimeoutMs, and each wait for a write by persistTimeoutMs.
   */
  const leftUnsent = async (): Promise<Handoff> => {
    await inherited;
    do {
      await Promise.all(staging);
      await Promise.all([...deliveries.values()].map((d) => d.idle()));
    } while (staging.size > 0);
    return { unsent: new Map(outboxes), settled: new Map(settledSeqs) };
  };

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

    /** Sends the run now. `flush` also skips a backoff in progress (completion, background). */
    sendNow(flush = false) {
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
      stageAndSend(this.state.runId, { seq, body }, flush);
    }

    /** A change waiting on the debounce is sent now. */
    flushDebounce() {
      if (this.debounce !== null) this.sendNow();
    }

    deactivate() {
      this.flushDebounce(); // a change waiting on the debounce still goes out
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
        this.sendNow(true);
      });
    }

    background() {
      this.guard("background", () => {
        if (this.state.status === "completed") return deliveryFor(this.state.runId).flush();
        if (this.state.steps.length === 0) return this.diag("no-steps", "background: no step was entered yet");
        this.state = { ...this.state, lastActiveAt: this.now() };
        this.sendNow(true);
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
        startedThisSession = true;
        persist();
        return live;
      } catch (e) {
        report({ code: "internal-error", message: `start: ${String(e)}` });
        return inertRun(fallbackUuid());
      }
    },

    async resume() {
      try {
        void waitLoaded(); // reports a slow read
        await loaded;
        if (disposed || startedThisSession || !persistedCurrent) return null;
        const state = persistedCurrent;
        persistedCurrent = null;
        const now = Math.max(clock.now(), floorMs(state), state.lastActiveAt);
        const controller = new Controller(state);
        live = controller;
        startedThisSession = true;
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

    // Waits up to storageReadTimeoutMs for the read, then as long again for queued writes.
    async idle() {
      try {
        await idleWithin(writesDone());
      } catch {
        // idle() never rejects into the host
      }
    },

    dispose() {
      if (disposed) return;
      // A change still waiting on the debounce becomes a staged snapshot first.
      try {
        live?.flushDebounce();
      } catch (e) {
        report({ code: "internal-error", message: `dispose: ${String(e)}` });
      }
      // From here nothing records, nothing new starts, and no write is queued.
      // What was staged before still goes through: its write is already queued,
      // and its send is handed to a closed delivery (one last attempt, no retry
      // timers). A snapshot the sink does not take is handed to the next
      // tracker on this key, and stays in storage for the next launch.
      disposed = true;
      for (const d of deliveries.values()) d.close();
      handoffOnKey.set(storageKey, {
        sink: config.sink,
        destination,
        run: startedThisSession ? { current: live && live.state.status === "in_progress" ? live.state : null } : handedRun,
        outboxes: new Map(outboxes),
        left: leftUnsent(),
      });
      if (store) {
        liveOnKey.set(storageKey, Math.max(0, (liveOnKey.get(storageKey) ?? 1) - 1));
        // The next tracker on this key reads only after these writes (bounded by idle()).
        const landed = writesDone().catch(() => undefined);
        const entry = { drain: idleWithin(landed).catch(() => undefined), landed, writes: [...(priorWrites?.writes ?? []), ...writing] };
        lastDrainOnKey.set(storageKey, entry);
        void Promise.all([landed, ...entry.writes]).then(() => {
          if (lastDrainOnKey.get(storageKey) === entry) lastDrainOnKey.delete(storageKey);
        });
      }
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
