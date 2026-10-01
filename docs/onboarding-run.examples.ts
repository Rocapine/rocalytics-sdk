// Onboarding run contract, schema_version 1: the example runs.
//
// Every payload shown in onboarding-run-contract.md is produced here, and so is
// every run behind its worked-example funnel tables. Being TypeScript typed
// against onboarding-run.types.ts, the examples are checked by the compiler; a
// test also validates them against onboarding-run.schema.json and recomputes the
// doc's funnel tables from them. The only import is type-only, so a runtime
// that strips types can load this file without resolving it.
import type {
  Answer,
  Manifest,
  OnboardingIdentity,
  OnboardingRunSnapshot,
  Properties,
  RunContext,
  StepEntry,
  StudioLinks,
} from "./onboarding-run.types";

/** The moment the worked-example funnels are computed at. */
export const AS_OF = "2026-01-12T00:00:00.000Z";
/** An in_progress run with no snapshot received for this long counts as quit. */
export const QUIT_AFTER_MS = 24 * 60 * 60 * 1000;
/** The most entries a snapshot may hold (D8). Past it the tracker stops recording (D26). */
export const MAX_ENTRIES = 500;

export interface ExampleRun {
  /** Server receive time of the run's first snapshot: the run's bucket. */
  first_received_at: string;
  /** Server receive time of the latest snapshot: what the quit threshold reads. */
  last_received_at: string;
  payload: OnboardingRunSnapshot;
}

const CONTEXT: RunContext = {
  app_version: "2.4.0",
  build: "412",
  platform: "ios",
  os_version: "18.1",
  locale: "en-US",
  timezone: "America/New_York",
};

type PathItem = string | { step: string; answers: Answer[] };

const iso = (ms: number) => new Date(ms).toISOString();
const STEP_MS = 10_000;
const RECEIVE_LAG_MS = 300;

/**
 * Builds a run the way a tracker would record it: one entry per screen shown,
 * each lasting ten seconds, one send per entry plus one on completion, and each
 * send arriving 300 ms after it left the device. A step the flow passes over
 * is simply absent from `path`. Past MAX_ENTRIES the tracker stops recording
 * (no new entries, answers or property changes; it still closes the last kept
 * entry and still sends the completion), and marks the snapshot `truncated` (D26).
 */
function run(opts: {
  n: number;
  start: string;
  onboarding: OnboardingIdentity;
  manifest: Manifest;
  path: PathItem[];
  completed: boolean;
  studio?: StudioLinks;
  properties?: Properties;
  context?: RunContext;
}): ExampleRun {
  let t = Date.parse(opts.start);
  const steps: StepEntry[] = [];
  let sends = 0;
  let lastEventAt = t;
  let truncated = false;
  for (const item of opts.path) {
    const step = typeof item === "string" ? item : item.step;
    const previous = steps[steps.length - 1];
    if (previous && previous.exited_at === null) previous.exited_at = iso(t);
    if (steps.length === MAX_ENTRIES) {
      // The user is on a new screen, but recording it would break the limit.
      if (!truncated) {
        truncated = true;
        sends += 1; // one send to report the closed last entry and the flag
        lastEventAt = t;
      }
    } else {
      steps.push({
        step_key: step,
        entered_at: iso(t),
        exited_at: null,
        answers: typeof item === "string" ? [] : item.answers,
      });
      sends += 1;
      lastEventAt = t;
    }
    t += STEP_MS;
  }

  if (opts.completed) {
    if (!truncated) steps[steps.length - 1].exited_at = iso(t);
    lastEventAt = t;
  }

  // Spread in this order so the doc's JSON blocks read top-down. No cast: the
  // compiler checks each branch against the snapshot type.
  const head = {
    schema_version: 1 as const,
    run_id: `00000000-0000-4000-8000-${String(opts.n).padStart(12, "0")}`,
  };
  const tail = {
    onboarding: opts.onboarding,
    ...(opts.studio ? { studio: opts.studio } : {}),
    context: opts.context ?? CONTEXT,
    manifest: opts.manifest,
    ...(opts.properties ? { properties: opts.properties } : {}),
    ...(truncated ? { truncated: true as const } : {}),
    steps,
  };
  const started_at = steps[0].entered_at;
  const payload: OnboardingRunSnapshot = opts.completed
    ? { ...head, seq: sends + 1, status: "completed", started_at, completed_at: iso(t), sent_at: iso(t), ...tail }
    : { ...head, seq: sends, status: "in_progress", started_at, completed_at: null, sent_at: iso(lastEventAt), ...tail };

  return {
    first_received_at: iso(Date.parse(opts.start) + RECEIVE_LAG_MS),
    last_received_at: iso(lastEventAt + RECEIVE_LAG_MS),
    payload,
  };
}

const single = (question_key: string, value: string): Answer => ({ question_key, kind: "single", value });
const minutes = (n: number) => iso(Date.parse("2026-01-10T09:00:00.000Z") + n * 60_000);

// ---------------------------------------------------------------------------
// Kitchen sink: one Studio-served run, two snapshots of it (mid-flow, then
// completed). Uses every optional part of the shape except `variant_key`, which
// a Studio-served run does not carry: each Studio arm is its own onboarding key
// (D25). IN_FLOW_VARIANT below covers `variant_key`.
// ---------------------------------------------------------------------------

const KITCHEN_MANIFEST: Manifest = {
  steps: [
    { step_key: "welcome" },
    { step_key: "goal" },
    { step_key: "experience" },
    { step_key: "plan_quick", slot: "plan" },
    { step_key: "plan_detailed", slot: "plan" },
    { step_key: "permissions" },
    { step_key: "summary" },
  ],
};

const kitchenGoal: PathItem = {
  step: "goal",
  answers: [
    single("goal", "practice"),
    { question_key: "topics", kind: "multi", value: ["vocabulary", "listening"] },
  ],
};
const kitchenExperience: PathItem = {
  step: "experience",
  answers: [{ question_key: "daily_time", kind: "numeric", value: 15, unit: "minute" }],
};
const kitchenPath: PathItem[] = [
  "welcome",
  kitchenGoal,
  kitchenExperience,
  kitchenGoal, // back navigation: a repeated entry
  kitchenExperience,
  "plan_detailed",
  // `permissions` is not shown (already granted): no entry, derived as passed over.
  { step: "summary", answers: [{ question_key: "feedback", kind: "text", value: "Looking forward to it" }] },
];
const kitchen = (path: PathItem[], completed: boolean) =>
  run({
    n: 1,
    start: "2026-01-10T08:00:00.000Z",
    // Studio-served: the key is the Studio onboarding id, the version the deployment id.
    // A Studio-served draft or preview has no deployment id and sends version "draft".
    onboarding: { key: "6f1c2b0e-3d4a-4f8e-9b7c-2a1d0e9f8c7b", version: "412" },
    studio: {
      onboarding_id: "6f1c2b0e-3d4a-4f8e-9b7c-2a1d0e9f8c7b",
      deployment_id: "412",
      audience_id: "7",
    },
    context: { ...CONTEXT, platform: "android", os_version: "15", build: "2040", locale: "fr-FR", timezone: "Europe/Paris", library_version: "0.1.0" },
    manifest: KITCHEN_MANIFEST,
    properties: { signup_source: "email", returning_user: false, cohort_week: 2 },
    path,
    completed,
  });

export const KITCHEN_SINK: ExampleRun[] = [kitchen(kitchenPath.slice(0, 3), false), kitchen(kitchenPath, true)];

// ---------------------------------------------------------------------------
// A hand-coded flow that runs its own in-flow variants under one key (D25).
// ---------------------------------------------------------------------------

export const IN_FLOW_VARIANT: ExampleRun = run({
  n: 2,
  start: "2026-01-10T08:30:00.000Z",
  onboarding: { key: "main", version: "7", variant_key: "short-intro" },
  manifest: { steps: [{ step_key: "welcome" }, { step_key: "goal" }, { step_key: "summary" }] },
  path: ["welcome"],
  completed: false,
});

// ---------------------------------------------------------------------------
// Overflow (D26): a run that loops between two screens far past 500 entries.
// The tracker keeps the first 500, stops recording (entries, answers and
// property changes), and still completes.
// ---------------------------------------------------------------------------

const loop: PathItem[] = [];
for (let i = 0; i < 300; i++) loop.push("question", "review");

export const OVERFLOW: ExampleRun = run({
  n: 401,
  start: "2026-01-10T07:00:00.000Z",
  onboarding: { key: "example-long", version: "1" },
  manifest: {
    steps: [{ step_key: "welcome" }, { step_key: "question" }, { step_key: "review" }, { step_key: "summary" }],
  },
  path: ["welcome", ...loop, "summary"],
  completed: true,
});

// ---------------------------------------------------------------------------
// Worked examples for the funnel measures.
// ---------------------------------------------------------------------------

const SKIP_MANIFEST: Manifest = {
  steps: [
    { step_key: "welcome" },
    { step_key: "goal" },
    { step_key: "experience" },
    { step_key: "permissions" },
    { step_key: "summary" },
  ],
};
const skip = { onboarding: { key: "example-skip", version: "1" }, manifest: SKIP_MANIFEST };
const learn: PathItem = { step: "goal", answers: [single("goal", "learn")] };
const practice: PathItem = { step: "goal", answers: [single("goal", "practice")] };

const SLOT_MANIFEST: Manifest = {
  steps: [
    { step_key: "welcome" },
    { step_key: "goal" },
    { step_key: "plan_quick", slot: "plan" },
    { step_key: "plan_detailed", slot: "plan" },
    { step_key: "summary" },
  ],
};
const slot = { onboarding: { key: "example-slot", version: "1" }, manifest: SLOT_MANIFEST };
const quick: PathItem = { step: "goal", answers: [single("pace", "quick")] };
const detailed: PathItem = { step: "goal", answers: [single("pace", "detailed")] };

const MERGE_MANIFEST: Manifest = {
  steps: [
    { step_key: "welcome" },
    { step_key: "goal" },
    { step_key: "routine_a1", slot: "routine" },
    { step_key: "routine_b1", slot: "routine" },
    { step_key: "routine_a2" },
    { step_key: "summary" },
  ],
};
const merge = { onboarding: { key: "example-merge", version: "1" }, manifest: MERGE_MANIFEST };
const pathA: PathItem = { step: "goal", answers: [single("path", "a")] };
const pathB: PathItem = { step: "goal", answers: [single("path", "b")] };

export const WORKED_EXAMPLES: Record<string, { runs: ExampleRun[] }> = {
  derived_skip: {
    runs: [
      run({ ...skip, n: 101, start: minutes(0), completed: true, path: ["welcome", learn, "permissions", "summary"] }),
      run({
        ...skip,
        n: 102,
        start: minutes(15),
        completed: true,
        path: ["welcome", practice, "experience", practice, "experience", "summary"],
      }),
      run({ ...skip, n: 103, start: minutes(30), completed: false, path: ["welcome", practice, "experience"] }),
      run({ ...skip, n: 104, start: minutes(45), completed: false, path: ["welcome", learn, "permissions"] }),
      run({ ...skip, n: 105, start: "2026-01-11T23:00:00.000Z", completed: false, path: ["welcome"] }),
      run({ ...skip, n: 106, start: minutes(60), completed: false, path: ["welcome"] }),
    ],
  },
  alternative_screens: {
    runs: [
      run({ ...slot, n: 201, start: minutes(0), completed: true, path: ["welcome", quick, "plan_quick", "summary"] }),
      run({ ...slot, n: 202, start: minutes(15), completed: true, path: ["welcome", detailed, "plan_detailed", "summary"] }),
      run({ ...slot, n: 203, start: minutes(30), completed: false, path: ["welcome", detailed, "plan_detailed"] }),
      run({ ...slot, n: 204, start: minutes(45), completed: true, path: ["welcome", quick, "plan_quick", "summary"] }),
      run({ ...slot, n: 205, start: minutes(60), completed: false, path: ["welcome", quick] }),
    ],
  },
  merge_back: {
    runs: [
      run({ ...merge, n: 301, start: minutes(0), completed: true, path: ["welcome", pathA, "routine_a1", "routine_a2", "summary"] }),
      run({ ...merge, n: 302, start: minutes(15), completed: false, path: ["welcome", pathA, "routine_a1"] }),
      run({ ...merge, n: 303, start: minutes(30), completed: true, path: ["welcome", pathB, "routine_b1", "summary"] }),
      run({ ...merge, n: 304, start: minutes(45), completed: false, path: ["welcome", pathB, "routine_b1"] }),
      run({ ...merge, n: 305, start: minutes(60), completed: true, path: ["welcome", pathB, "routine_b1", "summary"] }),
    ],
  },
};
