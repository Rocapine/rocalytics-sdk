/**
 * The three outcomes an ingest can give a snapshot, carried in its response
 * body. Anything else (no response, an error, a response without one of these)
 * is transient: the snapshot is kept and sent again.
 */
export type SinkOutcome = "accepted" | "ignored" | "rejected";

export type SinkResult =
  | { outcome: SinkOutcome; reason?: string }
  | { outcome: "transient"; reason?: string };

/**
 * Delivers one payload somewhere. A sink reports what happened; it does not
 * retry, and it may throw: the caller treats a throw as transient.
 */
export interface Sink<T = unknown> {
  send(payload: T): Promise<SinkResult> | SinkResult;
}

/** Reads a sink's answer strictly: only the three named outcomes end a send. */
export function normalizeResult(value: unknown): SinkResult {
  if (value && typeof value === "object") {
    const { outcome, reason } = value as { outcome?: unknown; reason?: unknown };
    if (outcome === "accepted" || outcome === "ignored" || outcome === "rejected") {
      return typeof reason === "string" ? { outcome, reason } : { outcome };
    }
    if (typeof reason === "string") return { outcome: "transient", reason };
  }
  return { outcome: "transient" };
}
