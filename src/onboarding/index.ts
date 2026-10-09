// @rocapine/rocalytics-sdk/onboarding: the onboarding run tracker.
//
// Reports one run of an onboarding as snapshots in the shape of the onboarding
// run contract v1 (docs/onboarding-run-contract.md). Headless: no renderer,
// router or UI dependency, so a hand-coded onboarding uses it as is.

export { createOnboardingRunTracker, onboardingRun } from "./tracker";
export type { ExitOptions, OnboardingRun, OnboardingRunTracker, TrackerConfig } from "./tracker";
export type { AnswerInput, ManifestInput, OnboardingInput, StartOptions, StudioInput } from "./input";
export { MAX_ENTRIES, RECORDING_BUDGET } from "./state";
export { LIBRARY_VERSION } from "../version";

// Transport and environment pieces a host needs to configure the tracker.
export { createHttpSink } from "../core/httpSink";
export type { HttpSinkOptions } from "../core/httpSink";
export { memoryStorage } from "../core/storage";
export type { KeyValueStorage } from "../core/storage";
export type { Sink, SinkOutcome, SinkResult } from "../core/sink";
export type { Clock, Timers } from "../core/time";
export type { RunContextInput } from "../core/context";
export type { Diagnostic, DiagnosticHandler } from "../core/diagnostics";

// The contract's payload types, exactly as docs/onboarding-run.types.ts defines them.
export type {
  Answer,
  CompletedRunSnapshot,
  InProgressRunSnapshot,
  Key,
  Manifest,
  ManifestStep,
  OnboardingIdentity,
  OnboardingRunSnapshot,
  Properties,
  PropertyValue,
  RunContext,
  StepEntry,
  StudioLinks,
  Timestamp,
} from "./contract";
