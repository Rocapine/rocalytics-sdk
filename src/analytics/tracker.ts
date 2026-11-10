import { safeDiagnostics, type DiagnosticHandler } from "../core/diagnostics";
import { createHttpSink } from "../core/httpSink";
import { createUuid } from "../core/ids";
import { normalizeResult, type Sink, type SinkResult } from "../core/sink";
import { createSerialStore, type KeyValueStorage } from "../core/storage";
import { systemClock, systemTimers, type Clock, type Timers } from "../core/time";
import { LIBRARY_VERSION } from "../version";
import type { AnalyticsPlatform, EventBatch, WireEvent } from "./contract";

/** The warehouse ingest (Rocapine/rocalytics-warehouse services/event-ingest). */
export const ROCALYTICS_INGEST_URL = "https://ingest.rocapi.ne/v1/batch";

export interface AnalyticsContext {
  appVersion?: string | null;
  osVersion?: string | null;
  locale?: string | null;
}

export interface AnalyticsConfig {
  /** Bundle id / package name, as allowlisted by the ingest. */
  appId: string;
  platform: AnalyticsPlatform;
  /** The ingest's batch URL. Default `ROCALYTICS_INGEST_URL`. Ignored when `sink` is given. */
  endpoint?: string;
  sink?: Sink<EventBatch>;
  /**
   * The device's `roca_id`, e.g. `() => client.rocaId`. Read when an event is
   * tracked and again at send, so events tracked before it resolves are kept
   * and sent with it.
   */
  rocaId?: () => string | null | undefined | Promise<string | null | undefined>;
  /** App and device facts, read for every event. */
  context?: AnalyticsContext | (() => AnalyticsContext);
  /** Keeps unsent events, the user id and the session across restarts. AsyncStorage fits as is. */
  storage?: KeyValueStorage;
  storageKey?: string;
  /** Send once this many events are queued. Default 50. */
  flushAt?: number;
  /** Send whatever is queued this often. Default 15,000 ms. */
  flushIntervalMs?: number;
  /** Events kept while offline; the oldest are dropped beyond it. Default 1,000. */
  maxQueue?: number;
  /** Inactivity that starts a new session. Default 5 minutes (Amplitude React Native's default). */
  sessionTimeoutMs?: number;
  clock?: Clock;
  timers?: Timers;
  uuid?: () => string;
  onDiagnostic?: DiagnosticHandler;
}

export interface Analytics {
  /** Queues an event. Never throws, never blocks. */
  track(name: string, properties?: Record<string, unknown>): void;
  /** The app's own account id, attached to every later event. `null` clears it. */
  setUserId(userId: string | null): void;
  /** Sets user properties: queued as a `$identify` event. */
  identify(userProperties: Record<string, unknown>): void;
  /** Logout: clears the user id and starts a new session. */
  reset(): void;
  /** Sends everything queued now. Call it when the app goes to the background. Never rejects. */
  flush(): Promise<void>;
  /** Resolves once queued storage writes are done. */
  idle(): Promise<void>;
  /** Stops timers. Unsent events stay stored for the next launch. */
  dispose(): void;
}

interface Persisted {
  queue: WireEvent[];
  userId: string | null;
  session: { id: number; last: number } | null;
}

const MAX_BATCH = 500;
const MAX_NAME = 128;
const ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Product analytics events, batched to the warehouse ingest.
 *
 * Events are queued on the device (persisted when `storage` is given) and sent
 * in batches: at `flushAt` events, every `flushIntervalMs`, and on `flush()`.
 * One batch is in flight at a time. A transient failure keeps the batch and
 * retries with backoff; `accepted`, `ignored` and `rejected` remove it.
 */
export function createAnalytics(config: AnalyticsConfig): Analytics {
  const clock = config.clock ?? systemClock;
  const timers = config.timers ?? systemTimers;
  const uuid = config.uuid ?? createUuid(clock);
  const report = safeDiagnostics(config.onDiagnostic);
  const sink: Sink<EventBatch> =
    config.sink ?? (createHttpSink({ url: config.endpoint ?? ROCALYTICS_INGEST_URL }) as Sink<EventBatch>);
  const flushAt = Math.max(1, Math.min(config.flushAt ?? 50, MAX_BATCH));
  const intervalMs = config.flushIntervalMs ?? 15_000;
  const maxQueue = Math.max(flushAt, config.maxQueue ?? 1000);
  const sessionTimeout = config.sessionTimeoutMs ?? 5 * 60_000;
  const store = config.storage
    ? createSerialStore<Persisted>(config.storage, config.storageKey ?? "rocalytics.analytics.v1", (e) =>
        report({ code: "storage-failed", message: String(e) }),
      )
    : null;

  let state: Persisted = { queue: [], userId: null, session: null };
  let inFlight: Promise<void> | null = null;
  let failures = 0;
  let retryTimer: unknown = null;
  let tickTimer: unknown = null;
  let disposed = false;
  let loaded = false;
  let sessionTouched = false; // reset called before the stored state loaded
  let saveQueued = false;
  let userIdTouched = false; // setUserId or reset called before the stored state loaded

  const ready: Promise<void> = (async () => {
    if (!store) return;
    const stored = await store.load();
    if (!stored) return;
    // events tracked while loading go after the stored ones and take the stored user id,
    // unless the app set or cleared it meanwhile
    if (!userIdTouched && stored.userId) for (const e of state.queue) if (e.user_id === null) e.user_id = stored.userId;
    // and continue the stored session when the first of them is within its timeout: tracking
    // before the load minted a new session (an app-open event usually is tracked then)
    const minted = state.session;
    const prev = stored.session;
    if (!sessionTouched && minted && prev && minted.id - prev.last <= sessionTimeout) {
      for (const e of state.queue) if (e.session_id === minted.id) e.session_id = prev.id;
      state.session = { id: prev.id, last: minted.last };
    }
    state = {
      queue: [...(stored.queue ?? []), ...state.queue].slice(-maxQueue),
      userId: userIdTouched ? state.userId : stored.userId ?? null,
      session: state.session ?? stored.session ?? null,
    };
  })()
    .catch((e) => report({ code: "storage-failed", message: String(e) }))
    .then(() => {
      loaded = true;
    });

  const persist = () => {
    // one queued write at a time: it serializes the state as of when it runs, so calls made
    // before then are covered by it and calls made after queue the next one
    if (!store || saveQueued) return;
    saveQueued = true;
    void store.saveWith(() =>
      ready.then(() => {
        saveQueued = false;
        return state;
      }),
    );
  };

  const readContext = (): AnalyticsContext => {
    try {
      return (typeof config.context === "function" ? config.context() : config.context) ?? {};
    } catch {
      return {};
    }
  };

  const rocaIdNow = (): string | null => {
    try {
      const v = config.rocaId?.();
      return typeof v === "string" && v ? v : null;
    } catch {
      return null;
    }
  };

  const sessionFor = (now: number): number => {
    const s = state.session;
    const id = s && now - s.last <= sessionTimeout ? s.id : now;
    state.session = { id, last: now };
    return id;
  };

  const enqueue = (name: string, properties: Record<string, unknown>, userProperties?: Record<string, unknown>) => {
    const now = clock.now();
    const ctx = readContext();
    const event: WireEvent = {
      event_id: uuid(),
      name,
      time: now,
      roca_id: rocaIdNow(),
      user_id: state.userId,
      session_id: sessionFor(now),
      app_version: ctx.appVersion ?? null,
      os_version: ctx.osVersion ?? null,
      locale: ctx.locale ?? null,
      properties,
      ...(userProperties ? { user_properties: userProperties } : {}),
    };
    state.queue.push(event);
    if (state.queue.length > maxQueue) {
      const dropped = state.queue.length - maxQueue;
      state.queue.splice(0, dropped);
      report({ code: "queue-full", message: `dropped the ${dropped} oldest event(s)` });
    }
    persist();
    if (state.queue.length >= flushAt) void flush();
    else scheduleTick();
  };

  const scheduleTick = () => {
    if (tickTimer !== null || disposed) return;
    tickTimer = timers.setTimeout(() => {
      tickTimer = null;
      if (state.queue.length) void flush();
    }, intervalMs);
  };

  const sendOnce = async (): Promise<boolean> => {
    await ready;
    const batch = state.queue.slice(0, MAX_BATCH);
    if (!batch.length) return false;
    let rocaId: string | null = null;
    if (batch.some((e) => !e.roca_id)) {
      try {
        const v = await config.rocaId?.();
        rocaId = typeof v === "string" && v ? v : null;
      } catch {
        rocaId = null;
      }
    }
    const body: EventBatch = {
      app_id: config.appId,
      platform: config.platform,
      sent_at: clock.now(),
      sdk: `rocalytics-sdk/${LIBRARY_VERSION}`,
      events: batch.map((e) => (e.roca_id || !rocaId ? e : { ...e, roca_id: rocaId })),
    };
    const result = await attempt(body);
    if (result.outcome === "transient") {
      failures += 1;
      const delay = Math.min(60_000, 1000 * Math.pow(2, failures - 1));
      if (!disposed && retryTimer === null)
        retryTimer = timers.setTimeout(() => {
          retryTimer = null;
          void flush();
        }, delay);
      return false;
    }
    failures = 0;
    if (result.outcome === "rejected") report({ code: "rejected", message: `${batch.length} event(s): ${result.reason ?? ""}` });
    const sent = new Set(batch.map((e) => e.event_id));
    state.queue = state.queue.filter((e) => !sent.has(e.event_id));
    persist();
    return state.queue.length > 0;
  };

  const attempt = (body: EventBatch): Promise<SinkResult> =>
    new Promise((resolve) => {
      const timer = timers.setTimeout(() => resolve({ outcome: "transient", reason: "timeout" }), ATTEMPT_TIMEOUT_MS);
      const done = (r: SinkResult) => {
        timers.clearTimeout(timer);
        resolve(r);
      };
      try {
        Promise.resolve(sink.send(body)).then(
          (r) => done(normalizeResult(r)),
          (e) => done({ outcome: "transient", reason: String(e) }),
        );
      } catch (e) {
        done({ outcome: "transient", reason: String(e) });
      }
    });

  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    inFlight = (async () => {
      try {
        while (!disposed && (await sendOnce()));
      } catch (e) {
        report({ code: "flush-failed", message: String(e) });
      } finally {
        inFlight = null;
        if (state.queue.length && retryTimer === null) scheduleTick();
      }
    })();
    return inFlight;
  };

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      report({ code: "internal", message: String(e) });
    }
  };

  return {
    track(name, properties) {
      safe(() => {
        if (typeof name !== "string" || !name || name.length > MAX_NAME) {
          report({ code: "invalid-name", message: `event name must be 1 to ${MAX_NAME} characters` });
          return;
        }
        enqueue(name, properties && typeof properties === "object" ? { ...properties } : {});
      });
    },
    setUserId(userId) {
      safe(() => {
        state.userId = typeof userId === "string" && userId ? userId : null;
        if (!loaded) userIdTouched = true;
        persist();
      });
    },
    identify(userProperties) {
      safe(() => enqueue("$identify", {}, { ...userProperties }));
    },
    reset() {
      safe(() => {
        state.userId = null;
        state.session = null;
        if (!loaded) userIdTouched = sessionTouched = true;
        persist();
      });
    },
    flush,
    async idle() {
      await ready;
      await store?.idle();
    },
    dispose() {
      disposed = true;
      for (const t of [retryTimer, tickTimer]) if (t !== null) timers.clearTimeout(t);
      retryTimer = tickTimer = null;
    },
  };
}
