import { createPaywallTracker, type KeyValueStorage } from "@rocapine/rocalytics-sdk/paywall";
import { RocalyticsClient, createRocalyticsPaywallSink } from "@rocapine/rocalytics-sdk/client";

// Once, at app startup. Pass `paywallTracker` to the paywall host as `observer`:
//   <PaywallProvider observer={paywallTracker} customScreens={SCREENS}>…</PaywallProvider>
export function setUpPaywallTracking(rocalytics: RocalyticsClient, storage: KeyValueStorage, device: { appVersion: string; build: string; osVersion: string }) {
  return createPaywallTracker({
    sink: createRocalyticsPaywallSink(rocalytics),
    context: () => ({
      appVersion: device.appVersion,
      build: device.build,
      platform: "ios",
      osVersion: device.osVersion,
      locale: "en-US",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    storage, // e.g. AsyncStorage: an unsent snapshot survives the app being killed
  });
}

// In a custom paywall screen, report the purchase with its join key:
//   complete({ status: "purchased", transaction: {
//     originalTransactionIdentifier,  // the SAME value passed to Rocalytics' purchase call; iOS join key
//     purchaseToken: result.transaction.purchaseToken ?? undefined,    // Android join key: required to attribute proceeds
//     productId: result.productIdentifier,
//   } });
// A restore or a web redemption is not a new purchase:
//   complete({ status: "purchased", transaction: { restored: true } });
