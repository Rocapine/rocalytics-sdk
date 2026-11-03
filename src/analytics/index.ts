// @rocapine/rocalytics-sdk/analytics: product analytics events, batched to the warehouse
// (Amplitude-shaped: track, setUserId, identify, reset). Separate from /client's typed
// attribution `track`, which is unchanged.

export { createAnalytics } from "./tracker";
export type { Analytics, AnalyticsConfig, AnalyticsContext } from "./tracker";
export type { AnalyticsPlatform, EventBatch, WireEvent } from "./contract";
