# @rocapine/studio-sdk

Headless client SDK for Onboarding Studio. The first surface is the **onboarding run tracker**: a small, typed API that lets any onboarding report its progress in one versioned shape, including an onboarding built entirely in app code with no SDK-rendered screen.

- **Headless.** No renderer, router or UI library. The package has no runtime dependency and no peer dependency at all.
- **One payload contract.** Every send is a snapshot in the shape of the [onboarding run contract v1](docs/onboarding-run-contract.md) (`schema_version: 1`), with a [JSON Schema](docs/onboarding-run.schema.json) and [TypeScript types](docs/onboarding-run.types.ts). The contract is authoritative; this README only explains how the tracker applies it.
- **Pluggable transport.** Snapshots go to a sink. The stock sink POSTs to an HTTP collector you configure.

> Status: `0.1.0`, not yet published to npm.

## Subpaths

| Import | What it is |
|---|---|
| `@rocapine/studio-sdk/onboarding` | The onboarding run tracker. Public API. |
| `@rocapine/studio-sdk/core` | Shared building blocks: the sink interface, latest-snapshot delivery, id minting, run context, storage. Internal: exported for custom sinks and future surfaces, with no stability promise beyond what `/onboarding` re-exports. |
| `@rocapine/studio-sdk/rocalytics` | Placeholder, not shipped. Reserved for an analytics events surface. |
| `@rocapine/studio-sdk/paywall` | Placeholder, not shipped. Reserved for a paywall surface. |

Tracking never imports remote-control code. Any later remote-control subpath will bring its heavier dependencies as optional peers, so an app that only tracks does not install them.

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
| `storageReadTimeoutMs` | `5000` | The longest `resume()` and `idle()` wait for storage. Past it, `resume()` resolves null and the session runs without persistence. |
| `retry` | `1000 ms × 2, ≤ 60 s` | Backoff between retries of a transient failure. |
| `onDiagnostic` | `console.warn` | Receives what the tracker declined to do, as `{ code, message, runId? }`. |
| `clock`, `timers`, `uuid` | system | Injected for tests. `uuid` must return a lowercase UUID; the default is UUIDv7. |

`createOnboardingRunTracker(config)` returns an independent tracker with the same methods, for tests or for two flows at once.

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
