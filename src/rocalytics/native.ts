// The one file in the package that loads another package.
//
// The Rocalytics client needs five Expo native modules and react-native. They
// are optional peer dependencies: an app that only uses /onboarding installs
// none of them, and nothing outside this file references them.
//
// They are loaded lazily, at client start, never at import time. An Expo
// module's JS wrapper calls `requireNativeModule("ExpoXxx")` when it is first
// evaluated, which throws when the app binary predates the module (a JS update
// shipped over the air onto an older build). So each native module is first
// probed through `requireOptionalNativeModule` (expo-modules-core), which
// returns null instead of throwing, and no wrapper is required unless every
// probe succeeds. The probe must not be `TurboModuleRegistry.get`: on the New
// Architecture, Expo modules are registered with the Expo modules registry,
// not the TurboModule registry, so that probe reports a linked module as
// missing.
//
// Every require is a string literal, so a bundler can see it. Metro resolves
// them at bundle time: an app that imports /rocalytics without installing a
// peer fails to bundle, rather than going inert at run time.

declare const require: (id: string) => unknown;

/** The members of `expo-application` the client reads. The module itself fits as is. */
export interface ApplicationModule {
  readonly applicationId: string | null;
  readonly applicationName: string | null;
  readonly nativeApplicationVersion: string | null;
  readonly nativeBuildVersion: string | null;
  getIosIdForVendorAsync(): Promise<string | null>;
  getAndroidId(): string;
  getInstallationTimeAsync(): Promise<Date>;
}

/** The native capabilities the client uses, shaped like the Expo modules and react-native, which fit as they are. */
export interface RocalyticsModules {
  application: ApplicationModule;
  crypto: { randomUUID(): string };
  device: {
    readonly brand: string | null;
    readonly modelName: string | null;
    readonly manufacturer: string | null;
    readonly osName: string | null;
    readonly osVersion: string | null;
  };
  network: { getIpAddressAsync(): Promise<string> };
  secureStore: {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
  };
  /** react-native's `Platform`. */
  platform: { readonly OS: string; readonly Version: string | number };
  /** react-native's `Dimensions`. */
  dimensions: { get(dim: "screen"): { width: number; height: number; scale: number } };
}

/** How each package is loaded. Injected by tests; the defaults are the literal requires. */
export interface ExpoModuleLoaders {
  core: () => unknown;
  application: () => unknown;
  crypto: () => unknown;
  device: () => unknown;
  network: () => unknown;
  secureStore: () => unknown;
  reactNative: () => unknown;
}

export type LoadResult = { ok: true; modules: RocalyticsModules } | { ok: false; reason: string };

/** The native module names the wrappers pass to `requireNativeModule`. */
const NATIVE_MODULES = ["ExpoApplication", "ExpoCrypto", "ExpoDevice", "ExpoNetwork", "ExpoSecureStore"];

const DEFAULT_LOADERS: ExpoModuleLoaders = {
  core: () => require("expo-modules-core"),
  application: () => require("expo-application"),
  crypto: () => require("expo-crypto"),
  device: () => require("expo-device"),
  network: () => require("expo-network"),
  secureStore: () => require("expo-secure-store"),
  reactNative: () => require("react-native"),
};

/**
 * Loads the Expo modules and react-native, or explains why it could not.
 * Never throws: a missing package, a native module absent from the binary, or
 * a wrapper that throws while loading all come back as `{ ok: false, reason }`.
 */
export function loadExpoModules(loaders: ExpoModuleLoaders = DEFAULT_LOADERS): LoadResult {
  try {
    const core = loaders.core() as { requireOptionalNativeModule(name: string): unknown };
    const missing = NATIVE_MODULES.find((name) => core.requireOptionalNativeModule(name) == null);
    if (missing) return { ok: false, reason: `native module ${missing} is not in this binary` };
    const reactNative = loaders.reactNative() as { Platform: RocalyticsModules["platform"]; Dimensions: RocalyticsModules["dimensions"] };
    return {
      ok: true,
      modules: {
        application: loaders.application() as RocalyticsModules["application"],
        crypto: loaders.crypto() as RocalyticsModules["crypto"],
        device: loaders.device() as RocalyticsModules["device"],
        network: loaders.network() as RocalyticsModules["network"],
        secureStore: loaders.secureStore() as RocalyticsModules["secureStore"],
        platform: reactNative.Platform,
        dimensions: reactNative.Dimensions,
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
