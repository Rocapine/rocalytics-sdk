import { describe, expect, it } from "vitest";
import { createState, markEnded, markShown, toSnapshot, validateInfo } from "../src/paywall/state";
import type { PaywallPresentationInfo } from "../src/paywall/observer";
import { assertPresentationConformant } from "./paywall-contract";

const T0 = Date.parse("2026-01-10T09:00:00.000Z");
const ID = "0192f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b";
const CTX = { app_version: "2.4.0", build: "412", platform: "ios", os_version: "18.1", locale: "en-US", timezone: "America/New_York", library_version: "0.1.0" } as const;
const INFO: PaywallPresentationInfo = { moment: "settings_upgrade", paywallId: "pw-1", audienceId: "aud-1", renderMode: "custom", billing: "store", surface: "present" };

describe("paywall presentation state", () => {
  it("start, shown, purchased: three conformant snapshots with increasing seq", () => {
    const s = createState(INFO, ID, T0, CTX);
    const a = toSnapshot(s, T0);
    expect(markShown(s, T0 + 350)).toBe("ok");
    const b = toSnapshot(s, T0 + 350);
    expect(markEnded(s, { status: "purchased", transaction: { originalTransactionIdentifier: "2000000123", productId: "pro_annual" } }, T0 + 41_120)).toBe("ok");
    const c = toSnapshot(s, T0 + 41_120);
    for (const p of [a, b, c]) assertPresentationConformant(p);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(c).toMatchObject({ status: "ended", outcome: { status: "purchased", transaction: { original_transaction_identifier: "2000000123", product_id: "pro_annual" } } });
    expect(a.paywall).toEqual({ moment_key: "settings_upgrade", paywall_id: "pw-1", audience_id: "aud-1", render_mode: "custom", billing: "store" });
  });

  it("purchased with no transaction is valid and carries no transaction key", () => {
    const s = createState(INFO, ID, T0, CTX);
    markShown(s, T0 + 1);
    markEnded(s, { status: "purchased" }, T0 + 2);
    const p = toSnapshot(s, T0 + 2);
    assertPresentationConformant(p);
    expect(p.outcome).toEqual({ status: "purchased" });
  });

  it("drops empty transaction fields, a reason on a non-error, and a transaction on a non-purchase", () => {
    const s = createState(INFO, ID, T0, CTX);
    markShown(s, T0 + 1);
    markEnded(s, { status: "dismissed", reason: "x", transaction: { productId: "p" } }, T0 + 2);
    expect(toSnapshot(s, T0 + 2).outcome).toEqual({ status: "dismissed" });
    const t = createState(INFO, ID, T0, CTX);
    markShown(t, T0 + 1);
    markEnded(t, { status: "purchased", transaction: { originalTransactionIdentifier: "", purchaseToken: "tok" } }, T0 + 2);
    expect(toSnapshot(t, T0 + 2).outcome).toEqual({ status: "purchased", transaction: { purchase_token: "tok" } });
  });

  it("carries restored: true, and drops restored when it is not the boolean true", () => {
    const s = createState(INFO, ID, T0, CTX);
    markShown(s, T0 + 1);
    markEnded(s, { status: "purchased", transaction: { restored: true } }, T0 + 2);
    const p = toSnapshot(s, T0 + 2);
    assertPresentationConformant(p);
    expect(p.outcome).toEqual({ status: "purchased", transaction: { restored: true } });
    const t = createState(INFO, ID, T0, CTX);
    markShown(t, T0 + 1);
    markEnded(t, { status: "purchased", transaction: { restored: "yes" as unknown as boolean, productId: "p" } }, T0 + 2);
    expect(toSnapshot(t, T0 + 2).outcome).toEqual({ status: "purchased", transaction: { product_id: "p" } });
    const u = createState(INFO, ID, T0, CTX);
    markShown(u, T0 + 1);
    markEnded(u, { status: "purchased", transaction: { restored: false } }, T0 + 2);
    expect(toSnapshot(u, T0 + 2).outcome).toEqual({ status: "purchased" });
  });

  it("a purchase without shown() implies it was shown: conformant, shown_at = ended_at", () => {
    const s = createState(INFO, ID, T0, CTX);
    markEnded(s, { status: "purchased", transaction: { productId: "p" } }, T0 + 500);
    const p = toSnapshot(s, T0 + 500);
    assertPresentationConformant(p);
    expect(p.shown_at).toBe(p.ended_at);
  });

  it("error before shown is a valid ended snapshot with its reason", () => {
    const s = createState(INFO, ID, T0, CTX);
    markEnded(s, { status: "error", reason: "unknown-custom-screen" }, T0 + 10);
    const p = toSnapshot(s, T0 + 10);
    assertPresentationConformant(p);
    expect(p).toMatchObject({ shown_at: null, outcome: { status: "error", reason: "unknown-custom-screen" } });
  });

  it("first end wins; shown after end and a second shown are refused", () => {
    const s = createState(INFO, ID, T0, CTX);
    expect(markShown(s, T0 + 1)).toBe("ok");
    expect(markShown(s, T0 + 2)).toBe("already-shown");
    expect(markEnded(s, { status: "dismissed" }, T0 + 3)).toBe("ok");
    expect(markEnded(s, { status: "purchased" }, T0 + 4)).toBe("already-ended");
    expect(markShown(s, T0 + 5)).toBe("after-end");
    expect(toSnapshot(s, T0 + 5).outcome).toEqual({ status: "dismissed" });
  });

  it("refuses an unknown outcome status", () => {
    const s = createState(INFO, ID, T0, CTX);
    expect(markEnded(s, { status: "refunded" } as never, T0 + 1)).toBe("invalid-status");
    expect(toSnapshot(s, T0 + 1).status).toBe("in_progress");
  });

  it("clamps a clock that steps back: shown_at >= started_at, ended_at >= shown_at, sent_at >= started_at", () => {
    const s = createState(INFO, ID, T0, CTX);
    markShown(s, T0 - 5_000);
    markEnded(s, { status: "dismissed" }, T0 - 9_000);
    const p = toSnapshot(s, T0 - 10_000);
    assertPresentationConformant(p);
    expect(p.shown_at).toBe(p.started_at);
    expect(p.ended_at).toBe(p.started_at);
    expect(p.sent_at).toBe(p.started_at);
  });

  it("paywall_step carries onboarding_run; present never does", () => {
    const s = createState({ ...INFO, surface: "paywall_step", onboardingRun: { runId: "0192f1a2-0000-7000-8000-000000000001", stepKey: "paywall" } }, ID, T0, CTX);
    expect(toSnapshot(s, T0).onboarding_run).toEqual({ run_id: "0192f1a2-0000-7000-8000-000000000001", step_key: "paywall" });
    const t = createState({ ...INFO, onboardingRun: { runId: "0192f1a2-0000-7000-8000-000000000001", stepKey: "paywall" } }, ID, T0, CTX);
    expect(toSnapshot(t, T0).onboarding_run).toBeUndefined();
  });

  it("validateInfo lists every problem and accepts a good info", () => {
    expect(validateInfo(INFO)).toEqual([]);
    expect(validateInfo({ ...INFO, paywallId: "", surface: "modal", renderMode: "x", audienceId: 3 })).toEqual([
      "paywallId must be 1 to 128 characters",
      "audienceId must be null or 1 to 128 characters",
      "renderMode must be elements or custom",
      "surface must be present or paywall_step",
    ]);
    expect(validateInfo(null)).toEqual(["info is not an object"]);
  });
});
