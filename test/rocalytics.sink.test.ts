import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOnboardingRunTracker, type OnboardingRunSnapshot } from "../src/onboarding";
import {
  RocalyticsClient,
  createRocalyticsOnboardingSink,
  rocalyticsOutcome,
  toOnboardingResponsePayload,
  type OnboardingResponsePayload,
} from "../src/rocalytics";
import { assertConformant } from "./contract";
import { ManualTime } from "./fakes";
import { CONTEXT } from "./harness";
import { FakeSecureStore, IOS, ROCA_ID, fakeModules, recordingFetch, stubIntl } from "./rocalytics.fakes";

// The run tracker's snapshots, delivered to Rocalytics. The Rocalytics ingest
// only knows the pre-v1 onboarding payload (`/onboarding-response`), so the
// sink maps each v1 snapshot onto it, and reads the HTTP status, since that
// endpoint answers with a status and no outcome body.

let restoreIntl: () => void;
beforeEach(() => {
  restoreIntl = stubIntl(IOS);
});
afterEach(() => restoreIntl());

const COMPLETED: OnboardingRunSnapshot = {
  schema_version: 1,
  run_id: "0190a8c4-4b2e-7c1a-9f3d-2e5b6c7d8e9f",
  seq: 4,
  status: "completed",
  started_at: "2026-01-10T08:00:00.000Z",
  sent_at: "2026-01-10T08:00:40.000Z",
  completed_at: "2026-01-10T08:00:40.000Z",
  onboarding: { key: "main", version: "3", variant_key: "short-intro" },
  studio: { onboarding_id: "onb_123", deployment_id: "dep_789", audience_id: null },
  context: { ...{ app_version: "2.4.0", build: "412", platform: "ios", os_version: "18.1", locale: "en-US", timezone: "Europe/Paris" }, library_version: "0.1.0" },
  manifest: { steps: [{ step_key: "welcome" }, { step_key: "goal" }, { step_key: "interests" }, { step_key: "minutes" }, { step_key: "done" }] },
  properties: { signup_source: "email" },
  steps: [
    { step_key: "welcome", entered_at: "2026-01-10T08:00:00.000Z", exited_at: "2026-01-10T08:00:10.000Z", answers: [] },
    {
      step_key: "goal",
      entered_at: "2026-01-10T08:00:10.000Z",
      exited_at: "2026-01-10T08:00:20.000Z",
      answers: [{ question_key: "goal", kind: "single", value: "lose_weight" }],
    },
    {
      step_key: "interests",
      entered_at: "2026-01-10T08:00:20.000Z",
      exited_at: "2026-01-10T08:00:25.000Z",
      answers: [
        { question_key: "interests", kind: "multi", value: ["yoga", "running"] },
        { question_key: "note", kind: "text", value: "knees" },
      ],
    },
    {
      step_key: "minutes",
      entered_at: "2026-01-10T08:00:25.000Z",
      exited_at: "2026-01-10T08:00:30.000Z",
      answers: [{ question_key: "daily_minutes", kind: "numeric", value: 15, unit: "minute" }],
    },
    { step_key: "done", entered_at: "2026-01-10T08:00:30.000Z", exited_at: "2026-01-10T08:00:40.000Z", answers: [] },
  ],
};

describe("toOnboardingResponsePayload: a v1 run snapshot in the pre-v1 shape", () => {
  it("maps entries to responses, answers to a value per question, and the run's identity to onboarding_metadata", () => {
    assertConformant(COMPLETED);
    const expected: OnboardingResponsePayload = {
      onboarding_metadata: {
        onboarding_id: "onb_123",
        deployment_id: "dep_789",
        onboarding_key: "main",
        onboarding_version: "3",
        variant_key: "short-intro",
        run_id: "0190a8c4-4b2e-7c1a-9f3d-2e5b6c7d8e9f",
        seq: 4,
        status: "completed",
        schema_version: 1,
        started_at: "2026-01-10T08:00:00.000Z",
        completed_at: "2026-01-10T08:00:40.000Z",
        properties: { signup_source: "email" },
      },
      sent_at: "2026-01-10T08:00:40.000Z",
      responses: [
        { step_id: "welcome", entered_at: "2026-01-10T08:00:00.000Z", exited_at: "2026-01-10T08:00:10.000Z", answers: {} },
        { step_id: "goal", entered_at: "2026-01-10T08:00:10.000Z", exited_at: "2026-01-10T08:00:20.000Z", answers: { goal: "lose_weight" } },
        {
          step_id: "interests",
          entered_at: "2026-01-10T08:00:20.000Z",
          exited_at: "2026-01-10T08:00:25.000Z",
          answers: { interests: ["yoga", "running"], note: "knees" },
        },
        { step_id: "minutes", entered_at: "2026-01-10T08:00:25.000Z", exited_at: "2026-01-10T08:00:30.000Z", answers: { daily_minutes: 15 } },
        { step_id: "done", entered_at: "2026-01-10T08:00:30.000Z", exited_at: "2026-01-10T08:00:40.000Z", answers: {} },
      ],
    };
    expect(toOnboardingResponsePayload(COMPLETED)).toEqual(expected);
  });

  it("leaves out what the run does not have: no Studio links, no variant, no properties, not completed, truncated", () => {
    const { studio: _studio, properties: _properties, ...rest } = COMPLETED;
    const inProgress: OnboardingRunSnapshot = {
      ...rest,
      onboarding: { key: "main", version: "3" },
      status: "in_progress",
      completed_at: null,
      truncated: true,
      steps: [{ step_key: "welcome", entered_at: "2026-01-10T08:00:00.000Z", exited_at: null, answers: [] }],
    };
    assertConformant(inProgress);
    expect(toOnboardingResponsePayload(inProgress)).toEqual({
      onboarding_metadata: {
        onboarding_key: "main",
        onboarding_version: "3",
        run_id: COMPLETED.run_id,
        seq: 4,
        status: "in_progress",
        schema_version: 1,
        started_at: "2026-01-10T08:00:00.000Z",
        truncated: true,
      },
      sent_at: COMPLETED.sent_at,
      responses: [{ step_id: "welcome", entered_at: "2026-01-10T08:00:00.000Z", exited_at: null, answers: {} }],
    });
  });

  it("does not share arrays with the snapshot", () => {
    const payload = toOnboardingResponsePayload(COMPLETED);
    (payload.responses[2].answers.interests as string[]).push("swim");
    expect(COMPLETED.steps[2].answers[0].value).toEqual(["yoga", "running"]);
  });
});

describe("rocalyticsOutcome: the endpoint's status codes as sink outcomes", () => {
  it.each([
    [204, "accepted"],
    [200, "accepted"],
    [400, "rejected"],
    [405, "rejected"],
    [404, "transient"], // identify has not created the identity yet
    [408, "transient"],
    [429, "transient"],
    [500, "transient"],
    [503, "transient"],
  ])("%i -> %s", (status, outcome) => {
    expect(rocalyticsOutcome(status).outcome).toBe(outcome);
  });
});

describe("createRocalyticsOnboardingSink", () => {
  const client = (respond: Record<string, { status: number }> = {}, store = new FakeSecureStore({ "rocalytics-roca-id": ROCA_ID, "rocadata-install-tracked": "true" })) => {
    const http = recordingFetch(respond);
    return { http, client: new RocalyticsClient({ modules: fakeModules(IOS, store), fetch: http.fetch, onDiagnostic: () => {} }) };
  };

  it("POSTs the mapped snapshot to /onboarding-response with the client's headers, after the client is ready", async () => {
    const { client: c, http } = client();
    const result = await createRocalyticsOnboardingSink(c).send(COMPLETED);
    expect(result).toEqual({ outcome: "accepted" });
    expect(http.paths()).toEqual(["/functions/v1/identify", "/functions/v1/onboarding-response"]);
    const request = http.requests[1];
    expect(request.headers).toEqual({ "Content-Type": "application/json", "X-Roca-ID": ROCA_ID, "X-Application-ID": "com.example.app", "X-Platform": "ios" });
    expect(request.body).toEqual(toOnboardingResponsePayload(COMPLETED));
  });

  it("reports a 400 as rejected, with the status as the reason", async () => {
    const { client: c } = client({ "/functions/v1/onboarding-response": { status: 400 } });
    expect(await createRocalyticsOnboardingSink(c).send(COMPLETED)).toEqual({ outcome: "rejected", reason: "status 400" });
  });

  it("reports a network failure as transient", async () => {
    const c = new RocalyticsClient({
      modules: fakeModules(IOS, new FakeSecureStore({ "rocalytics-roca-id": ROCA_ID, "rocadata-install-tracked": "true" })),
      fetch: async (url) => {
        if (url.endsWith("/identify")) return { ok: true, status: 200, json: async () => ({}) };
        throw new TypeError("Network request failed");
      },
      onDiagnostic: () => {},
    });
    expect(await createRocalyticsOnboardingSink(c).send(COMPLETED)).toEqual({ outcome: "transient", reason: "TypeError: Network request failed" });
  });

  it("an inert client sends nothing and answers transient, so the tracker keeps the snapshot for the next launch", async () => {
    const http = recordingFetch();
    const c = new RocalyticsClient({ modules: null, fetch: http.fetch, onDiagnostic: () => {} });
    expect(await createRocalyticsOnboardingSink(c).send(COMPLETED)).toEqual({ outcome: "transient", reason: "the Rocalytics client is inert" });
    expect(http.requests).toEqual([]);
  });

  it("carries a hand-coded run from the tracker to Rocalytics, ending on the completed snapshot", async () => {
    const { client: c, http } = client();
    const time = new ManualTime();
    const tracker = createOnboardingRunTracker({
      sink: createRocalyticsOnboardingSink(c),
      context: CONTEXT,
      clock: time.clock,
      timers: time.timers,
      debounceMs: 0,
      onDiagnostic: () => {},
    });
    const run = tracker.start({ onboarding: { key: "main", version: "3" }, manifest: { steps: [{ stepKey: "welcome" }, { stepKey: "goal" }] } });
    run.enterStep("welcome");
    await time.advance(1000);
    run.exitStep("welcome");
    run.enterStep("goal");
    await time.advance(1000);
    run.exitStep("goal", { answers: [{ questionKey: "goal", kind: "single", value: "learn" }] });
    run.complete();
    await time.advance(0);
    await c.ready;
    await time.advance(0);

    const sent = http.requests.filter((r) => r.url.endsWith("/onboarding-response")).map((r) => r.body as OnboardingResponsePayload);
    expect(sent.length).toBeGreaterThan(0);
    const last = sent[sent.length - 1];
    expect(last.onboarding_metadata).toMatchObject({ onboarding_key: "main", onboarding_version: "3", status: "completed", run_id: run.runId });
    expect(last.responses.map((r) => [r.step_id, r.answers])).toEqual([
      ["welcome", {}],
      ["goal", { goal: "learn" }],
    ]);
    // The ingest drops a snapshot older than the one it holds, so sent_at must never go backwards.
    const sentAt = sent.map((p) => Date.parse(p.sent_at));
    expect([...sentAt].sort((a, b) => a - b)).toEqual(sentAt);
    tracker.dispose();
  });
});
