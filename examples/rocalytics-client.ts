import { createRocalyticsOnboardingSink, getEventId, RocalyticsClient } from "@rocapine/studio-sdk/rocalytics";
import { onboardingRun, type KeyValueStorage, type RunContextInput } from "@rocapine/studio-sdk/onboarding";

// 1. One client per app, created once at startup. It starts itself: it reads
//    (or mints) the device's roca id, identifies the device, and sends
//    `install` once per device. Every method waits for that.
export const rocalytics = new RocalyticsClient();

// 2. Identifiers, whenever the app learns them. Null values are dropped.
export async function onSignedIn(userId: string, revenueCatId: string | null) {
  await rocalytics.identify({ user_id: userId, revenue_cat_id: revenueCatId });
}

// 3. A purchase. Pass the purchase SDK's product and transaction objects as
//    they are: they are forwarded whole, and the product id is read from
//    `product.productIdentifier` unless you pass `productId`.
export async function onPurchase(
  product: { productIdentifier: string },
  transaction: { originalTransactionIdentifier: string },
  price: number,
  currency: string,
  isTrial: boolean,
) {
  const originalTransactionIdentifier = transaction.originalTransactionIdentifier;
  await rocalytics.trackPurchase({ isTrial, value: price, currency, originalTransactionIdentifier, product, transaction });
  // The id Rocalytics uses when it forwards the conversion, to deduplicate it
  // against one the app sends to an ad network itself.
  return getEventId("purchase", { original_transaction_identifier: originalTransactionIdentifier });
}

// 4. Onboarding progress, reported through the run tracker and delivered to Rocalytics.
export function setUpOnboardingTracking(storage: KeyValueStorage, context: () => RunContextInput) {
  onboardingRun.configure({ sink: createRocalyticsOnboardingSink(rocalytics), context, storage });
}
