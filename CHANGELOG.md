# Changelog

All notable changes to `@rocapine/rocalytics-sdk` (named `@rocapine/studio-sdk` before 0.2.0, never published under that name) are recorded here.

The format follows Keep a Changelog, and the project follows Semantic Versioning. Dates are written YYYY-MM-DD. A version that has not been published yet is dated `unreleased`.

Versions before 1.0.0 may include breaking changes in a minor release. Once 1.0.0 is released, the entries before it may be truncated from this file.

## [Unreleased]

### Changed
- Published to the public npm registry instead of GitHub Packages: `npm install @rocapine/rocalytics-sdk` needs no `.npmrc` and no token.
- Renamed to `@rocapine/rocalytics-sdk`; `/rocalytics` is now `/client`. Never published under the old name.

### Added
- `@rocapine/rocalytics-sdk/paywall`: the paywall presentation tracker, `createPaywallTracker`. Pass it to the paywall host as `observer`.
  - One presentation is up to three snapshots (start, shown, end) in the shape of the paywall presentation contract v1 (`docs/paywall-presentation-contract.md`, with its JSON Schema and types).
  - Each presentation is delivered on its own, so a new presentation never supersedes an earlier one's unsent end. Unsent snapshots are stored, at most 20, and resent on the next launch.
  - Never throws: invalid input, a failing context or a failing sink is reported through `onDiagnostic`.
- `@rocapine/rocalytics-sdk/client`: `createRocalyticsPaywallSink`, delivering presentations to `/paywall-presentations`, with `paywallIngestOutcome` and `buildPaywallPresentationRequest`.
- `@rocapine/rocalytics-sdk/client`: the Rocalytics client, `RocalyticsClient`, replacing the `rocalytics.client.ts` file apps copied.
  - Its requests equal the reference client's. A test replays scenarios captured from the reference and compares every URL, header and body.
  - API: `ready`, `rocaId`, `track`, `trackEvent`, `trackPurchase`, `identify`, `trackOnboarding`, `trackCustomEvent` (with `dedupSuffix`) and `getDemandScore`.
  - Also exported: `getEventId`, and the request builders `buildTrackRequest`, `buildIdentifyRequest`, `buildOnboardingResponseRequest` and `buildDemandScoreRequest`.
  - The roca id is stored under `rocalytics-roca-id`. A device that has only the misspelled `rocalitics-roca-id` keeps its id, which is copied to the new key. The old key is not deleted, and a newly minted id is written under both keys, so a bundle rolled back to a copied client reads the same id. A failed read never mints a new id.
  - `install` fires once per device. Both `rocadata-install-tracked` and `rocadata-install-tracked-4` count as already sent.
  - The Expo modules load lazily, after a presence check through `expo-modules-core`. When one is missing from the binary, the client is inert and reports why through `onDiagnostic`. It does not throw.
  - No request, response or purchase property is logged. Start-up problems go to `onDiagnostic`, which defaults to `console.warn`.
- `createRocalyticsOnboardingSink(client)`: delivers the onboarding run tracker's snapshots to Rocalytics.
  - Each snapshot is mapped onto the pre-v1 onboarding payload (`toOnboardingResponsePayload`), the only shape the ingest reads, with the `onboarding_metadata` keys the contract's section 9 reads.
  - Its `sent_at` is the run's latest recorded timestamp plus `seq` milliseconds. Within one run that strictly increases across sends, whatever the device clock does, so an ingest that keeps only a strictly later snapshot never drops one of the run's snapshots. A retry resends the identical body. Across runs this does not hold. The ingest keeps one row per roca id, so after the device clock steps back between two runs, a later run's snapshots can be dropped silently, as they could before: about the first span of that run equal to the step, or all of it if the run is shorter. The sink cannot tell a stored 2xx from a dropped one.
  - Once a completed snapshot is accepted, the sink sends `onboarding_completed` once per run, with the run-scoped deduplication id `${rocaId}-onboarding_completed-${run_id}`. Each completed run on a device counts once, and a resend of the same run's completion is deduplicated.
  - `rocalyticsOutcome`: a 2xx is accepted. Only a body saying `{"outcome": "rejected"}` is permanent. Any other answer is transient.
- `Sink.destination` (optional): where a sink delivers. `createHttpSink` sets it to its `url`, and `createRocalyticsOnboardingSink` to the client's onboarding endpoint, exposed as the new `RocalyticsClient.onboardingRunDestination`. With an injected `fetch`, both mark it as `<url> (custom fetch)`. Headers are not part of it.
- `@rocapine/rocalytics-sdk/core`: `Delivery.idle()`, which resolves once no attempt is in flight. `/core` has no stability promise: a custom implementation of `Delivery` must add it.

### Fixed

- `@rocapine/rocalytics-sdk/onboarding`: a reconfigure no longer loses or repeats a snapshot. `dispose()` hands what the sink has not taken after its last attempt, a completion included, to the next tracker created on the same `storageKey` whose sink has the same destination, in memory. That tracker sends it with its own sink and retries, with or without storage. It used to stay only in storage, so it was lost without working storage. The next tracker keeps them in its writes from the start, but waits until the old tracker's last attempts are answered before sending any of the old tracker's snapshots, stored or handed over, and drops the ones they delivered, where it used to send a completion twice. A tracker created and disposed without a run of its own, as two `configure()` calls in a row do, passes on everything it was handed. A write of the old tracker's that lands after the next tracker read storage no longer leaves the new run unresumable, and no longer leads the next tracker to erase the old run's completion: the next tracker writes its own state again as each such write lands. The old tracker's run is handed over as well, in its newest state, so the next tracker's `resume()` continues it from there, with storage or without, and returns null for a run the old tracker completed. It used to resume from whatever state it read, which a late write could leave older, even reviving a completed run and reusing its seq. A snapshot is still lost when the app is killed without working storage.
- `@rocapine/rocalytics-sdk/onboarding`: `resume()` waits for the stored state to be read, however long storage takes. A read slower than `storageReadTimeoutMs` used to make `resume()` resolve null for the rest of the session, so a run in progress was not resumed. Now such a read is reported through `onDiagnostic` and `resume()` resolves once it lands. A read that never answers means `resume()` never resolves, so an app that cannot wait should race it with its own timeout. `storageReadTimeoutMs` still bounds `idle()`, and so how long a tracker created after a `dispose()` on the same key waits for the disposed one's writes. `start()` never waits for the read.
- `@rocapine/rocalytics-sdk/onboarding`: a numeric `studio.onboardingId`, `deploymentId` or `audienceId` passed at run time is sent as its decimal string, as the contract says, when it is a safe non-negative integer. It used to make the start invalid. A fraction, a negative number, `NaN`, `Infinity` or an integer above `Number.MAX_SAFE_INTEGER` is still `invalid-start`, and so is `studio: null`. The TypeScript type stays `string`.

### Changed

- `@rocapine/rocalytics-sdk/onboarding`: snapshots recorded for one destination are never sent to another.
  - A reconfigure hands the old tracker's unsent snapshots and run over only when the new sink has the same `destination`, or, when either sink has none, is the same object.
  - Otherwise the new tracker takes nothing, in memory or from storage, and discards the stored state. It reports `destination-changed` once, only when that discards something (a run in progress, a snapshot the old tracker's last attempts did not deliver, or stored state).
  - Stored state is now stamped with the writing sink's destination. A launch discards stored state written for another destination instead of sending it; two sinks without a destination count as one there.
  - On a reconfigure, a sink with another `destination`, or a custom sink without one that is not the same object, now gets nothing of what the old tracker left unsent. The stock sinks always have a destination, so rebuilding them with the same URL keeps the handoff. A custom sink built anew on each `configure()` should set a `destination`, or be reused.
- `@rocapine/rocalytics-sdk/onboarding`: a stored unsent snapshot that a disposed tracker first reads after `dispose()` no longer gets a last attempt from it. It stays in storage, and the next tracker on the same `storageKey` sends it, so the two never send it at once.
- The package declares optional peer dependencies: `expo-application`, `expo-crypto`, `expo-device`, `expo-modules-core`, `expo-network`, `expo-secure-store` and `react-native`. Every range is `*`, so an app that already has any version of them installs the package without a peer conflict, and the client's run-time presence probe is the compatibility check. Only `/rocalytics` loads them. `/onboarding` and `/core` still depend on nothing, and `npm run check:exports` verifies that over their built require graph.

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
- No runtime dependencies. `/onboarding` and `/core` have no peer dependencies either.
- MIT license.
