// @rocapine/rocalytics-sdk/client: the Rocalytics client.
//
// Sends installs, purchases, identities, onboarding progress and custom events
// to the Rocalytics API, and reads the demand score. The Expo native modules
// it needs are optional peer dependencies, loaded lazily when the client
// starts (see native.ts): importing this subpath loads none of them.

export {
  INSTALL_TRACKED_KEY,
  LEGACY_INSTALL_TRACKED_KEYS,
  LEGACY_ROCA_ID_KEY,
  ROCA_ID_KEY,
  RocalyticsClient,
} from "./client";
export type { RocalyticsClientOptions } from "./client";
export { createRocalyticsOnboardingSink, rocalyticsOutcome, toOnboardingResponsePayload } from "./onboardingSink";
export { createRocalyticsPaywallSink, paywallIngestOutcome } from "./paywallSink";
export { loadExpoModules } from "./native";
export type { ApplicationModule, ExpoModuleLoaders, LoadResult, RocalyticsModules } from "./native";
export {
  ROCALYTICS_API_BASE,
  buildDemandScoreRequest,
  buildIdentifyRequest,
  buildOnboardingResponseRequest,
  buildPaywallPresentationRequest,
  buildTrackRequest,
  getEventId,
  rocalyticsHeaders,
  sendRocalyticsRequest,
} from "./requests";
export type { FetchLike, FetchResponseLike, RequestContext, RocalyticsRequest, TrackRequestInput } from "./requests";
export type {
  AdjustAttribution,
  DemandScoreResult,
  DemandScoreSignalScore,
  DemandScoreSignals,
  DemandScoreV1,
  DemandScoreV2,
  DemandScoreV2Signal,
  DemandScoreVersion,
  DeviceContext,
  IdentifyParams,
  OnboardingMetadata,
  OnboardingResponsePayload,
  OnboardingStepAnswers,
  OnboardingStepResponse,
  PurchaseProduct,
  PurchaseTransaction,
  TrackEventName,
  TrackPurchaseParams,
} from "./types";
export type { Diagnostic, DiagnosticHandler } from "../core/diagnostics";
export type { Sink, SinkResult } from "../core/sink";
export type { Clock } from "../core/time";
