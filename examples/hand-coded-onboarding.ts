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
