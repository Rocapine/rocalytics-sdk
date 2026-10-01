// @rocapine/studio-sdk/core: shared building blocks for the surface subpaths.
// Internal: exported so a custom sink or another surface can use it, with no
// stability promise beyond what /onboarding re-exports.

export { captureRunContext } from "./context";
export type { RunContextInput, WireRunContext } from "./context";
export { consoleDiagnostics, safeDiagnostics } from "./diagnostics";
export type { Diagnostic, DiagnosticHandler } from "./diagnostics";
export { createDelivery } from "./delivery";
export type { Delivery, DeliveryOptions, Outbound, RetryPolicy } from "./delivery";
export { createHttpSink } from "./httpSink";
export type { HttpSinkOptions } from "./httpSink";
export { createUuid, randomBytes16, uuidv7 } from "./ids";
export { normalizeResult } from "./sink";
export type { Sink, SinkOutcome, SinkResult } from "./sink";
export { createSerialStore, memoryStorage } from "./storage";
export type { KeyValueStorage, SerialStore } from "./storage";
export { codePointLength, utf8ByteLength } from "./text";
export { systemClock, systemTimers, toTimestamp } from "./time";
export type { Clock, Timers } from "./time";
