import type { DemandScoreSignals, IdentifyParams, OnboardingResponsePayload } from "./types";
import type { PaywallPresentationSnapshot } from "../paywall/contract";

export const ROCALYTICS_API_BASE = "https://rocalytics-api.rocapine.io";

/** What every request carries: the device's roca id, the app id and the platform. There is no auth token. */
export interface RequestContext {
  rocaId: string;
  /** The app's bundle id or package name; sent as `unknown` when null. */
  applicationId: string | null;
  /** `Platform.OS`. */
  platform: string;
  /** Defaults to `ROCALYTICS_API_BASE`. */
  baseUrl?: string;
}

/** A request, ready to hand to `fetch(url, init)`. */
export interface RocalyticsRequest {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body?: string };
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The subset of `fetch` the client uses. */
export type FetchLike = (url: string, init: RocalyticsRequest["init"]) => Promise<FetchResponseLike>;

export function rocalyticsHeaders(context: RequestContext): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Roca-ID": context.rocaId,
    "X-Application-ID": context.applicationId ?? "unknown",
    "X-Platform": context.platform,
  };
}

const post = (context: RequestContext, endpoint: string, body?: unknown): RocalyticsRequest => ({
  url: `${context.baseUrl ?? ROCALYTICS_API_BASE}/functions/v1/${endpoint}`,
  init: {
    method: "POST",
    headers: rocalyticsHeaders(context),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  },
});

/** `/identify`. The payload is sent as given: drop null identifiers first (the client does). */
export function buildIdentifyRequest(context: RequestContext, payload: Partial<IdentifyParams>): RocalyticsRequest {
  return post(context, "identify", payload);
}

export interface TrackRequestInput {
  name: string;
  properties: Record<string, unknown>;
  deviceContext: Record<string, unknown> | null;
  /** Defaults to `${rocaId}-${name}`. */
  deduplicationId?: string;
  /** A custom event is not stored as an analytics event: the API passes it on to drive automations. */
  customEvent?: boolean;
}

/** `/track`. */
export function buildTrackRequest(context: RequestContext, input: TrackRequestInput): RocalyticsRequest {
  return post(context, "track", {
    name: input.name,
    deduplication_id: input.deduplicationId ?? `${context.rocaId}-${input.name}`,
    properties: input.properties,
    device_context: input.deviceContext,
    ...(input.customEvent ? { custom_event: true } : {}),
  });
}

/** `/onboarding-response`. */
export function buildOnboardingResponseRequest(context: RequestContext, payload: OnboardingResponsePayload): RocalyticsRequest {
  return post(context, "onboarding-response", payload);
}

/** `/demand-score`. The body is optional server-side, so none is sent without signals. */
export function buildDemandScoreRequest(context: RequestContext, signals?: DemandScoreSignals): RocalyticsRequest {
  return post(context, "demand-score", signals && Object.keys(signals).length > 0 ? signals : undefined);
}

/**
 * Sends a request and resolves its response, or rejects with
 * `[ROCALYTICS] <endpoint> failed: <status>` (plus ` (<detail>)` when given)
 * when the status is not 2xx.
 */
export async function sendRocalyticsRequest(
  fetch: FetchLike,
  request: RocalyticsRequest,
  endpoint: string,
  detail?: string,
): Promise<FetchResponseLike> {
  const response = await fetch(request.url, request.init);
  if (!response.ok) {
    throw new Error(`[ROCALYTICS] ${endpoint} failed: ${response.status}${detail ? ` (${detail})` : ""}`);
  }
  return response;
}

/**
 * The cross-network event id for an event, or `undefined` when its properties
 * carry no transaction identifier: `${name}-${originalTransactionIdentifier}`.
 *
 * Use it as the `event_id` (Meta CAPI or Pixel, TikTok Events API) or
 * `callback_id` (Adjust S2S) when the app also fires the conversion to those
 * networks itself. Rocalytics derives the same id when it forwards the event,
 * so the network deduplicates the two.
 */
export function getEventId(name: string, properties?: Record<string, unknown> | null): string | undefined {
  if (!properties) return undefined;
  const txId =
    (properties.original_transaction_identifier as string | undefined) ??
    (properties.originalTransactionIdentifier as string | undefined) ??
    (properties.transaction as { originalTransactionIdentifier?: string } | undefined)?.originalTransactionIdentifier;
  if (!txId) return undefined;
  return `${name}-${txId}`;
}

/** `/paywall-presentations` (I3): the body is the bare snapshot; identity is in the headers `post` sets. */
export function buildPaywallPresentationRequest(context: RequestContext, snapshot: PaywallPresentationSnapshot): RocalyticsRequest {
  return post(context, "paywall-presentations", snapshot);
}
