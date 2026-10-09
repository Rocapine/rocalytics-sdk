// Paywall presentation contract v1: the payload types.
// Normative text: docs/paywall-presentation-contract.md. src/paywall/contract.ts
// is this file, byte for byte, except its import line (test/paywall-docs.test.ts).
import type { RunContext, Timestamp } from "./onboarding-run.types";

export type PresentationStatus = "in_progress" | "ended";
export type PresentationOutcomeStatus = "purchased" | "dismissed" | "cancelled" | "error";
export type PresentationSurface = "present" | "paywall_step";

export interface PresentationPaywall {
  /** The moment's key: what the host passed to `present()`. */
  moment_key: string;
  /** The Studio paywall id the moment's audience waterfall picked. */
  paywall_id: string;
  /** The audience that matched; null when the catalog carried none. */
  audience_id: string | null;
  render_mode: "elements" | "custom";
  billing: "store" | "stripe";
  variant_key?: string;
  deployment_id?: string;
}

export interface PresentationTransaction {
  /**
   * The exact value the app passes to Rocalytics' `purchase` call (`originalTransactionIdentifier`).
   * iOS: StoreKit's original transaction id, the join key to the store-notification rows.
   * Android: the Play order id (GPA.…); not used to join.
   */
  original_transaction_identifier?: string;
  /** Android only: the Play purchase token, the proceeds join key on Android. */
  purchase_token?: string;
  product_id?: string;
  /** True when the purchase only restored existing access (a restore, a web redemption). Not a conversion. */
  restored?: boolean;
}

export interface PresentationOutcome {
  status: PresentationOutcomeStatus;
  /** Only with status "error": the SDK's reason, e.g. "render-error". */
  reason?: string;
  /** Only with status "purchased". Absent when the host reported none. */
  transaction?: PresentationTransaction;
}

interface PresentationBase {
  schema_version: 1;
  /** Client-minted, lowercase UUID. One per presentation. */
  presentation_id: string;
  /** Starts at 1 and increases with every send of this presentation. */
  seq: number;
  started_at: Timestamp;
  shown_at: Timestamp | null;
  sent_at: Timestamp;
  paywall: PresentationPaywall;
  surface: PresentationSurface;
  /** Only for surface "paywall_step": the onboarding run it sits in. */
  onboarding_run?: { run_id: string; step_key: string };
  context: RunContext;
}

export interface InProgressPresentationSnapshot extends PresentationBase {
  status: "in_progress";
  ended_at: null;
  outcome: null;
}

export interface EndedPresentationSnapshot extends PresentationBase {
  status: "ended";
  ended_at: Timestamp;
  outcome: PresentationOutcome;
}

export type PaywallPresentationSnapshot = InProgressPresentationSnapshot | EndedPresentationSnapshot;
