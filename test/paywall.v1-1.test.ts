// Contract v1.1: presentations of paywalls the Studio does not serve (provider
// "external" or "native"), and the guarantee that a v1-shaped call still sends
// exactly the v1 bytes.
import { describe, expect, it } from "vitest";
import { createPaywallTracker, type PaywallPresentationInfo, type PaywallPresentationSnapshot } from "../src/paywall";
import { LIBRARY_VERSION } from "../src/version";
import { ManualTime, MemorySink } from "./fakes";
import { CONTEXT } from "./harness";
import { assertPresentationConformant } from "./paywall-contract";

const RUN_ID = "0192f1a2-0000-7000-8000-000000000001";
const CONTEXT_WIRE = {
  app_version: "2.4.0", build: "412", platform: "ios", os_version: "18.1",
  locale: "en-US", timezone: "America/New_York", library_version: LIBRARY_VERSION,
};

const EXTERNAL: PaywallPresentationInfo = {
  provider: "external", providerName: "example-service", surface: "placement", renderMode: "external",
  billing: "store", placement: "settings_upgrade", externalPaywallId: "annual_offer_v2", variantKey: "variant-3",
};
const NATIVE: PaywallPresentationInfo = {
  provider: "native", surface: "paywall_step", renderMode: "custom", billing: "store",
  externalPaywallId: "trial_toggle", onboardingRun: { runId: RUN_ID, stepKey: "paywall" },
};

function setup() {
  const time = new ManualTime();
  const sink = new MemorySink<PaywallPresentationSnapshot>();
  const diagnostics: { code: string; message: string }[] = [];
  const tracker = createPaywallTracker({
    sink, context: CONTEXT, clock: time.clock, timers: time.timers,
    onDiagnostic: (d) => diagnostics.push({ code: d.code, message: d.message }),
  });
  return { time, sink, diagnostics, tracker };
}

async function runOnce(info: PaywallPresentationInfo) {
  const env = setup();
  const h = env.tracker.start(info);
  expect(h, JSON.stringify(env.diagnostics)).toBeDefined();
  h!.shown();
  await env.time.advance(1_000);
  h!.end({ status: "purchased", transaction: { originalTransactionIdentifier: "2000000123", productId: "pro_annual" } });
  await env.time.advance(0);
  expect(env.sink.received).toHaveLength(3);
  for (const s of env.sink.received) assertPresentationConformant(s);
  return env.sink.received;
}

describe("contract v1.1: a v1-shaped call is unchanged", () => {
  it("sends exactly the v1 bytes, key order included, with no provider key", async () => {
    const received = await runOnce({
      moment: "settings_upgrade", paywallId: "pw-1", audienceId: "aud-1", renderMode: "elements", billing: "stripe",
      surface: "paywall_step", variantKey: "v2", deploymentId: "dep-7", onboardingRun: { runId: RUN_ID, stepKey: "paywall" },
    });
    const paywall = {
      moment_key: "settings_upgrade", paywall_id: "pw-1", audience_id: "aud-1", render_mode: "elements", billing: "stripe",
      variant_key: "v2", deployment_id: "dep-7",
    };
    for (const s of received) {
      const expected = {
        schema_version: 1, presentation_id: s.presentation_id, seq: s.seq, started_at: s.started_at, shown_at: s.shown_at,
        sent_at: s.sent_at, paywall, surface: "paywall_step", onboarding_run: { run_id: RUN_ID, step_key: "paywall" },
        context: CONTEXT_WIRE,
        ...(s.status === "ended"
          ? { status: "ended", ended_at: s.ended_at, outcome: { status: "purchased", transaction: { original_transaction_identifier: "2000000123", product_id: "pro_annual" } } }
          : { status: "in_progress", ended_at: null, outcome: null }),
      };
      expect(JSON.stringify(s)).toBe(JSON.stringify(expected));
      expect(s).toStrictEqual(expected);
      expect("provider" in s).toBe(false);
    }
  });

  it("the minimal v1 call (null audience, no optional field) has no v1.1 key", async () => {
    const [s] = await runOnce({ moment: "m", paywallId: "p", audienceId: null, renderMode: "custom", billing: "store", surface: "present" });
    expect(JSON.stringify(s.paywall)).toBe('{"moment_key":"m","paywall_id":"p","audience_id":null,"render_mode":"custom","billing":"store"}');
    expect(Object.keys(s)).not.toContain("provider");
  });
});

describe("contract v1.1: external and native presentations", () => {
  it("external: carries provider, placement, external id and provider name, and no Studio ids", async () => {
    const received = await runOnce(EXTERNAL);
    for (const s of received) {
      expect(s.provider).toBe("external");
      expect(s.surface).toBe("placement");
      expect(JSON.stringify(s.paywall)).toBe(JSON.stringify({
        audience_id: null, render_mode: "external", billing: "store", variant_key: "variant-3",
        placement: "settings_upgrade", external_paywall_id: "annual_offer_v2", provider_name: "example-service",
      }));
    }
  });

  it("native: carries provider and external id, and the onboarding run on a paywall_step", async () => {
    const [s] = await runOnce(NATIVE);
    expect(s.provider).toBe("native");
    expect(s.onboarding_run).toEqual({ run_id: RUN_ID, step_key: "paywall" });
    expect(JSON.stringify(s.paywall)).toBe('{"audience_id":null,"render_mode":"custom","billing":"store","external_paywall_id":"trial_toggle"}');
  });

  it("provider sits after surface, and an explicit studio is passed through", async () => {
    const [s] = await runOnce({ provider: "studio", moment: "m", paywallId: "p", audienceId: null, renderMode: "custom", billing: "store", surface: "present" });
    expect(s.provider).toBe("studio");
    const keys = Object.keys(s);
    expect(keys.indexOf("provider")).toBe(keys.indexOf("surface") + 1);
  });

  it("Studio ids are kept when a non-Studio presentation carries them", async () => {
    const [s] = await runOnce({ ...EXTERNAL, moment: "onboarding_end", paywallId: "pw-9", audienceId: "aud-2" });
    expect(s.paywall).toMatchObject({ moment_key: "onboarding_end", paywall_id: "pw-9", audience_id: "aud-2", external_paywall_id: "annual_offer_v2" });
  });

  it.each([
    ["studio without moment", { moment: undefined, paywallId: "p", audienceId: null, renderMode: "custom", billing: "store", surface: "present" }, "moment"],
    ["studio without paywallId", { provider: "studio", moment: "m", audienceId: null, renderMode: "custom", billing: "store", surface: "present" }, "paywallId"],
    ["external without placement", { ...EXTERNAL, placement: undefined }, "placement"],
    ["external without externalPaywallId", { ...EXTERNAL, externalPaywallId: undefined }, "externalPaywallId"],
    ["native without externalPaywallId", { ...NATIVE, externalPaywallId: undefined }, "externalPaywallId"],
    ["an unknown provider", { ...EXTERNAL, provider: "vendor" }, "provider"],
    ["a provider name over 32 characters", { ...EXTERNAL, providerName: "x".repeat(33) }, "providerName"],
    ["an empty placement", { ...EXTERNAL, placement: "" }, "placement"],
    ["an external id over 128 characters", { ...NATIVE, externalPaywallId: "x".repeat(129) }, "externalPaywallId"],
  ])("rejects %s with invalid-info, sending nothing", async (_name, info, field) => {
    const { time, sink, diagnostics, tracker } = setup();
    expect(tracker.start(info as never)).toBeUndefined();
    await time.advance(0);
    expect(sink.received).toHaveLength(0);
    expect(diagnostics.map((d) => d.code)).toEqual(["invalid-info"]);
    expect(diagnostics[0].message).toContain(field);
  });
});

// The ingest caps ids in UTF-8 bytes (128, and 32 for provider_name) and rejects
// NUL and lone surrogates (contract section 5). A rejection is permanent and loses
// the whole presentation, purchase included, so start() must refuse these first.
describe("contract v1.1: start() refuses what the ingest would reject", () => {
  const STUDIO = { moment: "m", paywallId: "p", audienceId: null, renderMode: "custom", billing: "store", surface: "present" } as const;
  it.each([
    ["a provider name over 32 bytes", { ...EXTERNAL, providerName: "日本".repeat(6) }, "providerName"],
    ["a placement over 128 bytes", { ...EXTERNAL, placement: "日".repeat(50) }, "placement"],
    ["an external id over 128 bytes", { ...NATIVE, externalPaywallId: "é".repeat(100) }, "externalPaywallId"],
    ["a placement with a lone surrogate", { ...EXTERNAL, placement: "abc\uD800" }, "placement"],
    ["an external id with a NUL", { ...NATIVE, externalPaywallId: "a\u0000b" }, "externalPaywallId"],
    ["a v1 moment over 128 bytes", { ...STUDIO, moment: "日".repeat(50) }, "moment"],
    ["a v1 moment with a lone surrogate", { ...STUDIO, moment: "a\uD800" }, "moment"],
    ["a v1 paywallId with a lone low surrogate", { ...STUDIO, paywallId: "\uDC00a" }, "paywallId"],
    ["a v1 audienceId over 128 bytes", { ...STUDIO, audienceId: "é".repeat(65) }, "audienceId"],
    ["a v1 variantKey with a NUL", { ...STUDIO, variantKey: "\u0000" }, "variantKey"],
    ["a v1 deploymentId over 128 bytes", { ...STUDIO, deploymentId: "x".repeat(129) }, "deploymentId"],
  ])("refuses %s with invalid-info, sending nothing", async (_name, info, field) => {
    const { time, sink, diagnostics, tracker } = setup();
    expect(tracker.start(info as never)).toBeUndefined();
    await time.advance(0);
    expect(sink.received).toHaveLength(0);
    expect(diagnostics.map((d) => d.code)).toEqual(["invalid-info"]);
    expect(diagnostics[0].message).toContain(field);
  });

  it("accepts a 128-byte ASCII id and a 126-byte CJK id", async () => {
    const [s] = await runOnce({ ...EXTERNAL, placement: "a".repeat(128), externalPaywallId: "日".repeat(42), providerName: "日本".repeat(5) + "ab" });
    expect(s.paywall).toMatchObject({ placement: "a".repeat(128), external_paywall_id: "日".repeat(42) });
    const [v1] = await runOnce({ ...STUDIO, moment: "日".repeat(42), paywallId: "a".repeat(128) });
    expect(v1.paywall).toMatchObject({ moment_key: "日".repeat(42), paywall_id: "a".repeat(128) });
  });

  it("accepts a valid surrogate pair (4 bytes)", async () => {
    const [s] = await runOnce({ ...NATIVE, externalPaywallId: "😀".repeat(32) });
    expect(s.paywall.external_paywall_id).toBe("😀".repeat(32));
  });

  it("drops a store id the ingest would reject instead of losing the purchase", async () => {
    const env = setup();
    const h = env.tracker.start(NATIVE)!;
    h.end({ status: "purchased", transaction: { originalTransactionIdentifier: "a\uD800", productId: "é".repeat(513), purchaseToken: "ok" } });
    await env.time.advance(0);
    const last = env.sink.received.at(-1)!;
    expect(last.outcome).toEqual({ status: "purchased", transaction: { purchase_token: "ok" } });
  });
});
