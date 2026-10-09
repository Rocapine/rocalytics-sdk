// Wire types of the Rocalytics API, as the client sends and reads them.

/**
 * Event names `track` accepts. The union of every name the copied clients
 * allowed; the API rejects a name it does not know. Any other name goes
 * through `trackCustomEvent`, which the API forwards instead of storing.
 */
export type TrackEventName = "install" | "onboarding_completed" | "purchase" | "subscription_started" | "trial_started";

/** Adjust attribution, as the Adjust SDK reports it. */
export type AdjustAttribution = {
  trackerToken?: string | null;
  trackerName?: string | null;
  network?: string | null;
  campaign?: string | null;
  adgroup?: string | null;
  creative?: string | null;
  clickLabel?: string | null;
  adid?: string | null;
  costType?: string | null;
  costAmount?: number | null;
  costCurrency?: string | null;
  fbInstallReferrer?: string | null;
};

/** Identifiers for `identify`. Null and undefined values are dropped before sending. */
export type IdentifyParams = {
  revenue_cat_id?: string | null;
  qonversion_id?: string | null;
  adjust_id?: string | null;
  adjust_attribution?: AdjustAttribution | null;
  user_id?: string | null;
  email?: string | null;
  amplitude_device_id?: string | null;
  idfa?: string | null;
  idfv?: string | null;
  android_id?: string | null;
  customerio_id?: string | null;
  segment_id?: string | null;
  gaid?: string | null;
  /** BCP 47 tag of the language the app is shown in. */
  locale?: string | null;
};

/**
 * A store product, from any purchase SDK. Forwarded whole under
 * `experimental.product`; its `productIdentifier` is the product id when
 * `productId` is not given.
 */
export type PurchaseProduct = object;

/** A store transaction, from any purchase SDK. Forwarded whole under `experimental.transaction`. */
export type PurchaseTransaction = object;

export type TrackPurchaseParams = {
  isTrial: boolean;
  /** The price charged: 0 for a free trial. */
  value: number;
  /** ISO 4217 code. */
  currency: string;
  /** Links renewals to the first purchase, and keys the event's deduplication id. */
  originalTransactionIdentifier: string;
  /** The store product id. Defaults to `product.productIdentifier`. */
  productId?: string;
  product?: PurchaseProduct;
  transaction?: PurchaseTransaction;
  /** A web-checkout redemption result, for a purchase made outside the store. Forwarded under `experimental.redemption_result`. */
  redemptionResult?: unknown;
};

/** Answers given on one onboarding step, by question or element id. */
export type OnboardingStepAnswers = Record<string, unknown>;

/** Free-form context about which onboarding was shown, e.g. `onboarding_id`, `audience_id`, `deployment_id`. */
export type OnboardingMetadata = Record<string, unknown>;

export type OnboardingStepResponse = {
  step_id: string;
  entered_at: string;
  /** Null while the user is still on the step. */
  exited_at: string | null;
  answers: OnboardingStepAnswers;
};

/** The body of `/onboarding-response`: every step seen so far, resent whole on each call. */
export type OnboardingResponsePayload = {
  onboarding_metadata?: OnboardingMetadata;
  /** When the snapshot was produced. The API ignores a snapshot older than the one it has. */
  sent_at: string;
  responses: OnboardingStepResponse[];
};

/** Device facts sent with every tracked event. */
export type DeviceContext = {
  ip: string | null;
  user_agent: string;
  device_model: string | null;
  device_brand: string | null;
  device_manufacturer: string | null;
  os_name: string | null;
  os_version: string | null;
  screen_width: number;
  screen_height: number;
  screen_scale: number;
  timezone: string;
  locale: string;
  app_version: string | null;
  app_build: string | null;
};

/**
 * Optional client-side signals for the demand score. Anything omitted falls
 * back server-side or drops out of the score, so send only what the app has;
 * never invent a value.
 */
export type DemandScoreSignals = {
  /** Native model identifier, e.g. `iPhone15,3`. */
  device_model?: string;
  /** Hardware release year. */
  device_release_year?: number;
  /** OS version, e.g. `17.4`. Only the major number is read. */
  os_version?: string;
  connection_type?: "wifi" | "cellular" | "other";
  /** Two-letter storefront country, e.g. `US`. */
  store_country?: string;
  app_open_count?: number;
  /** Send 0 only for a real zero: the server reads its own 0 as "not tracked". */
  paywall_view_count?: number;
  /** BCP 47 locale, e.g. `en-US`. */
  locale?: string;
};

export type DemandScoreSignalScore = {
  signal: string;
  /** Normalized 0 to 1 sub-score; null when the signal was unavailable. */
  value: number | null;
  weight: number;
  /** Contribution to the final score after weight renormalization. */
  weighted: number;
};

/** Scoring models the endpoint computes. */
export type DemandScoreVersion = "v1" | "v2";

/** v1: a weighted-signal model over behavioural history and device context. */
export type DemandScoreV1 = {
  /** Integer 1 to 100. */
  score: number;
  /** True when the identity has no event history yet. */
  coldStart: boolean;
  signals: DemandScoreSignalScore[];
};

export type DemandScoreV2Signal = {
  signal: string;
  /** The level looked up, after normalization. */
  level: string;
  /** Smoothed conversion rate for that level. */
  rate: number;
  /** Contribution to the total, in log-odds. */
  logOdds: number;
  /** False when the level was absent from the rates table and the fallback was used. */
  matched: boolean;
};

/** v2: a learned-rates scorecard, calibrated to a percentile. */
export type DemandScoreV2 = {
  /** Integer 1 to 100. */
  score: number;
  /** Raw additive score before calibration. */
  logOdds: number;
  /** How many scorecard fields resolved to a known level. */
  matchedSignals: number;
  /** `app` when scored with this app's own rates, `portfolio` when it fell back to the pooled table. */
  ratesSource: "app" | "portfolio";
  signals: DemandScoreV2Signal[];
};

/**
 * The demand score response. `selectedVersion` and `versions` are optional,
 * and `signals` is kept, so a response from before the score was versioned
 * still fits.
 */
export type DemandScoreResult = {
  /** Integer 1 to 100: the likelihood this install converts to a paying customer. Mirrors `versions[selectedVersion].score`. */
  demandScore: number;
  /** Which version `demandScore` mirrors: a server-side setting. */
  selectedVersion?: DemandScoreVersion;
  /** True when the identity has no event history yet. */
  coldStart: boolean;
  versions?: {
    v1: DemandScoreV1;
    /** Absent when no rates table exists for the app or the portfolio. */
    v2?: DemandScoreV2;
  };
  /** The unversioned response's breakdown. */
  signals?: DemandScoreSignalScore[];
};
