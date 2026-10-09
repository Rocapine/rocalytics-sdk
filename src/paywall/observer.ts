// The observer a paywall host calls, mirrored here so this package imports
// nothing from the host SDK: createPaywallTracker() satisfies it structurally.
// Names are those of the host SDK's PaywallObserver, verbatim.

export type PaywallSurface = "present" | "paywall_step";

export interface PaywallPresentationInfo {
  moment: string;
  paywallId: string;
  audienceId: string | null;
  renderMode: "elements" | "custom";
  billing: "store" | "stripe";
  surface: PaywallSurface;
  variantKey?: string;
  deploymentId?: string;
  onboardingRun?: { runId: string; stepKey: string };
}

export interface PaywallTransactionInfo {
  /** The exact value the app passes to Rocalytics' `purchase` call: iOS StoreKit original transaction id (iOS join key); Android Play order id (GPA.…). */
  originalTransactionIdentifier?: string;
  /** Android only: the Play purchase token (RevenueCat `transaction.purchaseToken`). Android join key. */
  purchaseToken?: string;
  productId?: string;
  /** True when the purchase only restored existing access. Not a conversion. */
  restored?: boolean;
}

export interface PaywallPresentationEnd {
  status: "purchased" | "dismissed" | "cancelled" | "error";
  /** The host SDK's error reason; accepted as any string. */
  reason?: string;
  transaction?: PaywallTransactionInfo;
}

export interface PaywallPresentationHandle {
  shown(): void;
  end(outcome: PaywallPresentationEnd): void;
}

export interface PaywallObserver {
  start(info: PaywallPresentationInfo): PaywallPresentationHandle | void;
}
