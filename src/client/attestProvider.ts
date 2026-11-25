import type { AttestProvider, KeyValueStorage } from "../core";
import type { AttestNativeModule, RocalyticsModules } from "./native";

/** Storage key of the App Attest key id. */
export const ATTEST_KEY_ID_KEY = "rocalytics_attest_key_id";

export interface AttestProviderDeps {
  /** Where the iOS key id is kept. */
  storage: KeyValueStorage;
  crypto: RocalyticsModules["crypto"];
}

const code = (error: unknown): unknown => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);

/** Play Integrity's request hash for a binding string: SHA-256 of its UTF-8 bytes, base64url without padding (43 chars). */
export async function requestHashOf(crypto: RocalyticsModules["crypto"], binding: string): Promise<string> {
  const b64 = await crypto.digestStringAsync("SHA-256", binding, { encoding: "base64" });
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Adapts ExpoAppIntegrity (`@expo/app-integrity`) to the core provider. Null when `os` is neither ios nor android,
 * or a function of that platform is missing.
 */
export function toAttestProvider(native: AttestNativeModule, os: string, deps: AttestProviderDeps): AttestProvider | null {
  if (os === "ios") {
    const { generateKeyAsync, attestKeyAsync, generateAssertionAsync } = native;
    if (!generateKeyAsync || !attestKeyAsync || !generateAssertionAsync) return null;
    return {
      platform: "ios",
      isSupported: async () => native.isSupported === true,
      generateKey: () => generateKeyAsync.call(native),
      attestKey: (keyId, binding) => attestKeyAsync.call(native, keyId, binding),
      generateAssertion: (keyId, binding) => generateAssertionAsync.call(native, keyId, binding),
      getStoredKeyId: async () => await deps.storage.getItem(ATTEST_KEY_ID_KEY),
      setStoredKeyId: async (keyId) => {
        await (keyId === null ? deps.storage.removeItem(ATTEST_KEY_ID_KEY) : deps.storage.setItem(ATTEST_KEY_ID_KEY, keyId));
      },
    };
  }
  if (os === "android") {
    const { prepareIntegrityTokenProviderAsync: prepare, requestIntegrityCheckAsync: request } = native;
    if (!prepare || !request) return null;
    let cloudProjectNumber: string | null = null;
    return {
      platform: "android",
      isSupported: async () => true,
      prepare: async (number) => {
        await prepare.call(native, number);
        cloudProjectNumber = number;
      },
      requestToken: async (binding) => {
        const hash = await requestHashOf(deps.crypto, binding);
        try {
          return await request.call(native, hash);
        } catch (error) {
          // Google asks for a new token provider: prepare one and retry once.
          if (code(error) !== "ERR_APP_INTEGRITY_PROVIDER_INVALID" || cloudProjectNumber === null) throw error;
          await prepare.call(native, cloudProjectNumber);
          return request.call(native, hash);
        }
      },
    };
  }
  return null;
}

/** A `KeyValueStorage` over expo-secure-store, which has no delete here: removeItem writes "", and getItem maps "" to null. */
export function secureStoreStorage(store: RocalyticsModules["secureStore"]): KeyValueStorage {
  return {
    getItem: async (key) => (await store.getItemAsync(key)) || null,
    setItem: (key, value) => store.setItemAsync(key, value),
    removeItem: (key) => store.setItemAsync(key, ""),
  };
}
