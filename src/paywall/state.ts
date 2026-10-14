import type { WireRunContext } from "../core/context";
import { toTimestamp } from "../core/time";
import type { PaywallPresentationSnapshot, PresentationOutcome, PresentationPaywall, PresentationProvider, PresentationSurface, PresentationTransaction } from "./contract";
import type { PaywallPresentationEnd, PaywallPresentationInfo, PaywallTransactionInfo } from "./observer";

const OUTCOMES = new Set(["purchased", "dismissed", "cancelled", "error"]);
const id = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 128;
const shortText = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 32;
const PROVIDERS = ["studio", "external", "native"];
const SURFACES = ["present", "paywall_step", "placement"];
const RENDER_MODES = ["elements", "custom", "external"];
const storeId = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 1024;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Problems that would make the snapshot fail the schema. Empty when the info is usable. */
export function validateInfo(info: unknown): string[] {
  if (!info || typeof info !== "object") return ["info is not an object"];
  const i = info as Record<string, unknown>;
  const errors: string[] = [];
  if (i.provider !== undefined && !PROVIDERS.includes(i.provider as string)) errors.push("provider must be studio, external or native");
  // Contract v1.1, section 4: the ids each provider requires. Absent means studio.
  const provider = i.provider ?? "studio";
  const required = provider === "studio" ? ["moment", "paywallId"] : provider === "external" ? ["placement", "externalPaywallId"] : provider === "native" ? ["externalPaywallId"] : [];
  for (const k of ["moment", "paywallId", "placement", "externalPaywallId"]) {
    if (required.includes(k) ? !id(i[k]) : i[k] !== undefined && !id(i[k])) errors.push(`${k} must be 1 to 128 characters${required.includes(k) ? ` (required with provider ${provider})` : ""}`);
  }
  if (i.providerName !== undefined && !shortText(i.providerName)) errors.push("providerName must be 1 to 32 characters");
  if (i.audienceId !== undefined && i.audienceId !== null && !id(i.audienceId)) errors.push("audienceId must be null or 1 to 128 characters");
  if (!RENDER_MODES.includes(i.renderMode as string)) errors.push("renderMode must be elements, custom or external");
  if (i.billing !== "store" && i.billing !== "stripe") errors.push("billing must be store or stripe");
  if (!SURFACES.includes(i.surface as string)) errors.push("surface must be present, paywall_step or placement");
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
  readonly surface: PresentationSurface;
  readonly provider?: PresentationProvider;
  readonly onboardingRun?: { run_id: string; step_key: string };
  readonly context: WireRunContext;
}

export function createState(info: PaywallPresentationInfo, presentationId: string, nowMs: number, context: WireRunContext): PresentationState {
  // Key order is the wire order. A v1-shaped info (no provider, Studio ids set)
  // yields exactly the v1 object: the v1.1 keys are added only when set.
  const paywall: PresentationPaywall = {
    ...(info.moment !== undefined ? { moment_key: info.moment } : {}),
    ...(info.paywallId !== undefined ? { paywall_id: info.paywallId } : {}),
    audience_id: info.audienceId ?? null,
    render_mode: info.renderMode,
    billing: info.billing,
  };
  if (info.variantKey !== undefined) paywall.variant_key = info.variantKey;
  if (info.deploymentId !== undefined) paywall.deployment_id = info.deploymentId;
  if (info.placement !== undefined) paywall.placement = info.placement;
  if (info.externalPaywallId !== undefined) paywall.external_paywall_id = info.externalPaywallId;
  if (info.providerName !== undefined) paywall.provider_name = info.providerName;
  return {
    id: presentationId,
    seq: 0,
    startedAt: nowMs,
    shownAt: null,
    endedAt: null,
    outcome: null,
    paywall,
    surface: info.surface,
    ...(info.provider !== undefined ? { provider: info.provider } : {}),
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
  // A purchase implies the paywall was on screen (P7): the contract requires shown_at with purchased.
  if (end.status === "purchased" && s.shownAt === null) s.shownAt = s.endedAt;
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
    ...(s.provider !== undefined ? { provider: s.provider } : {}),
    ...(s.onboardingRun ? { onboarding_run: { ...s.onboardingRun } } : {}),
    context: { ...s.context },
  };
  return s.endedAt !== null && s.outcome !== null
    ? { ...base, status: "ended", ended_at: toTimestamp(s.endedAt), outcome: { ...s.outcome } }
    : { ...base, status: "in_progress", ended_at: null, outcome: null };
}
