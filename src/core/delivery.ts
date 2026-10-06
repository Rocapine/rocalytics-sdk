import { normalizeResult, type Sink, type SinkResult } from "./sink";
import type { Timers } from "./time";

/** One send: a full snapshot and the `seq` it carries. A retry reuses both, unchanged. */
export interface Outbound<T> {
  seq: number;
  body: T;
}

export interface RetryPolicy {
  /** Delay before the first retry. Default 1,000 ms. */
  initialDelayMs?: number;
  /** Multiplier per further retry. Default 2. */
  factor?: number;
  /** Ceiling on the delay. Default 60,000 ms. */
  maxDelayMs?: number;
}

export interface DeliveryOptions<T> {
  sink: Sink<T>;
  timers: Timers;
  retry?: RetryPolicy;
  /** A send that has not answered after this long counts as transient. Default 30,000 ms. */
  attemptTimeoutMs?: number;
  /** Called once a snapshot is settled for good: accepted, ignored or rejected. */
  onSettled?(item: Outbound<T>, result: SinkResult): void;
  /** Called whenever the pending snapshot changes, so it can be persisted. */
  onPendingChange?(pending: Outbound<T> | null): void;
}

export interface Delivery<T> {
  /**
   * Hands over a snapshot. It replaces any pending one with a lower `seq`: full
   * snapshots supersede each other, so only the latest needs to arrive.
   */
  enqueue(item: Outbound<T>): void;
  /** Sends the pending snapshot now, without waiting out a backoff. */
  flush(): void;
  /** The snapshot not yet settled, if any. */
  pending(): Outbound<T> | null;
  /** Stops all timers. The pending snapshot is kept. */
  stop(): void;
  /**
   * Winds down: skips any backoff to give the pending snapshot (and any
   * handed over later) one last attempt each, and never schedules a retry.
   * A snapshot that still fails stays pending, so it is not lost.
   */
  close(): void;
  /**
   * Resolves once no attempt is in flight. After `close()` nothing is retried,
   * so this is when the last attempts are over, and `pending()` is what the
   * sink did not take.
   */
  idle(): Promise<void>;
}

/**
 * Delivers the latest snapshot of one run through a sink, one send at a time.
 *
 * - Only `accepted`, `ignored` and `rejected` settle a snapshot. Everything
 *   else (a throw, a timeout, a result without an outcome) is transient and
 *   the same snapshot is sent again after an exponential backoff.
 * - A settled `seq` is never sent again, so a rejected snapshot is never
 *   resent unchanged.
 * - Nothing here throws into the caller.
 */
export function createDelivery<T>(options: DeliveryOptions<T>): Delivery<T> {
  const { sink, timers } = options;
  const initial = options.retry?.initialDelayMs ?? 1000;
  const factor = options.retry?.factor ?? 2;
  const max = options.retry?.maxDelayMs ?? 60_000;
  const timeoutMs = options.attemptTimeoutMs ?? 30_000;

  let pending: Outbound<T> | null = null;
  let inFlight: Outbound<T> | null = null;
  let settledSeq = 0;
  let failures = 0;
  let retryTimer: unknown = null;
  let stopped = false;
  let closed = false;
  let idleWaiters: (() => void)[] = [];

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A host callback that throws must not break delivery.
    }
  };
  const setPending = (next: Outbound<T> | null) => {
    pending = next;
    safe(() => options.onPendingChange?.(next));
  };
  const clearRetry = () => {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const callSink = (item: Outbound<T>): Promise<SinkResult> =>
    new Promise<SinkResult>((resolve) => {
      const timer = timers.setTimeout(() => resolve({ outcome: "transient", reason: "timeout" }), timeoutMs);
      const done = (r: SinkResult) => {
        timers.clearTimeout(timer);
        resolve(r);
      };
      try {
        Promise.resolve(sink.send(item.body)).then(
          (value) => done(normalizeResult(value)),
          (error) => done({ outcome: "transient", reason: String(error) }),
        );
      } catch (error) {
        done({ outcome: "transient", reason: String(error) });
      }
    });

  const wakeIdle = () => {
    if (inFlight) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const attempt = () => {
    if (stopped || inFlight || !pending) return;
    clearRetry();
    const item = pending;
    inFlight = item;
    void callSink(item).then((result) => {
      inFlight = null;
      if (result.outcome === "transient") {
        if (closed) {
          // No retry after close; a newer snapshot handed over meanwhile still gets its one attempt.
          if (pending && pending.seq > item.seq) attempt();
          return wakeIdle();
        }
        failures += 1;
        const delay = Math.min(max, initial * Math.pow(factor, failures - 1));
        if (!stopped) retryTimer = timers.setTimeout(() => {
          retryTimer = null;
          attempt();
        }, delay);
        return wakeIdle();
      }
      failures = 0;
      settledSeq = Math.max(settledSeq, item.seq);
      if (pending && pending.seq <= item.seq) setPending(null);
      safe(() => options.onSettled?.(item, result));
      attempt(); // a newer snapshot may have arrived meanwhile
      wakeIdle();
    });
  };

  return {
    enqueue(item) {
      if (item.seq <= settledSeq) return;
      if (pending && item.seq <= pending.seq) return;
      setPending(item);
      if (retryTimer === null) attempt();
    },
    flush() {
      clearRetry();
      attempt();
    },
    pending: () => pending,
    stop() {
      stopped = true;
      clearRetry();
    },
    close() {
      if (closed) return;
      closed = true;
      clearRetry();
      attempt();
    },
    idle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        wakeIdle();
      }),
  };
}
