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
 *
 * The caller sends one payload of a run at a time, and counts a send with no
 * answer after its attempt timeout (30 s by default) as transient. A sink that
 * keeps working past that timeout can therefore overlap with the retry. Both
 * carry the same seq and body, so this is safe against an ingest that ignores
 * an equal seq, but a sink should give up before the attempt timeout (the
 * stock HTTP sink gives up after 15 s).
 */
export interface Sink<T = unknown> {
  /**
   * Where payloads go, such as the collector's URL. Two sinks with the same
   * destination are interchangeable: a reconfigure hands the old tracker's
   * unsent snapshots to the new one, and stored ones are sent by either.
   * Without it, only the same sink object counts as the same destination.
   * Leave it unset on a sink that does not really deliver there (a test double).
   */
  readonly destination?: string;
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
