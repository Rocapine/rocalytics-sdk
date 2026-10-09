// @rocapine/rocalytics-sdk/paywall: the paywall presentation tracker.
//
// Reports each paywall presentation as snapshots in the shape of the paywall
// presentation contract v1 (docs/paywall-presentation-contract.md). Pass the
// tracker to the paywall host as its `observer`. Headless: no dependency.

export { createPaywallTracker, DEFAULT_PAYWALL_STORAGE_KEY, MAX_STORED_PRESENTATIONS } from "./tracker";
export type { PaywallTracker, PaywallTrackerConfig } from "./tracker";
export type {
  PaywallObserver,
  PaywallPresentationEnd,
  PaywallPresentationHandle,
  PaywallPresentationInfo,
  PaywallSurface,
  PaywallTransactionInfo,
} from "./observer";
export { LIBRARY_VERSION } from "../version";
export { createHttpSink } from "../core/httpSink";
export type { HttpSinkOptions } from "../core/httpSink";
export { memoryStorage } from "../core/storage";
export type { KeyValueStorage } from "../core/storage";
export type { Sink, SinkOutcome, SinkResult } from "../core/sink";
export type { Clock, Timers } from "../core/time";
export type { RunContextInput } from "../core/context";
export type { Diagnostic, DiagnosticHandler } from "../core/diagnostics";
export type {
  EndedPresentationSnapshot,
  InProgressPresentationSnapshot,
  PaywallPresentationSnapshot,
  PresentationOutcome,
  PresentationOutcomeStatus,
  PresentationPaywall,
  PresentationStatus,
  PresentationSurface,
  PresentationTransaction,
} from "./contract";
