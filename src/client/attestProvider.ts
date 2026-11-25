import type { AttestProvider, KeyValueStorage } from "../core";
import type { AttestNativeModule, RocalyticsModules } from "./native";

/** Adapts the RocaAttest native module to the core provider. Null when `os` is neither ios nor android, or a function of that platform is missing. */
export function toAttestProvider(native: AttestNativeModule, os: string): AttestProvider | null {
  const isSupported = () => native.isSupported();
  if (os === "ios") {
    const { generateKey, attestKey, generateAssertion, getStoredKeyId, setStoredKeyId } = native;
    if (!generateKey || !attestKey || !generateAssertion || !getStoredKeyId || !setStoredKeyId) return null;
    return {
      platform: "ios",
      isSupported,
      generateKey: () => generateKey.call(native),
      attestKey: (keyId, binding) => attestKey.call(native, keyId, binding),
      generateAssertion: (keyId, binding) => generateAssertion.call(native, keyId, binding),
      getStoredKeyId: () => getStoredKeyId.call(native),
      setStoredKeyId: (keyId) => setStoredKeyId.call(native, keyId),
    };
  }
  if (os === "android") {
    const { prepare, requestToken } = native;
    if (!prepare || !requestToken) return null;
    return {
      platform: "android",
      isSupported,
      prepare: (cloudProjectNumber) => prepare.call(native, cloudProjectNumber),
      requestToken: (binding) => requestToken.call(native, binding),
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
