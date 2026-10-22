import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIBRARY_VERSION, createOnboardingRunTracker, type OnboardingRunSnapshot, type Sink } from "../src/onboarding";
import {
  RocalyticsClient,
  createRocalyticsOnboardingSink,
  rocalyticsOutcome,
  toOnboardingResponsePayload,
  toOnboardingRunBody,
  type FetchLike,
  type OnboardingResponsePayload,
  type OnboardingRunRequestBody,
} from "../src/client";
import { accept, assertConformant, SIZE_LIMIT, sizeOf } from "./contract";
import { ManualTime } from "./fakes";
import { CONTEXT } from "./harness";
import { FakeSecureStore, IOS, ROCA_ID, fakeModules, stubIntl } from "./client.fakes";

// The run tracker's snapshots, delivered to Rocalytics. Each body is the v1
// snapshot itself plus the pre-v1 keys (`responses`, `onboarding_metadata`),
// so an ingest that reads either shape stores the run
// (docs/onboarding-run-contract.md, section 9 describes how the pre-v1 shape
// is read back).
//
// The fake ingest below is the pre-v1 one, and models the two behaviours the
// sink has to live with: it keeps ONE onboarding row per sender, replaced only
// when the incoming `sent_at` is STRICTLY later than the stored one, and it
// answers 2xx whether it stored the snapshot or dropped it. Like the real
// function, it 400s a body without `responses`.

let restoreIntl: () => void;
beforeEach(() => {
  restoreIntl = stubIntl(IOS);
});
afterEach(() => restoreIntl());

type Reply = { status: number; json?: unknown };

function fakeIngest(options: { onboarding?: (call: number) => Reply; track?: (call: number) => Reply } = {}) {
  const rows = new Map<string, OnboardingRunRequestBody>();
  const posted: OnboardingRunRequestBody[] = [];
  const events: { name: string; deduplication_id: string; properties: unknown }[] = [];
  const stored = new Map<string, { name: string; deduplication_id: string }>();
  const order: string[] = [];
  let onboardingCalls = 0;
  let trackCalls = 0;
  const reply = ({ status, json }: Reply) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (json === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return json;
    },
  });
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    order.push(path);
    if (path === "/functions/v1/identify") return reply({ status: 200, json: {} });
    if (path === "/functions/v1/track") {
      // The API only checks that the deduplication id starts with `${roca_id}-${name}`,
      // and stores one event per deduplication id.
      if (!String(body.deduplication_id).startsWith(`${init.headers["X-Roca-ID"]}-${body.name}`)) return reply({ status: 400, json: { error: "wrong deduplication_id" } });
      const r = options.track?.(++trackCalls) ?? { status: 204 };
      if (r.status < 300) {
        events.push(body);
        if (!stored.has(body.deduplication_id)) stored.set(body.deduplication_id, body);
      }
      return reply(r);
    }
    if (path === "/functions/v1/onboarding-response") {
      posted.push(body);
      if (!Array.isArray(body.responses)) return reply({ status: 400, json: { error: "invalid_responses", message: "responses must be an array" } });
      const r = options.onboarding?.(++onboardingCalls) ?? { status: 204 };
      if (r.status < 300) {
        const sender = init.headers["X-Roca-ID"];
        const stored = rows.get(sender);
        if (!stored || Date.parse(body.sent_at) > Date.parse(stored.sent_at)) rows.set(sender, body);
      }
      return reply(r);
    }
    return reply({ status: 404 });
  };
  return { fetch, posted, events, order, row: () => rows.get(ROCA_ID), storedEvents: () => [...stored.values()] };
}

/**
 * The ingest once it reads contract v1: a body with `schema_version` loses its
 * pre-v1 keys, then goes through the contract's acceptance rules, keyed by
 * sender and run_id, and is answered with the outcome in the body.
 */
function fakeV1Ingest() {
  const runs = new Map<string, OnboardingRunSnapshot>();
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
    if (path !== "/functions/v1/onboarding-response") return reply(200, {});
    const { responses: _responses, onboarding_metadata: _metadata, ...snapshot } = JSON.parse(init.body!);
    const key = `${init.headers["X-Roca-ID"]}/${snapshot.run_id}`;
    const outcome = accept(runs.get(key) ?? null, snapshot);
    if (outcome === "accepted") runs.set(key, snapshot);
    return outcome === "rejected" ? reply(400, { outcome }) : reply(200, { outcome });
  };
  return { fetch, runs: () => [...runs.values()] };
}

const RETURNING = () => new FakeSecureStore({ "rocalytics-roca-id": ROCA_ID, "rocadata-install-tracked": "true" });
const clientFor = (fetch: FetchLike) => new RocalyticsClient({ modules: fakeModules(IOS, RETURNING()), fetch, onDiagnostic: () => {} });

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
  context: { app_version: "2.4.0", build: "412", platform: "ios", os_version: "18.1", locale: "en-US", timezone: "Europe/Paris", library_version: "0.1.0" },
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

const IN_PROGRESS: OnboardingRunSnapshot = (() => {
  const { studio: _studio, properties: _properties, ...rest } = COMPLETED;
  return {
    ...rest,
    onboarding: { key: "main", version: "3" },
    status: "in_progress",
    completed_at: null,
    truncated: true,
    steps: [{ step_key: "welcome", entered_at: "2026-01-10T08:00:00.000Z", exited_at: null, answers: [] }],
  };
})();

describe("toOnboardingResponsePayload: a v1 run snapshot in the pre-v1 shape", () => {
  it("maps entries to responses, answers to a value per question, and the run to section 9's metadata keys", () => {
    assertConformant(COMPLETED);
    const expected: OnboardingResponsePayload = {
      onboarding_metadata: {
        onboardingId: "onb_123",
        deployment_id: "dep_789",
        locale: "en-US",
        onboarding_key: "main",
        onboarding_version: "3",
        variant_key: "short-intro",
        run_id: "0190a8c4-4b2e-7c1a-9f3d-2e5b6c7d8e9f",
        seq: 4,
      },
      // The latest recorded moment (completed_at) plus seq (4) milliseconds.
      sent_at: "2026-01-10T08:00:40.004Z",
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

  it("a run with no Studio onboarding id is attributed through onboarding_id, which section 9 reads for a hand-coded sender", () => {
    assertConformant(IN_PROGRESS);
    expect(toOnboardingResponsePayload(IN_PROGRESS)).toEqual({
      onboarding_metadata: {
        onboarding_id: "main",
        locale: "en-US",
        onboarding_key: "main",
        onboarding_version: "3",
        run_id: COMPLETED.run_id,
        seq: 4,
      },
      sent_at: "2026-01-10T08:00:00.004Z",
      responses: [{ step_id: "welcome", entered_at: "2026-01-10T08:00:00.000Z", exited_at: null, answers: {} }],
    });
  });

  it("sends audienceId when the run has an audience, and draft: true for a draft", () => {
    const draft: OnboardingRunSnapshot = {
      ...COMPLETED,
      onboarding: { key: "onb_123", version: "draft" },
      studio: { onboarding_id: "onb_123", audience_id: "aud_456" },
    };
    assertConformant(draft);
    const { onboarding_metadata } = toOnboardingResponsePayload(draft);
    expect(onboarding_metadata).toMatchObject({ onboardingId: "onb_123", audienceId: "aud_456", draft: true, onboarding_version: "draft" });
    expect(onboarding_metadata).not.toHaveProperty("deployment_id");
    expect(toOnboardingResponsePayload(COMPLETED).onboarding_metadata).not.toHaveProperty("draft");
  });

  it("depends on the snapshot alone, so a resend after a relaunch carries the identical body", () => {
    expect(JSON.stringify(toOnboardingResponsePayload(COMPLETED))).toBe(JSON.stringify(toOnboardingResponsePayload(structuredClone(COMPLETED))));
  });

  it("does not share arrays with the snapshot", () => {
    const payload = toOnboardingResponsePayload(COMPLETED);
    (payload.responses[2].answers.interests as string[]).push("swim");
    expect(COMPLETED.steps[2].answers[0].value).toEqual(["yoga", "running"]);
  });
});

/** The v1 part of a request body: what a v1 ingest validates once it drops the pre-v1 keys. */
function v1Part(body: OnboardingRunRequestBody): OnboardingRunSnapshot {
  const { responses: _responses, onboarding_metadata: _metadata, ...snapshot } = body;
  return snapshot;
}

/** A snapshot of `entries` entries alternating over two steps, each with a 1,000-character text answer. */
function bigSnapshot(entries: number): OnboardingRunSnapshot {
  const at = (i: number) => new Date(Date.parse("2026-01-10T08:00:00.000Z") + i * 1000).toISOString();
  const { truncated: _truncated, ...base } = IN_PROGRESS;
  return {
    ...base,
    manifest: { steps: [{ step_key: "a" }, { step_key: "b" }] },
    started_at: at(0),
    steps: Array.from({ length: entries }, (_, i) => ({
      step_key: i % 2 ? "b" : "a",
      entered_at: at(i),
      exited_at: i === entries - 1 ? null : at(i + 1),
      answers: [{ question_key: "note", kind: "text" as const, value: "x".repeat(1000) }],
    })),
  };
}

describe("toOnboardingRunBody: the v1 snapshot, plus the pre-v1 keys", () => {
  it("sends every v1 field at the top level, and the pre-v1 responses and onboarding_metadata beside them", () => {
    const body = toOnboardingRunBody(COMPLETED);
    expect(Object.keys(body).sort()).toEqual([
      "completed_at",
      "context",
      "manifest",
      "onboarding",
      "onboarding_metadata",
      "properties",
      "responses",
      "run_id",
      "schema_version",
      "sent_at",
      "seq",
      "started_at",
      "status",
      "steps",
      "studio",
    ]);
    const legacy = toOnboardingResponsePayload(COMPLETED);
    expect(body.responses).toEqual(legacy.responses);
    expect(body.onboarding_metadata).toEqual(legacy.onboarding_metadata);
  });

  it("without the pre-v1 keys it is the snapshot, conformant, with the pre-v1 sent_at", () => {
    for (const snapshot of [COMPLETED, IN_PROGRESS]) {
      const v1 = v1Part(toOnboardingRunBody(snapshot));
      assertConformant(v1);
      expect(v1).toEqual({ ...snapshot, sent_at: toOnboardingResponsePayload(snapshot).sent_at });
    }
    expect(toOnboardingRunBody(IN_PROGRESS)).toMatchObject({ truncated: true, onboarding: { key: "main", version: "3" } });
    expect(toOnboardingRunBody(IN_PROGRESS)).not.toHaveProperty("studio");
  });

  it("carries run_id, the onboarding identity, the Studio ids and library_version at the top level", () => {
    const body = toOnboardingRunBody(COMPLETED);
    expect(body).toMatchObject({
      schema_version: 1,
      run_id: COMPLETED.run_id,
      seq: 4,
      status: "completed",
      onboarding: { key: "main", version: "3", variant_key: "short-intro" },
      studio: { onboarding_id: "onb_123", deployment_id: "dep_789", audience_id: null },
      context: { library_version: "0.1.0" },
    });
  });

  it("past 256 KiB with the pre-v1 keys it sends the v1 snapshot alone, so no snapshot outgrows the v1 limit", () => {
    const big = bigSnapshot(150);
    expect(sizeOf(big)).toBeLessThanOrEqual(SIZE_LIMIT);
    expect(sizeOf({ ...big, ...toOnboardingResponsePayload(big) })).toBeGreaterThan(SIZE_LIMIT);
    const body = toOnboardingRunBody(big);
    expect(body).not.toHaveProperty("responses");
    expect(body).not.toHaveProperty("onboarding_metadata");
    assertConformant(body);
    expect(body.sent_at).toBe(toOnboardingResponsePayload(big).sent_at);
    // Below the limit the pre-v1 keys are there.
    expect(toOnboardingRunBody(bigSnapshot(100))).toHaveProperty("responses");
  });

  it("depends on the snapshot alone, so a resend after a relaunch carries the identical body", () => {
    expect(JSON.stringify(toOnboardingRunBody(COMPLETED))).toBe(JSON.stringify(toOnboardingRunBody(structuredClone(COMPLETED))));
  });
});

describe("rocalyticsOutcome: only an explicit rejection body is permanent", () => {
  it.each([
    [204, undefined, "accepted"],
    [200, {}, "accepted"],
    [400, undefined, "transient"],
    [400, { error: "responses must be an array" }, "transient"],
    [400, { outcome: "rejected", reason: "too large" }, "rejected"],
    [413, { outcome: "rejected" }, "rejected"],
    [404, undefined, "transient"],
    [405, undefined, "transient"],
    [500, { error: "boom" }, "transient"],
    [503, undefined, "transient"],
  ] as const)("%i with body %j -> %s", (status, body, outcome) => {
    expect(rocalyticsOutcome(status, body).outcome).toBe(outcome);
  });

  it("keeps the rejection's reason", () => {
    expect(rocalyticsOutcome(400, { outcome: "rejected", reason: "too large" })).toEqual({ outcome: "rejected", reason: "too large" });
  });
});

describe("createRocalyticsOnboardingSink", () => {
  it("POSTs the run body to /onboarding-response with the client's headers, after the client is ready", async () => {
    const ingest = fakeIngest();
    const result = await createRocalyticsOnboardingSink(clientFor(ingest.fetch)).send(IN_PROGRESS);
    expect(result).toEqual({ outcome: "accepted" });
    expect(ingest.order).toEqual(["/functions/v1/identify", "/functions/v1/onboarding-response"]);
    expect(ingest.posted).toEqual([toOnboardingRunBody(IN_PROGRESS)]);
  });

  it("a v1-only body the pre-v1 ingest 400s is transient, so the tracker keeps it until an ingest that reads v1 takes it", async () => {
    const ingest = fakeIngest();
    expect((await createRocalyticsOnboardingSink(clientFor(ingest.fetch)).send(bigSnapshot(150))).outcome).toBe("transient");
    expect(ingest.row()).toBeUndefined();
  });

  it("a 400 is transient unless its body is an explicit rejection", async () => {
    const plain = fakeIngest({ onboarding: () => ({ status: 400, json: { error: "bad" } }) });
    expect((await createRocalyticsOnboardingSink(clientFor(plain.fetch)).send(IN_PROGRESS)).outcome).toBe("transient");
    const explicit = fakeIngest({ onboarding: () => ({ status: 400, json: { outcome: "rejected", reason: "schema" } }) });
    expect(await createRocalyticsOnboardingSink(clientFor(explicit.fetch)).send(IN_PROGRESS)).toEqual({ outcome: "rejected", reason: "schema" });
  });

  it("reports a network failure as transient", async () => {
    const ingest = fakeIngest();
    const c = clientFor(async (url, init) => {
      if (url.endsWith("/identify")) return ingest.fetch(url, init);
      throw new TypeError("Network request failed");
    });
    expect(await createRocalyticsOnboardingSink(c).send(COMPLETED)).toEqual({ outcome: "transient", reason: "TypeError: Network request failed" });
  });

  it("an inert client sends nothing and answers transient, so the tracker keeps the snapshot for the next launch", async () => {
    const ingest = fakeIngest();
    const c = new RocalyticsClient({ modules: null, fetch: ingest.fetch, onDiagnostic: () => {} });
    expect(await createRocalyticsOnboardingSink(c).send(COMPLETED)).toEqual({ outcome: "transient", reason: "the Rocalytics client is inert" });
    expect(ingest.order).toEqual([]);
  });
});

describe("completion: the onboarding_completed event", () => {
  it("fires once the completed snapshot is accepted, with a run-scoped deduplication id, and not for an in-progress one", async () => {
    const ingest = fakeIngest();
    const sink = createRocalyticsOnboardingSink(clientFor(ingest.fetch));
    await sink.send(IN_PROGRESS);
    expect(ingest.events).toEqual([]);
    expect(await sink.send(COMPLETED)).toEqual({ outcome: "accepted" });
    expect(ingest.events).toEqual([
      { name: "onboarding_completed", deduplication_id: `${ROCA_ID}-onboarding_completed-${COMPLETED.run_id}`, properties: {}, device_context: expect.any(Object) },
    ]);
    expect(ingest.order.slice(-2)).toEqual(["/functions/v1/onboarding-response", "/functions/v1/track"]);
  });

  it("two completed runs on one device each produce their own stored event", async () => {
    const ingest = fakeIngest();
    const sink = createRocalyticsOnboardingSink(clientFor(ingest.fetch));
    const second: OnboardingRunSnapshot = { ...COMPLETED, run_id: "0190a8c5-0000-7000-8000-000000000002", started_at: "2026-01-11T08:00:00.000Z" };
    await sink.send(COMPLETED);
    await sink.send(second);
    expect(ingest.storedEvents().map((e) => e.deduplication_id)).toEqual([
      `${ROCA_ID}-onboarding_completed-${COMPLETED.run_id}`,
      `${ROCA_ID}-onboarding_completed-${second.run_id}`,
    ]);
  });

  it("a retry of one run's completion after a relaunch is deduplicated by the ingest", async () => {
    const ingest = fakeIngest();
    await createRocalyticsOnboardingSink(clientFor(ingest.fetch)).send(COMPLETED);
    // A new session: the in-memory "already sent" set is empty, so the event goes out again.
    await createRocalyticsOnboardingSink(clientFor(ingest.fetch)).send(COMPLETED);
    expect(ingest.events).toHaveLength(2);
    expect(ingest.storedEvents()).toHaveLength(1);
  });

  it("does not fire twice when the completed snapshot is sent again", async () => {
    const ingest = fakeIngest();
    const sink = createRocalyticsOnboardingSink(clientFor(ingest.fetch));
    await sink.send(COMPLETED);
    await sink.send(COMPLETED);
    expect(ingest.order.filter((p) => p.endsWith("/track"))).toHaveLength(1);
  });

  it("when the event fails the send is transient, and the retry fires it", async () => {
    const ingest = fakeIngest({ track: (n) => ({ status: n === 1 ? 503 : 204 }) });
    const sink = createRocalyticsOnboardingSink(clientFor(ingest.fetch));
    expect((await sink.send(COMPLETED)).outcome).toBe("transient");
    expect(ingest.events).toEqual([]);
    expect(await sink.send(COMPLETED)).toEqual({ outcome: "accepted" });
    expect(ingest.events.map((e) => e.name)).toEqual(["onboarding_completed"]);
  });

  it("does not fire for a completed snapshot the ingest explicitly rejects", async () => {
    const ingest = fakeIngest({ onboarding: () => ({ status: 400, json: { outcome: "rejected" } }) });
    await createRocalyticsOnboardingSink(clientFor(ingest.fetch)).send(COMPLETED);
    expect(ingest.order.filter((p) => p.endsWith("/track"))).toEqual([]);
  });
});

describe("end to end: the tracker through the sink into an ingest that keeps only a strictly later sent_at", () => {
  function setUp(skew = { ms: 0 }) {
    const ingest = fakeIngest();
    const client = clientFor(ingest.fetch);
    const time = new ManualTime();
    const snapshots: OnboardingRunSnapshot[] = [];
    const inner = createRocalyticsOnboardingSink(client);
    const sink: Sink<OnboardingRunSnapshot> = {
      send: (s) => {
        snapshots.push(structuredClone(s));
        return inner.send(s);
      },
    };
    const tracker = createOnboardingRunTracker({
      sink,
      context: CONTEXT,
      clock: { now: () => time.clock.now() - skew.ms },
      timers: time.timers,
      debounceMs: 0,
      onDiagnostic: () => {},
    });
    const run = tracker.start({
      onboarding: { key: "main", version: "3" },
      manifest: { steps: [{ stepKey: "welcome" }, { stepKey: "goal" }, { stepKey: "done" }] },
    });
    const settle = async () => {
      await client.ready;
      for (let i = 0; i < 5; i++) await time.advance(0);
    };
    const finalSnapshot = () => snapshots[snapshots.length - 1];
    return { ingest, time, run, tracker, settle, finalSnapshot, snapshots };
  }

  const expectCompletedStored = (s: ReturnType<typeof setUp>) => {
    const last = s.finalSnapshot();
    expect(last.status).toBe("completed");
    expect(s.ingest.row()).toEqual(toOnboardingRunBody(last));
    expect(s.ingest.events.map((e) => e.name)).toEqual(["onboarding_completed"]);
    // Every distinct snapshot went out with a strictly later sent_at than the one before.
    const bySeq = new Map(s.ingest.posted.map((p) => [p.onboarding_metadata!.seq as number, Date.parse(p.sent_at)]));
    const times = [...bySeq.entries()].sort(([a], [b]) => a - b).map(([, t]) => t);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  };

  it("exitStep then complete in the same millisecond stores the completed run", async () => {
    const s = setUp();
    s.run.enterStep("welcome");
    await s.time.advance(1000);
    s.run.exitStep("welcome");
    s.run.enterStep("goal");
    await s.time.advance(1000);
    s.run.exitStep("goal", { answers: [{ questionKey: "goal", kind: "single", value: "learn" }] });
    s.run.complete();
    await s.settle();
    expectCompletedStored(s);
    expect(s.ingest.row()!.responses!.map((r) => [r.step_id, r.answers])).toEqual([
      ["welcome", {}],
      ["goal", { goal: "learn" }],
    ]);
    s.tracker.dispose();
  });

  it("background then complete in the same millisecond stores the completed run", async () => {
    const s = setUp();
    s.run.enterStep("welcome");
    await s.time.advance(1000);
    s.run.exitStep("welcome");
    s.run.enterStep("done");
    await s.settle();
    s.run.background();
    s.run.complete();
    await s.settle();
    expectCompletedStored(s);
    s.tracker.dispose();
  });

  it("an ingest that reads v1 stores each onboarding as its own run: a second start never merges into the first", async () => {
    const ingest = fakeV1Ingest();
    const client = clientFor(ingest.fetch);
    const time = new ManualTime();
    const tracker = createOnboardingRunTracker({
      sink: createRocalyticsOnboardingSink(client),
      context: CONTEXT,
      clock: time.clock,
      timers: time.timers,
      debounceMs: 0,
      onDiagnostic: () => {},
    });
    const settle = async () => {
      await client.ready;
      for (let i = 0; i < 5; i++) await time.advance(0);
    };
    // The Studio-served flow starts, then the app falls back to its bundled flow under its own key.
    const served = tracker.start({
      studio: { onboardingId: "42", deploymentId: "7" },
      manifest: { steps: [{ stepKey: "intro" }, { stepKey: "paywall" }] },
    });
    served.enterStep("intro");
    await time.advance(1000);
    await settle();
    const bundled = tracker.start({
      onboarding: { key: "bundled", version: "1" },
      manifest: { steps: [{ stepKey: "welcome" }, { stepKey: "done" }] },
    });
    bundled.enterStep("welcome");
    await time.advance(1000);
    bundled.enterStep("done");
    bundled.complete();
    await settle();

    expect(bundled.runId).not.toBe(served.runId);
    const runs = ingest.runs();
    expect(runs.map((r) => [r.run_id, r.onboarding, r.studio ?? null, r.status, r.steps.map((e) => e.step_key)])).toEqual([
      [served.runId, { key: "42", version: "7" }, { onboarding_id: "42", deployment_id: "7" }, "in_progress", ["intro"]],
      [bundled.runId, { key: "bundled", version: "1" }, null, "completed", ["welcome", "done"]],
    ]);
    for (const r of runs) expect(r.context.library_version).toBe(LIBRARY_VERSION);
    tracker.dispose();
  });

  it("a device clock stepping back 60 s mid-run still stores the completed run", async () => {
    const skew = { ms: 0 };
    const s = setUp(skew);
    s.run.enterStep("welcome");
    await s.time.advance(5000);
    s.run.exitStep("welcome");
    s.run.enterStep("goal");
    await s.settle();
    skew.ms = 60_000;
    await s.time.advance(1000);
    s.run.exitStep("goal");
    s.run.enterStep("done");
    await s.time.advance(1000);
    s.run.complete();
    await s.settle();
    expectCompletedStored(s);
    s.tracker.dispose();
  });
});
