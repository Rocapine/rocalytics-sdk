# @rocapine/rocalytics-sdk

Headless client SDK for Onboarding Studio. The first surface is the **onboarding run tracker**: a small, typed API that lets any onboarding report its progress in one versioned shape, including an onboarding built entirely in app code with no SDK-rendered screen. The second is the [**Rocalytics client**](#client), for apps that report installs, purchases and onboarding progress to Rocalytics.

- **Headless.** No renderer, router or UI library. The package has no runtime dependency. The tracker (`/onboarding`, `/core`) has no peer dependency either; only `/client` uses optional peers, the Expo native modules it talks to.
- **One payload contract.** Every send is a snapshot in the shape of the [onboarding run contract v1](docs/onboarding-run-contract.md) (`schema_version: 1`), with a [JSON Schema](docs/onboarding-run.schema.json) and [TypeScript types](docs/onboarding-run.types.ts). The contract is authoritative; this README only explains how the tracker applies it.
- **Pluggable transport.** Snapshots go to a sink. The stock sink POSTs to an HTTP collector you configure.

> Status: `0.1.0`, not yet published.

## Installing

The package is public on the npm registry:

```sh
npm install @rocapine/rocalytics-sdk
```

## Subpaths

| Import | What it is |
|---|---|
| `@rocapine/rocalytics-sdk/onboarding` | The onboarding run tracker. Public API. |
| `@rocapine/rocalytics-sdk/core` | Shared building blocks: the sink interface, latest-snapshot delivery, id minting, run context, storage. Internal: exported for custom sinks and future surfaces, with no stability promise beyond what `/onboarding` re-exports. |
| `@rocapine/rocalytics-sdk/client` | The Rocalytics client, and a sink that delivers the tracker's runs to Rocalytics. Public API. Needs the Expo peers below. |
| `@rocapine/rocalytics-sdk/paywall` | The paywall presentation tracker. Public API. |

The package is for tracking only: it holds no remote-control code. `/onboarding` and `/paywall` never import `/client`, so an app that only tracks onboarding or paywalls installs and bundles no native module.

## A hand-coded onboarding

This file is [`examples/hand-coded-onboarding.ts`](examples/hand-coded-onboarding.ts), type-checked and run by the test suite:

```ts
import { createHttpSink, onboardingRun, type KeyValueStorage, type OnboardingRun } from "@rocapine/rocalytics-sdk/onboarding";

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
//    the user's position, otherwise start a new one. resume() waits for
//    storage however long it takes, so stop waiting after a few seconds.
export async function openOnboarding(restorePosition: boolean, resumeTimeoutMs = 3000): Promise<OnboardingRun> {
  const resumed = restorePosition ? await resumeWithin(resumeTimeoutMs) : null;
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

function resumeWithin(ms: number): Promise<OnboardingRun | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  return Promise.race([onboardingRun.resume(), timeout]).finally(() => clearTimeout(timer));
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
| `sink` | required | Where snapshots go. `createHttpSink({ url, headers?, timeoutMs? })`, or your own `Sink`. Its `destination` decides what a reconfigure hands over and what stored state is sent (see [A custom sink](#a-custom-sink)). |
| `context` | required | `{ appVersion, build, platform, osVersion, locale, timezone }`, or a function returning it. Read once per run, at start. There is no country field: the server derives it. |
| `storage` | none | A key-value store shaped like AsyncStorage or `localStorage`. Without it, nothing survives a restart. If it cannot be read (after one retry), or holds a format this version does not know, it is left untouched and the session runs without persistence. |
| `storageKey` | `rocalytics-sdk:onboarding-run` | One restorable run per key. |
| `debounceMs` | `500` | Changes within this window go out as one send. `complete()` and `background()` skip the debounce. |
| `persistTimeoutMs` | `1000` | With `storage`, every snapshot (completion and background included) is written before it is sent, waiting at most this long for the write. |
| `storageReadTimeoutMs` | `5000` | How long a storage read may take before it is reported (a `storage` diagnostic). It does not cut `resume()` short. It bounds `idle()`, which waits up to this long for the read and as long again for queued writes, so about twice this, and with it how long a tracker created after a `dispose()` on the same `storageKey` waits for the disposed one's writes. `start()` never waits for the read. |
| `retry` | `1000 ms × 2, ≤ 60 s` | Backoff between retries of a transient failure. |
| `onDiagnostic` | `console.warn` | Receives what the tracker declined to do, as `{ code, message, runId? }`. |
| `clock`, `timers`, `uuid` | system | Injected for tests. `uuid` must return a lowercase UUID; the default is UUIDv7. |

`createOnboardingRunTracker(config)` returns an independent tracker with the same methods, for tests or for two flows at once. **Trackers that are live at the same time must each use their own `storageKey`**: two on one key overwrite each other's unsent snapshots, and the second reports a `storage` diagnostic. A tracker created after another one on its key was disposed (as `configure()` does) first waits, bounded, for the disposed one's last writes, whatever storage object each was given.

`dispose()` (which `configure()` calls on the tracker it replaces) stops recording. What was already recorded is not dropped:

- a change still waiting on the debounce is sent;
- writes already queued still land;
- each unsent snapshot gets one last attempt.

A snapshot the sink does not take is then **handed, in memory, to the next tracker created on the same `storageKey`**, as `configure()` does, when that tracker's sink has the same destination (see [A custom sink](#a-custom-sink)). That tracker sends it with its own sink and retries, with or without storage. It keeps them in its own writes from the start, but sends none of the old tracker's snapshots, handed over or read from storage, until the old tracker's last attempts are answered (each within `attemptTimeoutMs`), and it drops any snapshot one of them delivered, so a reconfigure sends each snapshot once and storage never loses one still waiting for its answer. A tracker created and disposed without a run of its own (two `configure()` calls in a row, for example) passes on everything it was handed. The old tracker's run is handed over too, in its newest state: the new tracker's `resume()` returns it, with storage or without, and returns null if the old tracker completed it or started another. So a write of the old tracker's that lands after the new tracker read storage (past the bounded wait) can neither be resumed from an older state nor hide the newer one: the new tracker writes its own state again as each such write lands, once it has a run or was handed one. After a reconfigure to another destination it does so too, which erases what the old tracker wrote.

With working storage, an unsent snapshot also stays in storage for the next launch. The next launch may send again a snapshot that the sink took during `dispose()`, with the same `seq` and body, which the ingest ignores. Without working storage, only a tracker created in the same process gets it (see [Known limits of the tracker](#known-limits-of-the-tracker)).

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
- **Studio-served flows** may omit `onboarding`. The key then defaults to `studio.onboardingId`, and the version to `studio.deploymentId`. Studio ids are strings. A number passed at run time (from untyped JSON, for example) is sent as its decimal string when it is a safe non-negative integer; any other number makes the start invalid. Leave `studio` out rather than passing null. A draft or preview (`draft: true`, or no deployment id) always sends version `"draft"`. A Studio-served run does not carry `variantKey`, because each Studio A/B arm is its own onboarding key.
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

After a reconfigure, `resume()` returns the run the disposed tracker on the same `storageKey` was recording, if it is still in progress, in the newest state that tracker had, whether or not storage is configured. It returns null when the new sink has another destination.

`resume()` waits for the stored state to be read, however long the storage takes; a read slower than `storageReadTimeoutMs` is reported, not abandoned. **A storage that never answers the read means `resume()` never resolves.** An app that cannot wait should race it with its own timeout, and call `start()` if the timeout wins: `start()` never waits for the read. The run it starts is sent as usual, and stored once the read lands.

## Delivery

- **Every send is a full snapshot** with a `seq` that rises by one per send. The server keeps the highest, so a lost request is repaired by the next one.
- **Only an outcome in the response body counts.** A body of `{"outcome": "accepted"}` or `{"outcome": "ignored"}` settles the send. `{"outcome": "rejected"}` drops the snapshot for good, and it is reported, never resent unchanged.
- **Everything else is transient**: a 401, 404, 413 or 5xx without an outcome body, a timeout, or no response. The same snapshot, same `seq` and same body, is retried with backoff.
- **The latest unsent snapshot is persisted**, so it is still delivered after a restart, even when nobody calls `resume()`.

### A custom sink

```ts
import type { Sink, OnboardingRunSnapshot } from "@rocapine/rocalytics-sdk/onboarding";

const sink: Sink<OnboardingRunSnapshot> = {
  destination: "https://collector.example.com/v1/onboarding-runs", // where it delivers; omit on a test double
  async send(snapshot) {
    // deliver it, then report what the ingest said:
    return { outcome: "accepted" }; // or "ignored", "rejected", "transient"
  },
};
```

A sink that throws, or returns anything else, counts as transient.

**`destination`** says where the sink delivers. Snapshots recorded for one destination are never sent to another:

- A reconfigure hands the old tracker's unsent snapshots and run to the new tracker only if both sinks have the same `destination`, or, when either has none, are the same object.
- Otherwise the new tracker takes nothing and discards the stored state it reads. It reports `destination-changed` once, and only if that discards something: a run in progress, a snapshot the old tracker's last attempts did not deliver, or stored state. Switching when nothing is left reports nothing.
- Stored state is stamped with the destination of the tracker that wrote it, and a later launch discards, unsent, what was written for another destination. Two sinks without a destination count as the same one there, since nothing tells them apart.

`createHttpSink` sets `destination` to its `url`, and `createRocalyticsOnboardingSink` to the client's onboarding endpoint, so a sink built anew on each `configure()` with the same URL keeps the same destination. When a `fetch` is injected, both mark it, as `<url> (custom fetch)`: that `fetch` may never reach the URL, so a mock on the production URL never counts as the production sink, while two mocks on the same URL still match.

The destination is the URL only. Headers are not part of it: a collector that picks its environment from a header (a token, for example) needs distinct URLs per environment, or a custom sink with a `destination` of its own.

A sink whose `destination` differs from the old one's, or a custom sink without one that is not the same object, therefore gets nothing of what the old tracker left unsent on a reconfigure. A custom sink built anew on each `configure()` should set a `destination`, or be reused.

**Use one `storageKey` per destination.** A test or staging configuration should use a `storageKey` of its own, so that switching destinations discards nothing.

The tracker sends one snapshot of a run at a time, and treats a send with no answer after `attemptTimeoutMs` (30 s) as transient. The stock HTTP sink gives up after 15 s, so its sends never overlap. A custom sink that keeps a request alive past `attemptTimeoutMs` can see a retry start while the first attempt is still running. The two carry the same `seq` and the same body, so the ingest ignores the duplicate.

## Limits

The tracker enforces the contract's limits:

- 200 manifest steps, 500 entries, 50 answers per entry, 20 properties;
- 1,000-character text answers and 256-character property strings, counted in code points;
- a **recording budget of 261,120 bytes**, measured on the snapshot in the form its completion send would take.

When recording one more entry, answer or property change would cross a limit, the tracker stops recording and sets `truncated: true`. It keeps the entries it already has, and it still sends `completed` when the run completes.

## Known limits of the tracker

Unlike the limits above, which come from the contract, these are the tracker's own. Each is intended in this release, and a test pins it.

- **An app killed without working storage.** A snapshot the sink has not taken survives the end of the process only in storage. When the app is killed without storage, with persistence off for the session (storage that cannot be read, or a stored format this version does not know), or with a write that never finishes, such a snapshot is lost, a completion included. The same holds after a `dispose()` when no tracker is created on its `storageKey` before the app is killed. A reconfigure loses nothing: `dispose()` hands what is unsent to the next tracker in memory (see `dispose()` above).
- **The resumed screen.** `resume()` records the restored screen as a new entry for the last recorded step. There is no way to name a different screen. A truncated run records no entry at all, and its `currentStepKey` is the last step recorded before the limit.

## Paywall presentations

`@rocapine/rocalytics-sdk/paywall` reports each paywall presentation as up to three snapshots (start, shown, end) in the shape of the [paywall presentation contract v1](docs/paywall-presentation-contract.md). A presentation is one `present()` call, or one display of a `Paywall` onboarding step, that resolved to a paywall. Calls refused before a paywall is chosen send nothing. An error after that sends a start and an `error` end.

The tracker satisfies the paywall host's `PaywallObserver` interface structurally, so it is passed to the host as `observer`. This file is [`examples/native-paywall.ts`](examples/native-paywall.ts), type-checked by the test suite:

```ts
import { createPaywallTracker, type KeyValueStorage } from "@rocapine/rocalytics-sdk/paywall";
import { RocalyticsClient, createRocalyticsPaywallSink } from "@rocapine/rocalytics-sdk/client";

// Once, at app startup. Pass `paywallTracker` to the paywall host as `observer`:
//   <PaywallProvider observer={paywallTracker} customScreens={SCREENS}>…</PaywallProvider>
export function setUpPaywallTracking(rocalytics: RocalyticsClient, storage: KeyValueStorage, device: { appVersion: string; build: string; platform: "ios" | "android"; osVersion: string; locale: string }) {
  return createPaywallTracker({
    sink: createRocalyticsPaywallSink(rocalytics),
    context: () => ({
      appVersion: device.appVersion,
      build: device.build,
      platform: device.platform, // e.g. Platform.OS
      osVersion: device.osVersion,
      locale: device.locale, // the device locale, e.g. from expo-localization
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    storage, // e.g. AsyncStorage: an unsent snapshot survives the app being killed
  });
}

// In a custom paywall screen, report the purchase with its join key:
//   complete({ status: "purchased", transaction: {
//     originalTransactionIdentifier,  // the SAME value passed to Rocalytics' purchase call; iOS join key
//     purchaseToken: result.transaction.purchaseToken ?? undefined,    // Android join key: required to attribute proceeds
//     productId: result.productIdentifier,
//   } });
// A restore or a web redemption is not a new purchase:
//   complete({ status: "purchased", transaction: { restored: true } });
```

**Join keys.** The client never sends a price. Proceeds come from store transactions, joined on the key the custom screen reports:
- **iOS:** `originalTransactionIdentifier`, the same value the app already passes to Rocalytics' `purchase` call.
- **Android:** `purchaseToken`. The order id may be passed as `originalTransactionIdentifier` too, but it is not used to join.

A purchase without its platform's join key still counts as a conversion; it earns no proceeds.

**Restores.** `restored: true` marks a purchase that only restored existing access, such as a restore or a web redemption. It is not counted as a conversion.

**Never in the way.** The tracker never throws, never delays `present()` and never changes its result. Invalid input, a failing context or a failing sink is reported to `onDiagnostic`. Each presentation is delivered on its own, and unsent snapshots (at most 20) are stored and resent on the next launch.

## Rocalytics client

`@rocapine/rocalytics-sdk/client` is the Rocalytics client that apps used to copy into their codebase as `rocalytics.client.ts`. It sends the same requests as the reference client: a test replays scenarios captured from the reference itself and compares every URL, header and body.

### Peer dependencies

The client talks to these modules. They are optional peers, so an app that does not import `/client` needs none of them. An app that does must install all of them, which an Expo app usually already has, or gets with `npx expo install expo-application expo-crypto expo-device expo-network expo-secure-store`:

| Package | Range |
|---|---|
| `expo-application` | `*` |
| `expo-crypto` | `*` |
| `expo-device` | `*` |
| `expo-modules-core` | `*` |
| `expo-network` | `*` |
| `expo-secure-store` | `*` |
| `react-native` | `*` |

Every range is `*` on purpose. npm checks an optional peer that the app already has, so any range would stop some app that only imports `/onboarding` from installing the package. Compatibility is checked at run time instead, by the presence probe described below. Only the Expo SDK 54 to 57 versions of these modules have been checked against the client, by reading their source.

They are loaded when the client starts, never when the subpath is imported. The client first checks with `expo-modules-core` that each native module is in the app binary. If one is missing, for example because a JS update reached an older build, the client is **inert**: `ready` resolves, `rocaId` stays null, every method resolves without sending anything, and the cause goes to `onDiagnostic`. Nothing throws at launch.

An uninstalled peer is a different case. Metro resolves every `require` when it bundles, so a missing package fails the bundle rather than making the client inert.

### Usage

This file is [`examples/client.ts`](examples/client.ts), type-checked and run by the test suite:

```ts
import { createRocalyticsOnboardingSink, getEventId, RocalyticsClient } from "@rocapine/rocalytics-sdk/client";
import { onboardingRun, type KeyValueStorage, type RunContextInput } from "@rocapine/rocalytics-sdk/onboarding";

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
| `trackCustomEvent(name, properties?, dedupSuffix?)` | An event with any name, passed on by the API to drive automations rather than stored as an analytics event. Deduplicated on `${rocaId}-${name}`, plus `-${dedupSuffix}` when given. |
| `trackOnboarding(stepId, answers?, metadata?)` | The pre-v1 onboarding calls, unchanged. Resends every step seen so far. |
| `getDemandScore(signals?)` | The server's 1 to 100 demand score for this install. Rejects when the client is inert. |
| `sendOnboardingRun(snapshot)` | Delivers one onboarding run snapshot as the pre-v1 onboarding payload. For an accepted completed snapshot it then sends `onboarding_completed` once per run, deduplicated on `${rocaId}-onboarding_completed-${run_id}`; if that event fails, the send is transient, so a retry sends it. Never throws. It is the send of `createRocalyticsOnboardingSink`. |
| `onboardingRunDestination` | Where `sendOnboardingRun` delivers: the `/onboarding-response` endpoint of `baseUrl`, marked ` (custom fetch)` when a `fetch` is passed, so that it never counts as the real endpoint. The `destination` of `createRocalyticsOnboardingSink`. |

A method whose request gets a non-2xx answer rejects with `[ROCALYTICS] <endpoint> failed: <status>`, as the copied client did. The client never logs a request, its response or purchase properties. The only thing it reports is why it went inert or why start-up failed, through `onDiagnostic`, which defaults to `console.warn`. The request builders (`buildTrackRequest`, `buildIdentifyRequest`, `buildOnboardingResponseRequest`, `buildDemandScoreRequest`) and `getEventId` are exported as pure functions.

**Onboarding runs.** `createRocalyticsOnboardingSink(client)` is a sink for the tracker. The Rocalytics ingest reads only the pre-v1 onboarding payload, so each snapshot is mapped onto it (`toOnboardingResponsePayload`):

- Entries become `responses`, with `step_key` as `step_id`.
- Answers become `{ [questionKey]: value }`. A numeric answer's unit is dropped, because that shape has no place for it.
- `onboarding_metadata` carries the keys the [contract's section 9](docs/onboarding-run-contract.md#9-pre-v1-payloads-d22-d23) reads back: `onboardingId` (or `onboarding_id`, set to the onboarding key, for a run with no Studio onboarding), `audienceId`, `deployment_id`, `locale` from the run's context, and `draft: true` for a draft. It also carries `onboarding_key`, `onboarding_version`, `variant_key`, `run_id` and `seq`.
- `sent_at` is the run's latest recorded timestamp plus `seq` milliseconds, not the device's send time. The ingest keeps one snapshot per roca id and replaces it only with a strictly later `sent_at`, so two sends in the same millisecond, or a device clock stepping back, would otherwise lose a snapshot. This value rises with every send **within a run**, and a retry resends the identical body. Across runs it does not help. If the device clock steps back between two runs, the next run's snapshots can be dropped silently: about the first span of that run equal to the step, or all of it if the run is shorter. The sink cannot tell a stored 2xx from a dropped one. Pre-v1 reporting had the same limit.

**Completion.** Consumers of the pre-v1 data read completion from the `onboarding_completed` event, not from the snapshot. So once a completed snapshot is accepted, the sink also sends `track("onboarding_completed")`, once per run. Its deduplication id is run-scoped, `${rocaId}-onboarding_completed-${run_id}`. Each completed run on a device produces its own event, a replay included, and a resend of the same run's completion, even after a relaunch, is deduplicated. If it fails, the send counts as transient, and the tracker's retry sends it. Do not also send `onboarding_completed` yourself for a flow reported through the sink.

**Answers.** An answer is stored under its step id and `question_key`. A consumer that reads one particular answer finds it only if the flow keeps the same step key and `questionKey` its previous reporting used. When you move a flow from `trackOnboarding` to the tracker, reuse those ids.

The ingest keeps one onboarding per roca id, so report a flow through the sink or through `trackOnboarding`, not both.

That endpoint answers success with a 2xx and no body, so a 2xx is accepted. Otherwise the contract's rule applies: only a body saying `{"outcome": "rejected"}` is permanent, and every other answer is transient and retried. That includes a 400 without such a body, and a 404. Every send waits for `ready`, so a 404 (no identity for this roca id) means the start-up identify failed in this session. The retries stop failing once an identify succeeds, at the next launch or through the app's own `identify()` call.

**Known limits.**

- **A late completion can be credited to the next run.** The app may be killed before the completed snapshot is sent, then start a new run on relaunch. When the stored snapshot is finally delivered, its `onboarding_completed` event arrives during the new run, so a consumer that matches the event to the row by time can credit the completion to the new run.
- **A permanently failing completion event is retried forever.** If `/track` permanently refuses `onboarding_completed`, the completed snapshot's send stays transient and is retried at the tracker's maximum backoff, about once a minute, for as long as the app runs.

### Migrating from a copied `rocalytics.client.ts`

1. Install the package and the peers above, then delete the copied file.
2. Import from `@rocapine/rocalytics-sdk/client` instead. The class and type names are unchanged (`RocalyticsClient`, `TrackPurchaseParams`, `IdentifyParams`, `DemandScoreResult`, `OnboardingStepAnswers`, ...).
3. Keep creating the client once, at startup.
4. Check the rows below that apply to your copy.

| If your copy | Then |
|---|---|
| stored the id under `rocalitics-roca-id` | Nothing to do. The id is now read from `rocalytics-roca-id`. On the first launch, a device with only the old key keeps its id, which is copied to the new key. The old key is left in place, and a newly minted id is written under both keys, so a bundle rolled back to the copied client reads the same id. A device never gets a new id while either key holds one. |
| recorded the install under `rocadata-install-tracked-4` | Nothing to do. Either install key counts as "install sent", so no device sends `install` twice. |
| imported the Expo modules at the top of the file | Nothing to do. The modules now load lazily, and a missing native module makes the client inert instead of crashing the launch. |
| took `{ product, transaction }`, or `{ productId, redemptionResult }`, in `trackPurchase` | Both still work. `productId` defaults to `product.productIdentifier`. Product and transaction are typed as any object, so pass the purchase SDK's own types. |
| called `getEventId(name, transactionId)` | Call `getEventId(name, { original_transaction_identifier: transactionId })`. It returns `undefined` when there is no transaction id. |
| ran an app-specific step after start-up, such as handing the roca id to an attribution SDK | Do it in the app: `await rocalytics.ready`, then use `rocalytics.rocaId` when it is not null. |
| logged requests or purchase properties to the console | The package logs neither. Start-up problems go to `onDiagnostic` (default `console.warn`; pass your own handler to route or silence them). A failed request still rejects. |
| identified without `locale` at start-up | The start-up identify now sends the device locale, as the reference does. |
| read `selectedVersion` or `versions` from `DemandScoreResult` as always present | Both are optional, so a response from before the score was versioned still fits. Check for them. |
| mocked the copied module in Jest | Mock `@rocapine/rocalytics-sdk/client` instead, or create the client with `modules` and `fetch` stand-ins. |

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

To publish, from a clean checkout of `main`: `npm ci`, then `npm publish`. `publishConfig` sends it to the public npm registry, and `prepublishOnly` runs lint, the test type-check, the tests and the exports check first, so a failing tree cannot be published. Publishing needs an npm account with publish rights on the `@rocapine` scope (`npm login`).

A test fails if the `package.json` version has no matching heading, or if the Unreleased section is missing.
