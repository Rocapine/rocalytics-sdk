import { captureRunContext, type RunContextInput } from "../core/context";
import { createDelivery, type Delivery, type Outbound, type RetryPolicy } from "../core/delivery";
import { safeDiagnostics, type DiagnosticHandler } from "../core/diagnostics";
import { createUuid } from "../core/ids";
import type { Sink } from "../core/sink";
import { createSerialStore, type KeyValueStorage, type SerialStore } from "../core/storage";
import { systemClock, systemTimers, type Clock, type Timers } from "../core/time";
import { LIBRARY_VERSION } from "../version";
import type { PaywallPresentationSnapshot } from "./contract";
import type { PaywallPresentationEnd, PaywallPresentationHandle, PaywallPresentationInfo } from "./observer";
import { createState, markEnded, markShown, toSnapshot, validateInfo, type PresentationState } from "./state";

export const DEFAULT_PAYWALL_STORAGE_KEY = "rocalytics-sdk:paywall-presentations";
export const MAX_STORED_PRESENTATIONS = 20;

export interface PaywallTrackerConfig {
  /** Where snapshots go: `createRocalyticsPaywallSink(client)` from /client, or `createHttpSink`. */
  sink: Sink<PaywallPresentationSnapshot>;
  /** Device and app facts, or a function returning them, read once per presentation. */
  context: RunContextInput | (() => RunContextInput);
  /** Keeps unsent snapshots across restarts. AsyncStorage fits as is. */
  storage?: KeyValueStorage;
  storageKey?: string;
  clock?: Clock;
  timers?: Timers;
  /** Presentation id minter. Must return a lowercase UUID. Default: UUIDv7. */
  uuid?: () => string;
  retry?: RetryPolicy;
  attemptTimeoutMs?: number;
  onDiagnostic?: DiagnosticHandler;
}

/** Satisfies the host SDK's `PaywallObserver`: pass it as `observer`. Never throws. */
export interface PaywallTracker {
  start(info: PaywallPresentationInfo): PaywallPresentationHandle | undefined;
  /** Resolves once queued storage writes are done. */
  idle(): Promise<void>;
  /** Stops retry timers. Unsent snapshots stay stored for the next launch. */
  dispose(): void;
}

type Stored = Record<string, Outbound<PaywallPresentationSnapshot>>;

export function createPaywallTracker(config: PaywallTrackerConfig): PaywallTracker {
  const report = safeDiagnostics(config.onDiagnostic);
  const clock = config.clock ?? systemClock;
  const timers = config.timers ?? systemTimers;
  const uuid = config.uuid ?? createUuid(clock);
  const store: SerialStore<Stored> | null = config.storage
    ? createSerialStore<Stored>(config.storage, config.storageKey ?? DEFAULT_PAYWALL_STORAGE_KEY, (e) =>
        report({ code: "storage", message: String(e) }),
      )
    : null;
  const pending = new Map<string, Outbound<PaywallPresentationSnapshot>>();
  const deliveries = new Map<string, Delivery<PaywallPresentationSnapshot>>();
  let disposed = false;
  // Writes wait for the first load, so a start() at launch cannot overwrite the stored map.
  const loaded: Promise<Stored | null> = store ? store.load().catch(() => null) : Promise.resolve(null);

  const persist = () => {
    if (!store) return;
    if (pending.size > MAX_STORED_PRESENTATIONS) {
      const oldest = [...pending.values()].sort((a, b) => a.body.started_at.localeCompare(b.body.started_at));
      for (const o of oldest.slice(0, pending.size - MAX_STORED_PRESENTATIONS)) {
        pending.delete(o.body.presentation_id);
        report({ code: "storage-cap", message: `dropped unsent presentation ${o.body.presentation_id} from storage` });
      }
    }
    const snapshot = pending.size ? Object.fromEntries(pending) : null;
    void loaded.then(() => store.save(snapshot));
  };

  const deliveryFor = (presentationId: string): Delivery<PaywallPresentationSnapshot> => {
    let d = deliveries.get(presentationId);
    if (d) return d;
    d = createDelivery<PaywallPresentationSnapshot>({
      sink: config.sink,
      timers,
      retry: config.retry,
      attemptTimeoutMs: config.attemptTimeoutMs,
      onSettled: (item, result) => {
        if (result.outcome === "rejected") {
          report({ code: "rejected", message: `snapshot ${item.seq} rejected${result.reason ? `: ${result.reason}` : ""}` });
        }
      },
      onPendingChange: (p) => {
        if (p) pending.set(presentationId, p);
        else {
          pending.delete(presentationId);
          deliveries.get(presentationId)?.stop();
          deliveries.delete(presentationId);
        }
        persist();
      },
    });
    deliveries.set(presentationId, d);
    return d;
  };

  const isOutbound = (v: unknown): v is Outbound<PaywallPresentationSnapshot> => {
    const o = v as { seq?: unknown; body?: { presentation_id?: unknown; seq?: unknown } } | null;
    return !!o && typeof o.seq === "number" && !!o.body && typeof o.body === "object"
      && typeof o.body.presentation_id === "string" && o.body.seq === o.seq;
  };

  if (store) {
    void loaded.then((stored) => {
      if (disposed || !stored || typeof stored !== "object") return;
      for (const [id, item] of Object.entries(stored)) {
        if (!isOutbound(item) || item.body.presentation_id !== id) {
          report({ code: "invalid-stored", message: `ignored stored entry ${id}` });
          continue;
        }
        if (deliveries.has(id)) continue;
        deliveryFor(id).enqueue(item);
      }
    }).catch((e) => report({ code: "internal", message: String(e) }));
  }

  const send = (s: PresentationState) => {
    if (disposed) return;
    const body = toSnapshot(s, clock.now());
    deliveryFor(s.id).enqueue({ seq: body.seq, body });
  };

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      report({ code: "internal", message: String(e) });
    }
  };

  const handle = (s: PresentationState): PaywallPresentationHandle => ({
    shown: () =>
      guard(() => {
        const r = markShown(s, clock.now());
        if (r === "ok") send(s);
        else report({ code: r, message: `shown() ignored: ${r}`, runId: s.id });
      }),
    end: (outcome: PaywallPresentationEnd) =>
      guard(() => {
        const r = markEnded(s, outcome, clock.now());
        if (r === "ok") send(s);
        else report({ code: r, message: `end() ignored: ${r}`, runId: s.id });
      }),
  });

  return {
    start(info) {
      try {
        const problems = validateInfo(info);
        if (problems.length) {
          report({ code: "invalid-info", message: problems.join("; ") });
          return undefined;
        }
        let input: RunContextInput;
        try {
          input = typeof config.context === "function" ? config.context() : config.context;
        } catch (e) {
          report({ code: "invalid-context", message: String(e) });
          return undefined;
        }
        const captured = captureRunContext(input, LIBRARY_VERSION);
        if (!captured.ok) {
          report({ code: "invalid-context", message: captured.errors.join("; ") });
          return undefined;
        }
        const s = createState(info, uuid(), clock.now(), captured.context);
        send(s);
        return handle(s);
      } catch (e) {
        report({ code: "internal", message: String(e) });
        return undefined;
      }
    },
    idle: () => (store ? store.idle() : Promise.resolve()),
    dispose() {
      disposed = true;
      for (const d of deliveries.values()) d.stop();
    },
  };
}
