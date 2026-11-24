import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventBatch } from "../src/analytics";
import { RocalyticsClient, type RocalyticsClientOptions, type RocalyticsModules } from "../src/client";
import { ATTEST_TOKEN_KEY } from "../src/core";
import type { OnboardingRunSnapshot } from "../src/onboarding";
import type { PaywallPresentationSnapshot } from "../src/paywall";
import { ManualTime, flushMicrotasks } from "./fakes";
import {
  FakeSecureStore,
  IOS,
  ROCA_ID,
  attestApi,
  attestJwt,
  attestJwtRocaId,
  fakeAttestModule,
  fakeModules,
  recordingFetch,
  stubIntl,
  type CapturedRequest,
} from "./client.fakes";

// The client sends the attest token to rocalytics-api as `Authorization: Bearer <jwt>`,
// only when the token is bound to the request's X-Application-ID, X-Platform and X-Roca-ID:
// the API answers 403 token_mismatch to any other.

// Task 5 passes `(batch) => client.attestHeaders(batch)` to analytics: an EventBatch must fit.
const _batchFits: Parameters<RocalyticsClient["attestHeaders"]>[0] = {} as EventBatch;
void _batchFits;

const NEW_ROCA_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const API = "/functions/v1/";
const isAttest = (r: CapturedRequest) => new URL(r.url).pathname.startsWith(`${API}attest`);
const auth = (r: CapturedRequest) => r.headers.Authorization;

/** Every request that carries a token carries one bound to its own roca id (the API's token_mismatch check). */
function expectEveryTokenMatches(requests: CapturedRequest[]) {
  for (const r of requests) {
    const a = auth(r);
    if (a === undefined) continue;
    expect(a).toMatch(/^Bearer /);
    expect(attestJwtRocaId(a.slice("Bearer ".length))).toBe(r.headers["X-Roca-ID"]);
    expect(r.headers["X-Application-ID"]).toBe(IOS.applicationId);
    expect(r.headers["X-Platform"]).toBe(IOS.platform);
  }
}

const RUN: OnboardingRunSnapshot = {
  schema_version: 1,
  run_id: "0190a8c4-4b2e-7c1a-9f3d-2e5b6c7d8e9f",
  seq: 1,
  status: "completed",
  started_at: "2026-01-10T08:00:00.000Z",
  sent_at: "2026-01-10T08:00:10.000Z",
  completed_at: "2026-01-10T08:00:10.000Z",
  onboarding: { key: "main", version: "3", variant_key: null },
  studio: null,
  context: { app_version: "2.4.0", build: "412", platform: "ios", os_version: "18.1", locale: "en-US", timezone: "Europe/Paris", library_version: "0.1.0" },
  manifest: { steps: [{ step_key: "welcome" }] },
  properties: {},
  steps: [{ step_key: "welcome", entered_at: "2026-01-10T08:00:00.000Z", exited_at: "2026-01-10T08:00:10.000Z", answers: [] }],
} as unknown as OnboardingRunSnapshot;
const PRESENTATION = { presentation_id: "p1" } as unknown as PaywallPresentationSnapshot;

let restoreIntl: () => void;
let store: FakeSecureStore;
beforeEach(() => {
  restoreIntl = stubIntl(IOS);
  store = new FakeSecureStore();
});
afterEach(() => restoreIntl());

function setup(
  o: {
    attest?: ReturnType<typeof fakeAttestModule>["module"] | null;
    api?: Parameters<typeof attestApi>[0];
    modules?: (m: RocalyticsModules) => RocalyticsModules;
    options?: Partial<RocalyticsClientOptions> & { timers?: unknown };
  } = {},
) {
  const attest = o.attest === undefined ? fakeAttestModule().module : o.attest;
  const http = recordingFetch({}, attestApi(o.api));
  const base = { ...fakeModules(IOS, store), ...(attest ? { attest } : {}) };
  const client = new RocalyticsClient({
    modules: o.modules ? o.modules(base) : base,
    fetch: http.fetch,
    onDiagnostic: () => {},
    ...o.options,
  } as RocalyticsClientOptions);
  return { client, http, api: () => http.requests.filter((r) => !isAttest(r)), attestCalls: () => http.requests.filter(isAttest) };
}

describe("RocalyticsClient attestation", () => {
  it("no attest module: test/client.reference.test.ts still matches test/fixtures/client-reference.json byte for byte", async () => {
    // That suite runs unchanged; here, the same client without RocaAttest sends no /attest request and no header.
    const { client, http } = setup({ attest: null });
    await client.ready;
    await client.track("purchase");
    expect(http.requests.filter(isAttest)).toEqual([]);
    expect(http.requests.every((r) => auth(r) === undefined)).toBe(true);
  });

  it("with a token: identify, track, demand-score, the onboarding and the paywall requests carry Authorization: Bearer <jwt>", async () => {
    const { client, api, attestCalls } = setup();
    await client.ready;
    await client.track("purchase");
    await client.trackCustomEvent("x");
    await client.identify({ email: "a@b.c" });
    await client.trackOnboarding("welcome");
    await client.getDemandScore().catch(() => undefined);
    expect(await client.sendOnboardingRun(RUN)).toEqual({ outcome: "accepted" });
    await client.sendPaywallPresentation(PRESENTATION);
    const paths = api().map((r) => new URL(r.url).pathname);
    for (const p of ["identify", "track", "onboarding-response", "demand-score", "paywall-presentations"]) expect(paths).toContain(`${API}${p}`);
    const bearer = `Bearer ${attestJwt(ROCA_ID, 1)}`;
    for (const r of api().filter((r) => !r.url.endsWith("/install"))) expect(auth(r)).toBe(bearer);
    // One challenge, one proof, one POST for all of them.
    expect(attestCalls().map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([`GET ${API}attest/challenge`, `POST ${API}attest`]);
    expect(attestCalls()[0]!.url).toBe(`https://rocalytics-api.rocapine.io${API}attest/challenge?app_id=com.example.app&platform=ios`);
    expect(attestCalls()[1]!.body).toMatchObject({ kind: "ios_attestation", app_id: "com.example.app", roca_id: ROCA_ID, app_version: "2.4.0" });
    expectEveryTokenMatches(api());
  });

  it("the attestation request goes to baseUrl", async () => {
    const { client, attestCalls } = setup({ options: { baseUrl: "https://api.test" } });
    await client.ready;
    expect(attestCalls()[0]!.url).toBe(`https://api.test${API}attest/challenge?app_id=com.example.app&platform=ios`);
    expect(attestCalls()[1]!.url).toBe(`https://api.test${API}attest`);
  });

  it("the attribution /install ping never carries it", async () => {
    const { client, api } = setup({ options: { installPing: true } });
    await client.ready;
    const ping = api().filter((r) => r.url === "https://track.rocapi.ne/install");
    expect(ping).toHaveLength(1);
    expect(auth(ping[0]!)).toBeUndefined();
    expect(api().filter((r) => r.url.endsWith(`${API}track`)).every((r) => auth(r) !== undefined)).toBe(true);
  });

  it("getToken null (module present, attestation failing) → requests go out without the header, at most waitMs late", async () => {
    const time = new ManualTime();
    const never = new Promise<never>(() => {});
    const { client, api } = setup({
      api: { challenge: () => never },
      options: { clock: time.clock, timers: time.timers, attest: { waitMs: 500 }, installPing: false },
    });
    await time.advance(499);
    expect(api()).toEqual([]);
    await time.advance(1);
    expect(api().map((r) => new URL(r.url).pathname)).toEqual([`${API}identify`]);
    await time.advance(500); // the install track waits for the same pending attestation, at most waitMs too
    await client.ready;
    expect(api().map((r) => new URL(r.url).pathname)).toEqual([`${API}identify`, `${API}track`]);
    expect(api().every((r) => auth(r) === undefined)).toBe(true);
  });

  it("attestation rejected (401) → one POST /attest, every request without the header, no wait", async () => {
    const { client, api, attestCalls } = setup({ api: { post: () => ({ status: 401, json: { error: "attestation_failed", reason: "x" } }) } });
    await client.ready;
    await client.track("purchase");
    expect(attestCalls()).toHaveLength(2);
    expect(api().length).toBeGreaterThan(2);
    expect(api().every((r) => auth(r) === undefined)).toBe(true);
    expect(await client.attestHeaders()).toEqual({});
  });

  it("attest.disabled → no /attest request, no header", async () => {
    const { client, http } = setup({ options: { attest: { disabled: true } } });
    await client.ready;
    await client.track("purchase");
    expect(http.requests.filter(isAttest)).toEqual([]);
    expect(http.requests.every((r) => auth(r) === undefined)).toBe(true);
    expect(await client.attestHeaders()).toEqual({});
  });

  it("applicationId null → no manager, no header", async () => {
    const { client, http } = setup({ modules: (m) => ({ ...m, application: { ...m.application, applicationId: null } }) });
    await client.ready;
    await client.track("purchase");
    expect(http.requests.filter(isAttest)).toEqual([]);
    expect(http.requests.every((r) => auth(r) === undefined)).toBe(true);
  });

  it("platform web (fake modules with OS 'web') → no manager", async () => {
    const { client, http } = setup({ modules: (m) => ({ ...m, platform: { OS: "web", Version: "1" } }) });
    await client.ready;
    await client.track("purchase");
    expect(http.requests.filter(isAttest)).toEqual([]);
    expect(http.requests.every((r) => auth(r) === undefined)).toBe(true);
  });

  it("Android without cloudProjectNumber → no token; with it → prepare(number) and a token", async () => {
    const android = (m: RocalyticsModules): RocalyticsModules => ({ ...m, platform: { OS: "android", Version: 34 } });
    const without = setup({ modules: android });
    await without.client.ready;
    expect(without.attestCalls()).toEqual([]);
    expect(without.api().every((r) => auth(r) === undefined)).toBe(true);

    store = new FakeSecureStore();
    const attest = fakeAttestModule();
    const withNumber = setup({ attest: attest.module, modules: android, options: { attest: { cloudProjectNumber: "123456" } } });
    await withNumber.client.ready;
    expect(attest.calls).toContain("prepare:123456");
    expect(withNumber.attestCalls()[1]!.body).toMatchObject({ kind: "android_integrity", integrity_token: "INT" });
    expect(withNumber.api().filter((r) => r.url.endsWith(`${API}identify`)).map(auth)).toEqual([`Bearer ${attestJwt(ROCA_ID, 1)}`]);
  });

  it("adoptRocaId → the next track carries no header or a token for the new roca id, never the old one", async () => {
    const { client, api, attestCalls } = setup();
    await client.ready;
    await client.track("purchase");
    await client.adoptRocaId(NEW_ROCA_ID);
    await client.track("trial_started");
    const after = api().filter((r) => r.headers["X-Roca-ID"] === NEW_ROCA_ID);
    expect(after.length).toBeGreaterThanOrEqual(2); // the adopt's identify, the track
    for (const r of after) expect(auth(r)).not.toBe(`Bearer ${attestJwt(ROCA_ID, 1)}`);
    expect(auth(after[after.length - 1]!)).toBe(`Bearer ${attestJwt(NEW_ROCA_ID, 2)}`);
    expect(attestCalls().filter((r) => r.method === "POST").map((r) => (r.body as { roca_id: string }).roca_id)).toEqual([ROCA_ID, NEW_ROCA_ID]);
    expectEveryTokenMatches(api());
  });

  it("adoptRocaId while requests are waiting for a token: none carries a token for another roca id", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let posts = 0;
    const { client, api } = setup({
      api: {
        post: async (body) => {
          if (++posts === 2) await gate;
          return { status: 200, json: { token: attestJwt(body.roca_id as string, posts), expires_at: 1 } };
        },
      },
    });
    await client.ready;
    client.rocaId = NEW_ROCA_ID; // the token cached for ROCA_ID no longer fits; a flight for NEW_ROCA_ID starts and waits
    const pending = client.track("purchase");
    await flushMicrotasks();
    const adopt = client.adoptRocaId(ROCA_ID); // back to the cached id while the NEW_ROCA_ID flight is in the air
    release();
    await Promise.all([pending, adopt, client.track("trial_started")]);
    expectEveryTokenMatches(api());
  });

  it("attestHeaders(): {} before a token, the header after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client } = setup({
      api: { post: async (body) => (await gate, { status: 200, json: { token: attestJwt(body.roca_id as string, 1), expires_at: 1 } }) },
      options: { attest: { waitMs: 20 } },
    });
    await client.ready;
    expect(await client.attestHeaders()).toEqual({});
    release();
    await vi.waitFor(async () => expect(await client.attestHeaders()).toEqual({ Authorization: `Bearer ${attestJwt(ROCA_ID, 1)}` }));
  });

  describe("attestHeaders(batch)", () => {
    const event = (roca_id: string | null) => ({ roca_id });
    const batch = (o: Partial<EventBatch> = {}): EventBatch =>
      ({ app_id: "com.example.app", platform: "ios", sent_at: 0, sdk: "x", events: [], ...o }) as EventBatch;
    const header = { Authorization: `Bearer ${attestJwt(ROCA_ID, 1)}` };

    it("with an event of another roca_id → {}", async () => {
      const { client } = setup();
      await client.ready;
      expect(await client.attestHeaders(batch({ events: [event(ROCA_ID), event(NEW_ROCA_ID)] as EventBatch["events"] }))).toEqual({});
    });

    it("with events whose roca_id is null and the client's → the header", async () => {
      const { client } = setup();
      await client.ready;
      expect(await client.attestHeaders(batch({ events: [event(null), event(ROCA_ID)] as EventBatch["events"] }))).toEqual(header);
      expect(await client.attestHeaders(batch())).toEqual(header);
    });

    it("for another app_id or platform → {}", async () => {
      const { client } = setup();
      await client.ready;
      expect(await client.attestHeaders(batch({ app_id: "com.other" }))).toEqual({});
      expect(await client.attestHeaders(batch({ platform: "android" }))).toEqual({});
      expect(await client.attestHeaders({ events: [] })).toEqual({}); // no app_id or platform to match
    });

    it("an inert client → {}, never throws", async () => {
      const client = new RocalyticsClient({ modules: null, onDiagnostic: () => {} });
      expect(await client.attestHeaders(batch())).toEqual({});
    });
  });

  it("the token cache lives in the secure store under rocalytics.attest.token.v1", async () => {
    expect(ATTEST_TOKEN_KEY).toBe("rocalytics.attest.token.v1");
    const { client } = setup();
    await client.ready;
    await flushMicrotasks();
    expect(JSON.parse(store.map.get("rocalytics.attest.token.v1")!)).toMatchObject({
      v: 1,
      token: attestJwt(ROCA_ID, 1),
      app_id: "com.example.app",
      platform: "ios",
      roca_id: ROCA_ID,
    });
    // A second launch reuses it: no new attestation.
    const relaunch = setup();
    await relaunch.client.ready;
    await relaunch.client.track("purchase");
    expect(relaunch.attestCalls()).toEqual([]);
    expect(relaunch.api().filter((r) => r.url.endsWith(`${API}track`)).map(auth)).toEqual([`Bearer ${attestJwt(ROCA_ID, 1)}`]);
  });
});
