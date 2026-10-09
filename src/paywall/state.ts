import type { WireRunContext } from "../core/context";
import { toTimestamp } from "../core/time";
import type { PaywallPresentationSnapshot, PresentationOutcome, PresentationPaywall, PresentationTransaction } from "./contract";
import type { PaywallPresentationEnd, PaywallPresentationInfo, PaywallTransactionInfo } from "./observer";

const OUTCOMES = new Set(["purchased", "dismissed", "cancelled", "error"]);
const id = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 128;
const storeId = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 1024;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Problems that would make the snapshot fail the schema. Empty when the info is usable. */
export function validateInfo(info: unknown): string[] {
  if (!info || typeof info !== "object") return ["info is not an object"];
  const i = info as Record<string, unknown>;
  const errors: string[] = [];
  if (!id(i.moment)) errors.push("moment must be 1 to 128 characters");
  if (!id(i.paywallId)) errors.push("paywallId must be 1 to 128 characters");
  if (i.audienceId !== null && !id(i.audienceId)) errors.push("audienceId must be null or 1 to 128 characters");
  if (i.renderMode !== "elements" && i.renderMode !== "custom") errors.push("renderMode must be elements or custom");
  if (i.billing !== "store" && i.billing !== "stripe") errors.push("billing must be store or stripe");
  if (i.surface !== "present" && i.surface !== "paywall_step") errors.push("surface must be present or paywall_step");
  if (i.variantKey !== undefined && !id(i.variantKey)) errors.push("variantKey must be 1 to 128 characters");
  if (i.deploymentId !== undefined && !id(i.deploymentId)) errors.push("deploymentId must be 1 to 128 characters");
  const run = i.onboardingRun as { runId?: unknown; stepKey?: unknown } | undefined;
  if (run !== undefined && (typeof run !== "object" || run === null || typeof run.runId !== "string" || !UUID.test(run.runId) || typeof run.stepKey !== "string" || !KEY.test(run.stepKey))) {
    errors.push("onboardingRun must be { runId: lowercase UUID, stepKey: key }");
  }
  return errors;
}

export interface PresentationState {
  readonly id: string;
  seq: number;
  readonly startedAt: number;
  shownAt: number | null;
  endedAt: number | null;
  outcome: PresentationOutcome | null;
  readonly paywall: PresentationPaywall;
  readonly surface: "present" | "paywall_step";
  readonly onboardingRun?: { run_id: string; step_key: string };
  readonly context: WireRunContext;
}

export function createState(info: PaywallPresentationInfo, presentationId: string, nowMs: number, context: WireRunContext): PresentationState {
  const paywall: PresentationPaywall = {
    moment_key: info.moment,
    paywall_id: info.paywallId,
    audience_id: info.audienceId,
    render_mode: info.renderMode,
    billing: info.billing,
  };
  if (info.variantKey !== undefined) paywall.variant_key = info.variantKey;
  if (info.deploymentId !== undefined) paywall.deployment_id = info.deploymentId;
  return {
    id: presentationId,
    seq: 0,
    startedAt: nowMs,
    shownAt: null,
    endedAt: null,
    outcome: null,
    paywall,
    surface: info.surface,
    ...(info.surface === "paywall_step" && info.onboardingRun
      ? { onboardingRun: { run_id: info.onboardingRun.runId, step_key: info.onboardingRun.stepKey } }
      : {}),
    context,
  };
}

/** The latest timestamp recorded so far: the floor for the next one. */
const floor = (s: PresentationState) => Math.max(s.startedAt, s.shownAt ?? s.startedAt, s.endedAt ?? s.startedAt);

export function markShown(s: PresentationState, nowMs: number): "ok" | "already-shown" | "after-end" {
  if (s.endedAt !== null) return "after-end";
  if (s.shownAt !== null) return "already-shown";
  s.shownAt = Math.max(nowMs, floor(s));
  return "ok";
}

function toTransaction(t: PaywallTransactionInfo | undefined): PresentationTransaction | undefined {
  if (!t || typeof t !== "object") return undefined;
  const out: PresentationTransaction = {};
  if (storeId(t.originalTransactionIdentifier)) out.original_transaction_identifier = t.originalTransactionIdentifier;
  if (storeId(t.purchaseToken)) out.purchase_token = t.purchaseToken;
  if (storeId(t.productId)) out.product_id = t.productId;
  if (t.restored === true) out.restored = true;
  return Object.keys(out).length ? out : undefined;
}

export function markEnded(s: PresentationState, end: PaywallPresentationEnd, nowMs: number): "ok" | "already-ended" | "invalid-status" {
  if (s.endedAt !== null) return "already-ended";
  if (!end || !OUTCOMES.has(end.status)) return "invalid-status";
  const outcome: PresentationOutcome = { status: end.status };
  if (end.status === "error" && typeof end.reason === "string" && KEY.test(end.reason)) outcome.reason = end.reason;
  if (end.status === "purchased") {
    const t = toTransaction(end.transaction);
    if (t) outcome.transaction = t;
  }
  s.endedAt = Math.max(nowMs, floor(s));
  s.outcome = outcome;
  return "ok";
}

/** The next send: increments seq. */
export function toSnapshot(s: PresentationState, nowMs: number): PaywallPresentationSnapshot {
  s.seq += 1;
  const base = {
    schema_version: 1 as const,
    presentation_id: s.id,
    seq: s.seq,
    started_at: toTimestamp(s.startedAt),
    shown_at: s.shownAt === null ? null : toTimestamp(s.shownAt),
    sent_at: toTimestamp(Math.max(nowMs, floor(s))),
    paywall: { ...s.paywall },
    surface: s.surface,
    ...(s.onboardingRun ? { onboarding_run: { ...s.onboardingRun } } : {}),
    context: { ...s.context },
  };
  return s.endedAt !== null && s.outcome !== null
    ? { ...base, status: "ended", ended_at: toTimestamp(s.endedAt), outcome: { ...s.outcome } }
    : { ...base, status: "in_progress", ended_at: null, outcome: null };
}
