/**
 * The RocaAttest native module. The Rocalytics SDK never imports this package: it probes the
 * module by name (`requireOptionalNativeModule("RocaAttest")`) and expects exactly this surface.
 *
 * Rejections carry `code` `E_DC_<n>` (iOS DCError code n) or `E_ATTEST_UNKNOWN`.
 */
export interface AttestNativeModule {
    isSupported(): Promise<boolean>;
    generateKey?(): Promise<string>;
    attestKey?(keyId: string, binding: string): Promise<string>;
    generateAssertion?(keyId: string, binding: string): Promise<string>;
    getStoredKeyId?(): Promise<string | null>;
    setStoredKeyId?(keyId: string | null): Promise<void>;
    prepare?(cloudProjectNumber: string): Promise<void>;
    requestToken?(binding: string): Promise<string>;
}
declare const _default: AttestNativeModule;
export default _default;
