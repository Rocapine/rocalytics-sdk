import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaywallTracker, type PaywallPresentationSnapshot } from "../src/paywall";
import { RocalyticsClient, createRocalyticsPaywallSink, paywallIngestOutcome } from "../src/client";
import { ManualTime } from "./fakes";
import { CONTEXT } from "./harness";
import { assertPresentationConformant } from "./paywall-contract";
import { FakeSecureStore, IOS, ROCA_ID, fakeModules, recordingFetch, stubIntl } from "./client.fakes";

let restoreIntl: () => void;
beforeEach(() => { restoreIntl = stubIntl(IOS); });
afterEach(() => restoreIntl());

const INFO = { moment: "settings_upgrade", paywallId: "pw-1", audienceId: null, renderMode: "custom", billing: "store", surface: "present" } as const;
const PATH = "/functions/v1/paywall-presentations";

describe("Rocalytics paywall sink", () => {
  it("posts each bare snapshot to /paywall-presentations, identity in headers only (I3)", async () => {
    const rec = recordingFetch({ [PATH]: { status: 200, json: { outcome: "accepted" } } });
    const client = new RocalyticsClient({ modules: fakeModules(IOS, new FakeSecureStore()), fetch: rec.fetch });
    await client.ready;
    const time = new ManualTime();
    const tracker = createPaywallTracker({ sink: createRocalyticsPaywallSink(client), context: CONTEXT, clock: time.clock, timers: time.timers });
    const h = tracker.start(INFO)!;
    await time.advance(0); // let each send settle: a queued snapshot is superseded by the next (D12)
    h.shown();
    await time.advance(0);
    h.end({ status: "purchased", transaction: { originalTransactionIdentifier: "2000000123" } });
    await time.advance(1_000);
    const posts = rec.requests.filter((r) => new URL(r.url).pathname === PATH);
    expect(posts).toHaveLength(3);
    for (const p of posts) {
      expect(p.headers["X-Roca-ID"]).toBe(ROCA_ID);
      expect(p.headers["X-Application-ID"]).toBeTruthy();
      expect(p.headers["X-Platform"]).toBe("ios");
      const body = p.body as PaywallPresentationSnapshot & Record<string, unknown>;
      expect(body).not.toHaveProperty("roca_id");
      expect(body).not.toHaveProperty("application_id");
      expect(body).not.toHaveProperty("snapshot");
      assertPresentationConformant(body);
    }
  });

  it("maps answers per D27: a body outcome wins, anything else is transient", () => {
    expect(paywallIngestOutcome(200, { outcome: "accepted" })).toEqual({ outcome: "accepted" });
    expect(paywallIngestOutcome(200, { outcome: "ignored" })).toEqual({ outcome: "ignored" });
    expect(paywallIngestOutcome(400, { outcome: "rejected", reason: "schema" })).toEqual({ outcome: "rejected", reason: "schema" });
    expect(paywallIngestOutcome(200, undefined).outcome).toBe("transient");
    expect(paywallIngestOutcome(204).outcome).toBe("transient");
    expect(paywallIngestOutcome(500, { outcome: "accepted" }).outcome).toBe("transient");
  });

  it("is transient while the client is inert, and never throws on a fetch error", async () => {
    const inert = new RocalyticsClient({ modules: null });
    await inert.ready;
    const snapshot = { presentation_id: "x" } as unknown as PaywallPresentationSnapshot;
    expect((await inert.sendPaywallPresentation(snapshot)).outcome).toBe("transient");
    const boom = new RocalyticsClient({ modules: fakeModules(IOS, new FakeSecureStore()), fetch: async () => { throw new Error("offline"); } });
    await boom.ready;
    expect((await boom.sendPaywallPresentation(snapshot)).outcome).toBe("transient");
  });

  it("destination names the endpoint and is marked for a custom fetch", () => {
    const c = new RocalyticsClient({ modules: null, fetch: recordingFetch().fetch });
    expect(createRocalyticsPaywallSink(c).destination).toBe("https://rocalytics-api.rocapine.io/functions/v1/paywall-presentations (custom fetch)");
  });
});
