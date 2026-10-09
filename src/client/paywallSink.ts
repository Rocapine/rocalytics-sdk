import type { Sink, SinkResult } from "../core/sink";
import type { PaywallPresentationSnapshot } from "../paywall/contract";
import type { RocalyticsClient } from "./client";

const OUTCOMES = new Set(["accepted", "ignored", "rejected"]);

/**
 * Reads a `/paywall-presentations` answer per the paywall contract's section 5
 * (onboarding D27): the body's `outcome` decides. A rejected body is permanent
 * whatever the status. Accepted or ignored counts only on a 2xx. Anything
 * else, including a 2xx without an outcome, is transient and retried.
 */
export function paywallIngestOutcome(status: number, body?: unknown): SinkResult {
  const o = body && typeof body === "object" ? (body as { outcome?: unknown; reason?: unknown }) : undefined;
  const outcome = typeof o?.outcome === "string" && OUTCOMES.has(o.outcome) ? (o.outcome as "accepted" | "ignored" | "rejected") : undefined;
  const reason = typeof o?.reason === "string" ? o.reason : undefined;
  if (outcome === "rejected") return reason ? { outcome, reason } : { outcome };
  if (outcome && status >= 200 && status < 300) return { outcome };
  return { outcome: "transient", reason: `status ${status}` };
}

/** Delivers the paywall tracker's snapshots to Rocalytics. Its `destination` is the client's `paywallPresentationDestination`. */
export function createRocalyticsPaywallSink(client: RocalyticsClient): Sink<PaywallPresentationSnapshot> {
  return { destination: client.paywallPresentationDestination, send: (s) => client.sendPaywallPresentation(s) };
}
