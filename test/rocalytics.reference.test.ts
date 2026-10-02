import { afterEach, describe, expect, it, vi } from "vitest";
import { RocalyticsClient } from "../src/rocalytics";
import fixture from "./fixtures/rocalytics-reference.json";
import { FakeSecureStore, fakeModules, recordingFetch, stubIntl, type FakeDevice } from "./rocalytics.fakes";

// Every request below was produced by the REFERENCE client, run by
// scripts/capture-rocalytics-fixtures.mjs under fake Expo modules. Replaying
// the same calls against the packaged client must send the same requests:
// same URL, method, headers and JSON body.
//
// Two scenarios come from the app copies that have a behaviour the reference
// lacks (getDemandScore, trackCustomEvent's dedupSuffix). Only the request to
// that endpoint is compared there, because those copies omit `locale` from
// the init identify and the package does not.

type Step = { call: string; now: string; args?: unknown[] };
type Scenario = (typeof fixture.scenarios)[number] & { only?: string[]; respond?: Record<string, { status: number; json?: unknown }> };

let restoreIntl: (() => void) | null = null;
afterEach(() => {
  restoreIntl?.();
  restoreIntl = null;
});

describe("the packaged client sends what the reference client sends", () => {
  it("covers every endpoint the package keeps", () => {
    const paths = new Set(fixture.scenarios.flatMap((s) => s.requests.map((r) => new URL(r.url).pathname)));
    expect([...paths].sort()).toEqual([
      "/functions/v1/demand-score",
      "/functions/v1/identify",
      "/functions/v1/onboarding-response",
      "/functions/v1/track",
    ]);
  });

  it.each(fixture.scenarios.map((s) => [s.name, s] as [string, Scenario]))("%s", async (_name, scenario) => {
    const device = scenario.device as FakeDevice;
    restoreIntl = stubIntl(device);
    let now = Date.parse(scenario.steps[0].now);
    const store = new FakeSecureStore(scenario.store as Record<string, string>);
    const http = recordingFetch(scenario.respond);
    const console_ = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const client = new RocalyticsClient({
      modules: fakeModules(device, store),
      fetch: http.fetch,
      clock: { now: () => now },
      onDiagnostic: () => {},
    });

    const returned: unknown[] = [];
    for (const step of scenario.steps as Step[]) {
      now = Date.parse(step.now);
      try {
        const value =
          step.call === "ready"
            ? await client.ready
            : await (client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[step.call](...(step.args ?? []));
        returned.push(value === undefined ? null : { value });
      } catch (error) {
        returned.push({ error: (error as Error).message });
      }
    }
    await client.ready;

    const sent = http.requests.filter((r) => !scenario.only || scenario.only.includes(new URL(r.url).pathname));
    expect(sent).toEqual(scenario.requests);
    expect(returned).toEqual(scenario.returned);
    // Nothing is logged, purchase properties included.
    for (const spy of console_) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
