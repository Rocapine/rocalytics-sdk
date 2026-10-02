# @rocapine/studio-sdk

Headless client SDK for Onboarding Studio. The first surface is the **onboarding run tracker**: a small, typed API that lets any onboarding report its progress in one versioned shape, including an onboarding built entirely in app code with no SDK-rendered screen. The second is the [**Rocalytics client**](#rocalytics-client), for apps that report installs, purchases and onboarding progress to Rocalytics.

- **Headless.** No renderer, router or UI library. The package has no runtime dependency. The tracker (`/onboarding`, `/core`) has no peer dependency either; only `/rocalytics` uses optional peers, the Expo native modules it talks to.
- **One payload contract.** Every send is a snapshot in the shape of the [onboarding run contract v1](docs/onboarding-run-contract.md) (`schema_version: 1`), with a [JSON Schema](docs/onboarding-run.schema.json) and [TypeScript types](docs/onboarding-run.types.ts). The contract is authoritative; this README only explains how the tracker applies it.
- **Pluggable transport.** Snapshots go to a sink. The stock sink POSTs to an HTTP collector you configure.

> Status: `0.1.0`, not yet published to npm.

## Subpaths

| Import | What it is |
|---|---|
| `@rocapine/studio-sdk/onboarding` | The onboarding run tracker. Public API. |
| `@rocapine/studio-sdk/core` | Shared building blocks: the sink interface, latest-snapshot delivery, id minting, run context, storage. Internal: exported for custom sinks and future surfaces, with no stability promise beyond what `/onboarding` re-exports. |
| `@rocapine/studio-sdk/rocalytics` | The Rocalytics client, and a sink that delivers the tracker's runs to Rocalytics. Public API. Needs the Expo peers below. |
| `@rocapine/studio-sdk/paywall` | Placeholder, not shipped. Reserved for a paywall surface. |

Tracking never imports remote-control code, and `/onboarding` never imports `/rocalytics`: an app that only tracks onboarding installs and bundles no native module. Any later remote-control subpath will bring its heavier dependencies as optional peers in the same way.

## A hand-coded onboarding

This file is [`examples/hand-coded-onboarding.ts`](examples/hand-coded-onboarding.ts), type-checked and run by the test suite:

```ts
import { createHttpSink, onboardingRun, type KeyValueStorage, type OnboardingRun } from "@rocapine/studio-sdk/onboarding";

// 1. Once, at app startup.
export function setUpTracking(storage: KeyValueStorage, device: { appVersion: string; build: string; osVersion: string }) {
  onboardingRun.configure({
    sink: createHttpSink({
      url: "https://collector.example.com/v1/onboarding-runs",
      headers: { authorization: "Bearer <install token>" },
    }),
    context: () => ({
      appVersion: device.appVersion,
      build: device.build,
      platform: "ios",
      osVersion: device.osVersion,
      locale: "en-US",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    storage, // e.g. AsyncStorage: lets a run survive the app being killed
  });
}

// 2. When the onboarding opens: resume the killed run if the app restores
//    the user's position, otherwise start a new one.
export async function openOnboarding(restorePosition: boolean): Promise<OnboardingRun> {
  const resumed = restorePosition ? await onboardingRun.resume() : null;
  // Resumed: show the screen your own navigation state restored. The tracker
  // records it as a new entry for its last recorded step (none if truncated).
  if (resumed) return resumed;
  return onboardingRun.start({
    onboarding: { key: "main", version: "3" },
    // Every screen the flow can show, in order. Alternatives at one position share a slot.
    manifest: {
      steps: [
        { stepKey: "welcome" },
        { stepKey: "goal" },
        { stepKey: "level_beginner", slot: "level" },
        { stepKey: "level_advanced", slot: "level" },
        { stepKey: "notifications" },
        { stepKey: "done" },
      ],
    },
    properties: { signup_source: "email" },
  });
}

// 3. Each screen reports when it is shown and when the user leaves it.
//    A screen the flow does not show is simply never entered: there is no
//    skip call. A screen shown again after going back is entered again.
export function walkThrough(run: OnboardingRun, goal: "practice" | "learn", notificationsGranted: boolean) {
  run.enterStep("welcome");
  run.exitStep("welcome");

  run.enterStep("goal");
  run.exitStep("goal", { answers: [{ questionKey: "goal", kind: "single", value: goal }] });

  const level = goal === "practice" ? "level_advanced" : "level_beginner";
  run.enterStep(level);
  run.exitStep(level, { answers: [{ questionKey: "daily_minutes", kind: "numeric", value: 15, unit: "minute" }] });

  if (!notificationsGranted) {
    run.enterStep("notifications");
    run.exitStep("notifications", { answers: [{ questionKey: "notifications", kind: "single", value: "allowed" }] });
  }

  run.enterStep("done");
  run.complete();
}

// 4. When the app moves to the background (React Native: AppState "background").
export function onAppBackground(run: OnboardingRun) {
  run.background();
}
```

That run produces one payload per send. The completed one lists `welcome`, `goal`, one of the two `level` alternatives and `done`. The manifest still declares `notifications`, so a reader can derive that the run skipped it.

## API

### `onboardingRun.configure(config)`

| Option | Default | |
|---|---|---|
| `sink` | required | Where snapshots go. `createHttpSink({ url, headers?, timeoutMs? })`, or your own `Sink`. |
| `context` | required | `{ appVersion, build, platform, osVersion, locale, timezone }`, or a function returning it. Read once per run, at start. There is no country field: the server derives it. |
| `storage` | none | A key-value store shaped like AsyncStorage or `localStorage`. Without it, nothing survives a restart. If it cannot be read (after one retry), or holds a format this version does not know, it is left untouched and the session runs without persistence. |
| `storageKey` | `studio-sdk:onboarding-run` | One restorable run per key. |
| `debounceMs` | `500` | Changes within this window go out as one send. `complete()` and `background()` skip the debounce. |
| `persistTimeoutMs` | `1000` | With `storage`, every snapshot (completion and background included) is written before it is sent, waiting at most this long for the write. |
| `storageReadTimeoutMs` | `5000` | How long `resume()` waits for the stored state to be read. Past it, `resume()` resolves null for the rest of the session; writes go on once the read lands. `idle()` waits up to this long for the read and as long again for queued writes, so about twice this. |
| `retry` | `1000 ms × 2, ≤ 60 s` | Backoff between retries of a transient failure. |
| `onDiagnostic` | `console.warn` | Receives what the tracker declined to do, as `{ code, message, runId? }`. |
| `clock`, `timers`, `uuid` | system | Injected for tests. `uuid` must return a lowercase UUID; the default is UUIDv7. |

`createOnboardingRunTracker(config)` returns an independent tracker with the same methods, for tests or for two flows at once. **Trackers that are live at the same time must each use their own `storageKey`**: two on one key overwrite each other's unsent snapshots, and the second reports a `storage` diagnostic. A tracker created after another one on its key was disposed (as `configure()` does) first waits, bounded, for the disposed one's last writes, whatever storage object each was given.

`dispose()` (which `configure()` calls on the tracker it replaces) stops recording. What was already recorded is not dropped:

- a change still waiting on the debounce is sent;
- writes already queued still land;
- each unsent snapshot gets one last attempt.

A snapshot the sink does not take then stays in storage for the next launch, **when storage is configured and working**. Without storage, with persistence off for the session, or with a write that never finishes, a last attempt that fails is lost. After a reconfigure, the new tracker may send that completion again, with the same `seq` and body, which the ingest ignores.

### `onboardingRun.start(options): OnboardingRun`

```ts
onboardingRun.start({
  onboarding: { key: "main", version: "3", variantKey?: "short-intro" },
  manifest: { steps: [{ stepKey: "goal" }, { stepKey: "level_a", slot: "level" }, { stepKey: "level_b", slot: "level" }] },
  properties?: { signup_source: "email" },        // ≤ 20 scalar values, no personal data
  studio?: { onboardingId?, deploymentId?, audienceId?, draft? },
});
```

- **`onboarding.version` must change whenever the manifest or a question's keys change.**
- **Studio-served flows** may omit `onboarding`. The key then defaults to `studio.onboardingId`, and the version to `studio.deploymentId`. A draft or preview (`draft: true`, or no deployment id) always sends version `"draft"`. A Studio-served run does not carry `variantKey`, because each Studio A/B arm is its own onboarding key.
- **Each `start` is a new run** with a new `run_id`, including a replay. A run already in progress is left as it was, and counts as quit once the server's threshold passes.
- **Invalid input is never sent.** The tracker checks the manifest, identity and context against the contract. If any is invalid, `start` returns a run that records nothing and reports `invalid-start`. Invalid properties are dropped one by one.

### `OnboardingRun`

| Method | |
|---|---|
| `enterStep(stepKey)` | A screen is shown. The step must be in the manifest. Going back to a screen enters it again, which appends a repeated entry. |
| `exitStep(stepKey, { answers? })` | The user leaves the screen. Answers are `{ questionKey, kind: "single" \| "multi" \| "numeric" \| "text", value, unit? }`, and values are stable option keys, never displayed labels. It is fine if this arrives just after the next screen's `enterStep`. |
| `setProperties(properties)` | Adds or changes run properties. |
| `complete()` | The onboarding is finished. This is final: the run records nothing afterwards, and a completed run is never overwritten. |
| `background()` | The app moved to the background. Records the moment and sends without waiting for the debounce. |
| `runId`, `currentStepKey` | The run's id, and the step of its last **recorded** entry. In a truncated run, recording stopped, so this can be an earlier screen than the one the user was on. Do not navigate to it blindly: restore the position from your own navigation state. |

**There is no skip call.** Report only the screens the user was shown. A declared step with no entry counts as skipped when the run reached a later position or completed, and that is worked out when the funnel is read.

No method throws. Anything the tracker declines to do is reported through `onDiagnostic` instead.

### `onboardingRun.resume(): Promise<OnboardingRun | null>`

After the app was killed mid-onboarding, `resume()` returns the run that was in progress, if the app restores the user's position. The run keeps its `run_id` and continues its `seq`. The tracker:

1. closes the screen the user was on, at the last moment the app was known to be in the foreground on it, or at its `exitStep` if that came later;
2. appends a new entry for the restored screen, using the step of the last recorded entry.

The tracker assumes the app restores the screen of the last recorded entry. **A truncated run** (one that hit a recording limit) has stopped recording: `resume()` still returns it, so it can be completed, but it appends no entry, and its `currentStepKey` is the last screen recorded before the limit, not necessarily the one the user was on.

If the app does not restore the position, call `start()` instead.

## Delivery

- **Every send is a full snapshot** with a `seq` that rises by one per send. The server keeps the highest, so a lost request is repaired by the next one.
- **Only an outcome in the response body counts.** A body of `{"outcome": "accepted"}` or `{"outcome": "ignored"}` settles the send. `{"outcome": "rejected"}` drops the snapshot for good, and it is reported, never resent unchanged.
- **Everything else is transient**: a 401, 404, 413 or 5xx without an outcome body, a timeout, or no response. The same snapshot, same `seq` and same body, is retried with backoff.
- **The latest unsent snapshot is persisted**, so it is still delivered after a restart, even when nobody calls `resume()`.

### A custom sink

```ts
import type { Sink, OnboardingRunSnapshot } from "@rocapine/studio-sdk/onboarding";

const sink: Sink<OnboardingRunSnapshot> = {
  async send(snapshot) {
    // deliver it, then report what the ingest said:
    return { outcome: "accepted" }; // or "ignored", "rejected", "transient"
  },
};
```

A sink that throws, or returns anything else, counts as transient.

The tracker sends one snapshot of a run at a time, and treats a send with no answer after `attemptTimeoutMs` (30 s) as transient. The stock HTTP sink gives up after 15 s, so its sends never overlap. A custom sink that keeps a request alive past `attemptTimeoutMs` can see a retry start while the first attempt is still running. The two carry the same `seq` and the same body, so the ingest ignores the duplicate.

## Limits

The tracker enforces the contract's limits:

- 200 manifest steps, 500 entries, 50 answers per entry, 20 properties;
- 1,000-character text answers and 256-character property strings, counted in code points;
- a **recording budget of 261,120 bytes**, measured on the snapshot in the form its completion send would take.

When recording one more entry, answer or property change would cross a limit, the tracker stops recording and sets `truncated: true`. It keeps the entries it already has, and it still sends `completed` when the run completes.

## Rocalytics client

`@rocapine/studio-sdk/rocalytics` is the Rocalytics client that apps used to copy into their codebase as `rocalytics.client.ts`. It sends the same requests as the reference client: a test replays scenarios captured from the reference itself and compares every URL, header and body.

### Peer dependencies

The client talks to these modules. They are optional peers, so an app that does not import `/rocalytics` needs none of them. An app that does must install all of them, which an Expo app on SDK 54 to 57 already has, or gets with `npx expo install expo-application expo-crypto expo-device expo-network expo-secure-store`:

| Package | Range |
|---|---|
| `expo-application` | `^7.0.0 \|\| >=55.0.0` |
| `expo-crypto` | `^15.0.0 \|\| >=55.0.0` |
| `expo-device` | `^8.0.0 \|\| >=55.0.0` |
| `expo-modules-core` | `^3.0.0 \|\| >=55.0.0` |
| `expo-network` | `^8.0.0 \|\| >=55.0.0` |
| `expo-secure-store` | `^15.0.0 \|\| >=55.0.0` |
| `react-native` | `>=0.81.0` |

They are loaded when the client starts, never when the subpath is imported. The client first checks with `expo-modules-core` that each native module is in the app binary. If one is missing, for example because a JS update reached an older build, the client is **inert**: `ready` resolves, `rocaId` stays null, every method resolves without sending anything, and the cause goes to `onDiagnostic`. Nothing throws at launch.

An uninstalled peer is a different case. Metro resolves every `require` when it bundles, so a missing package fails the bundle rather than making the client inert.

### Usage

This file is [`examples/rocalytics-client.ts`](examples/rocalytics-client.ts), type-checked and run by the test suite:

```ts
import { createRocalyticsOnboardingSink, getEventId, RocalyticsClient } from "@rocapine/studio-sdk/rocalytics";
import { onboardingRun, type KeyValueStorage, type RunContextInput } from "@rocapine/studio-sdk/onboarding";

// 1. One client per app, created once at startup. It starts itself: it reads
//    (or mints) the device's roca id, identifies the device, and sends
//    `install` once per device. Every method waits for that.
export const rocalytics = new RocalyticsClient();

// 2. Identifiers, whenever the app learns them. Null values are dropped.
export async function onSignedIn(userId: string, revenueCatId: string | null) {
  await rocalytics.identify({ user_id: userId, revenue_cat_id: revenueCatId });
}

// 3. A purchase. Pass the purchase SDK's product and transaction objects as
//    they are: they are forwarded whole, and the product id is read from
//    `product.productIdentifier` unless you pass `productId`.
export async function onPurchase(
  product: { productIdentifier: string },
  transaction: { originalTransactionIdentifier: string },
  price: number,
  currency: string,
  isTrial: boolean,
) {
  const originalTransactionIdentifier = transaction.originalTransactionIdentifier;
  await rocalytics.trackPurchase({ isTrial, value: price, currency, originalTransactionIdentifier, product, transaction });
  // The id Rocalytics uses when it forwards the conversion, to deduplicate it
  // against one the app sends to an ad network itself.
  return getEventId("purchase", { original_transaction_identifier: originalTransactionIdentifier });
}

// 4. Onboarding progress, reported through the run tracker and delivered to Rocalytics.
export function setUpOnboardingTracking(storage: KeyValueStorage, context: () => RunContextInput) {
  onboardingRun.configure({ sink: createRocalyticsOnboardingSink(rocalytics), context, storage });
}
```

### API

`new RocalyticsClient(options?)`. Every option is for tests or unusual hosts: `modules` (your own native modules, or `null` to run inert), `fetch`, `baseUrl`, `clock` and `onDiagnostic` (default `console.warn`).

| Member | |
|---|---|
| `ready` | Resolves once the client has started, or has gone inert. Never rejects. |
| `rocaId` | The device's id. Null before `ready`, and when inert. |
| `track(name, properties?)`, `trackEvent(...)` | An analytics event: `install`, `onboarding_completed`, `purchase`, `subscription_started` or `trial_started`. |
| `trackPurchase(params)` | `purchase`, deduplicated per original transaction. `{ isTrial, value, currency, originalTransactionIdentifier, productId?, product?, transaction?, redemptionResult? }`. |
| `identify(identifiers)` | Attaches identifiers (`user_id`, `revenue_cat_id`, `adjust_attribution`, ...) to the identity. |
| `trackCustomEvent(name, properties?, dedupSuffix?)` | An event with any name, forwarded to the CRM rather than stored. Deduplicated on `${rocaId}-${name}`, plus `-${dedupSuffix}` when given. |
| `trackOnboarding(stepId, answers?, metadata?)` | The pre-v1 onboarding calls, unchanged. Resends every step seen so far. |
| `getDemandScore(signals?)` | The server's 1 to 100 demand score for this install. Rejects when the client is inert. |

A method whose request gets a non-2xx answer rejects with `[ROCALYTICS] <endpoint> failed: <status>`, as the copied client did. The client logs nothing to the console. The request builders (`buildTrackRequest`, `buildIdentifyRequest`, `buildOnboardingResponseRequest`, `buildDemandScoreRequest`) and `getEventId` are exported as pure functions.

**Onboarding runs.** `createRocalyticsOnboardingSink(client)` is a sink for the tracker. The Rocalytics ingest reads only the pre-v1 onboarding payload, so each snapshot is mapped onto it (`toOnboardingResponsePayload`): entries become `responses`, answers become `{ [questionKey]: value }`, and the run's identity and Studio links go in `onboarding_metadata`. A numeric answer's unit is dropped, because that shape has no place for it. The ingest keeps one onboarding per roca id, so report a flow through the sink or through `trackOnboarding`, not both.

That endpoint answers with a status code and no outcome body, so this sink reads the status, unlike `createHttpSink`: 2xx is accepted, 400 and 405 are rejected, and everything else is transient and retried, a 404 included, since it means `/identify` has not landed yet.

### Migrating from a copied `rocalytics.client.ts`

1. Install the package and the peers above, then delete the copied file.
2. Import from `@rocapine/studio-sdk/rocalytics` instead. The class and type names are unchanged (`RocalyticsClient`, `TrackPurchaseParams`, `IdentifyParams`, `DemandScoreResult`, `OnboardingStepAnswers`, ...).
3. Keep creating the client once, at startup.
4. Check the rows below that apply to your copy.

| If your copy | Then |
|---|---|
| stored the id under `rocalitics-roca-id` | Nothing to do. The id is now read from `rocalytics-roca-id`. On the first launch, a device with only the old key keeps its id, which is copied to the new key. The old key is left in place. A device never gets a new id while either key holds one. |
| recorded the install under `rocadata-install-tracked-4` | Nothing to do. Either install key counts as "install sent", so no device sends `install` twice. |
| imported the Expo modules at the top of the file | Nothing to do. The modules now load lazily, and a missing native module makes the client inert instead of crashing the launch. |
| took `{ product, transaction }`, or `{ productId, redemptionResult }`, in `trackPurchase` | Both still work. `productId` defaults to `product.productIdentifier`. Product and transaction are typed as any object, so pass the purchase SDK's own types. |
| passed `superwallEvent` to `trackPurchase`, or called `trackSuperwallEvent` | Neither is in the package: Superwall event tracking is not ported. |
| called `getEventId(name, transactionId)` | Call `getEventId(name, { original_transaction_identifier: transactionId })`. It returns `undefined` when there is no transaction id. |
| ran an app-specific step after start-up, such as handing the roca id to an attribution SDK | Do it in the app: `await rocalytics.ready`, then use `rocalytics.rocaId` when it is not null. |
| logged requests or purchase properties to the console | The package logs nothing. Start-up problems go to `onDiagnostic`. A failed request still rejects. |
| identified without `locale` at start-up | The start-up identify now sends the device locale, as the reference does. |
| read `selectedVersion` or `versions` from `DemandScoreResult` as always present | Both are optional, so a response from before the score was versioned still fits. Check for them. |
| mocked the copied module in Jest | Mock `@rocapine/studio-sdk/rocalytics` instead, or create the client with `modules` and `fetch` stand-ins. |

## Development

```bash
npm ci
npm run lint
npm run type:check         # the package source
npm run type:check:tests   # tests, docs examples, README example, and the schema/type drift lock
npm test
npm run build && npm run check:exports
npm run gen:schema-types   # after a schema change: regenerate the type the drift lock compares against
```

The public payload types are [`docs/onboarding-run.types.ts`](docs/onboarding-run.types.ts), byte for byte. Two locks catch drift from the JSON Schema:

1. a test regenerates a TypeScript type from the schema and compares it with the checked-in one;
2. `tsc` fails unless that generated type equals `OnboardingRunSnapshot` field for field.

Every payload a test captures is validated against the schema and the contract's rules beyond the schema.

## Releasing

Changes are recorded in [`CHANGELOG.md`](CHANGELOG.md), in Keep a Changelog format with no links, under `## [Unreleased]`. When you bump the version in `package.json`:

1. Move the Unreleased entries under a new `## [x.y.z] - YYYY-MM-DD` heading. Use `unreleased` instead of the date until the version is published.
2. Leave an empty `## [Unreleased]` section above it.

A test fails if the `package.json` version has no matching heading, or if the Unreleased section is missing.
