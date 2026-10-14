// The observer a paywall host calls, mirrored here so this package imports
// nothing from the host SDK: createPaywallTracker() satisfies it structurally.
// Names are those of the host SDK's PaywallObserver. The info type is a superset
// of the host's: contract v1.1 adds the fields an app sets itself when it reports
// a paywall the Studio did not serve.

/**
 * What triggered the presentation. `present`: a Studio `present()` call.
 * `paywall_step`: a `Paywall` step inside an onboarding. `placement`: any other
 * in-app trigger, such as a third-party paywall service's placement.
 */
export type PaywallSurface = "present" | "paywall_step" | "placement";

/**
 * Who served the paywall. `studio` (the default when absent): the Studio's paywall
 * host. `external`: a third-party paywall service. `native`: a paywall the app
 * renders with its own code.
 */
export type PaywallProvider = "studio" | "external" | "native";

export interface PaywallPresentationInfo {
  /** Contract v1.1. Absent means `studio`, and nothing is sent for it: the snapshot is the v1 one. */
  provider?: PaywallProvider;
  /** The moment's key. Required when `provider` is `studio` or absent. */
  moment?: string;
  /** The Studio paywall id. Required when `provider` is `studio` or absent. */
  paywallId?: string;
  /** The audience that matched. Absent is sent as null. */
  audienceId?: string | null;
  /** `external`: the paywall UI is rendered by a third-party paywall service. */
  renderMode: "elements" | "custom" | "external";
  billing: "store" | "stripe";
  surface: PaywallSurface;
  /** The catalog's variant, or the paywall service's experiment variant. */
  variantKey?: string;
  deploymentId?: string;
  /** Only with surface `paywall_step`. */
  onboardingRun?: { runId: string; stepKey: string };
  /** The app's trigger name for the paywall. Required when `provider` is `external`. */
  placement?: string;
  /** The non-Studio paywall's id: the service's paywall identifier, or the app's own variant key for `native`. Required when `provider` is `external` or `native`. */
  externalPaywallId?: string;
  /** Free text naming the paywall service, 1 to 32 UTF-8 bytes. */
  providerName?: string;
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
