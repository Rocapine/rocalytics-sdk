import { requireNativeModule } from "expo-modules-core";

/**
 * The RocaAttest native module. The Rocalytics SDK never imports this package: it probes the
 * module by name (`requireOptionalNativeModule("RocaAttest")`) and expects exactly this surface.
 *
 * Must stay identical to `AttestNativeModule` in the SDK's src/client/native.ts.
 *
 * Rejections carry `code` `E_DC_<n>` (iOS DCError code n) or `E_ATTEST_UNKNOWN`.
 */
export interface AttestNativeModule {
  isSupported(): Promise<boolean>;
  // iOS
  generateKey?(): Promise<string>;
  attestKey?(keyId: string, binding: string): Promise<string>;
  generateAssertion?(keyId: string, binding: string): Promise<string>;
  getStoredKeyId?(): Promise<string | null>;
  setStoredKeyId?(keyId: string | null): Promise<void>;
  // Android
  prepare?(cloudProjectNumber: string): Promise<void>;
  requestToken?(binding: string): Promise<string>;
}

export default requireNativeModule<AttestNativeModule>("RocaAttest");
