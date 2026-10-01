# Changelog

All notable changes to `@rocapine/studio-sdk` are recorded here.

The format follows Keep a Changelog, and the project follows Semantic Versioning. Dates are written YYYY-MM-DD. A version that has not been published yet is dated `unreleased`.

Versions before 1.0.0 may include breaking changes in a minor release. Once 1.0.0 is released, the entries before it may be truncated from this file.

## [Unreleased]

## [0.1.0] - unreleased

First release.

### Added

- `@rocapine/studio-sdk/onboarding`: a headless onboarding run tracker.
  - It reports one run of an onboarding as snapshots of the onboarding run contract v1 (`schema_version: 1`).
  - API: `onboardingRun.configure`, `start`, `resume`, and per run `enterStep`, `exitStep` with answers, `setProperties`, `complete` and `background`. `createOnboardingRunTracker` creates an independent instance.
  - There is no skip call. Each send is a full snapshot with a rising `seq`, and a completed run is never overwritten.
  - Recording stops at 500 entries or at a 261,120-byte budget, setting `truncated`, while the run still completes.
  - Input that the ingest would reject is dropped and reported through `onDiagnostic`, never sent and never thrown.
- A pluggable sink interface, and `createHttpSink`, which POSTs each snapshot to a collector.
  - Only an outcome in the response body (`accepted`, `ignored`, `rejected`) settles a send.
  - Anything else is transient and retried with backoff, using the same `seq` and body.
- Storage-backed resume after the app is killed, over any AsyncStorage-shaped key-value storage.
  - A resumed run keeps its `run_id` and `seq`.
  - Each snapshot is written before it is sent, and an unsent snapshot is delivered after a restart.
  - Malformed stored state is discarded. Storage that cannot be read, or holds an unknown format, is left untouched.
- `@rocapine/studio-sdk/core` (internal, no stability promise): the sink interface, latest-snapshot delivery with backoff, UUIDv7 run ids, run context capture, and a serial JSON store.
- The contract v1 document, JSON Schema, TypeScript types and example payloads in `docs/`. The public payload types are the contract's types, and a test fails if they drift from the schema.
- No runtime or peer dependencies.
- MIT license.
