// Stand-ins for the Expo modules, react-native and fetch, for the Rocalytics
// client tests. The device shape is the one the fixture capture script uses,
// so a captured scenario can be replayed against the packaged client as is.
import type { FetchLike, RocalyticsModules } from "../src/client";

export interface FakeDevice {
  platform: "ios" | "android";
  platformVersion: string | number;
  applicationId: string | null;
  applicationName: string | null;
  nativeApplicationVersion: string | null;
  nativeBuildVersion: string | null;
  idfv: string | null;
  androidId: string | null;
  installTime: string;
  brand: string | null;
  modelName: string | null;
  manufacturer: string | null;
  osName: string | null;
  osVersion: string | null;
  ip: string;
  screen: { width: number; height: number; scale: number };
  uuid: string;
  locale: string;
  timeZone: string;
}

export const ROCA_ID = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";

export const IOS: FakeDevice = {
  platform: "ios",
  platformVersion: "18.1",
  applicationId: "com.example.app",
  applicationName: "Example",
  nativeApplicationVersion: "2.4.0",
  nativeBuildVersion: "412",
  idfv: "0A1B2C3D-4E5F-4061-8273-94A5B6C7D8E9",
  androidId: null,
  installTime: "2026-01-10T07:59:00.000Z",
  brand: "Apple",
  modelName: "iPhone 15 Pro",
  manufacturer: "Apple",
  osName: "iOS",
  osVersion: "18.1",
  ip: "203.0.113.7",
  screen: { width: 393, height: 852, scale: 3 },
  uuid: ROCA_ID,
  locale: "en-US",
  timeZone: "Europe/Paris",
};

/** A SecureStore over a map, recording every write. `failReads` makes reads of those keys reject. */
export class FakeSecureStore {
  readonly map: Map<string, string>;
  readonly writes: [string, string][] = [];
  failReads = new Set<string>();
  failWrites = new Set<string>();

  constructor(initial: Record<string, string> = {}) {
    this.map = new Map(Object.entries(initial));
  }

  getItemAsync = async (key: string): Promise<string | null> => {
    if (this.failReads.has(key)) throw new Error(`keychain unavailable (${key})`);
    return this.map.get(key) ?? null;
  };

  setItemAsync = async (key: string, value: string): Promise<void> => {
    if (this.failWrites.has(key)) throw new Error(`keychain write failed (${key})`);
    this.writes.push([key, value]);
    this.map.set(key, value);
  };

  dump(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

export function fakeModules(device: FakeDevice, store: FakeSecureStore): RocalyticsModules {
  return {
    application: {
      applicationId: device.applicationId,
      applicationName: device.applicationName,
      nativeApplicationVersion: device.nativeApplicationVersion,
      nativeBuildVersion: device.nativeBuildVersion,
      getIosIdForVendorAsync: async () => device.idfv,
      getAndroidId: () => device.androidId as string,
      getInstallationTimeAsync: async () => new Date(device.installTime),
    },
    crypto: { randomUUID: () => device.uuid },
    device: {
      brand: device.brand,
      modelName: device.modelName,
      manufacturer: device.manufacturer,
      osName: device.osName,
      osVersion: device.osVersion,
    },
    network: { getIpAddressAsync: async () => device.ip },
    secureStore: store,
    platform: { OS: device.platform, Version: device.platformVersion },
    dimensions: { get: () => ({ ...device.screen, fontScale: 1 }) },
  };
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records each request and answers from `respond` (by path), defaulting to the API's success codes. */
export function recordingFetch(respond: Record<string, { status: number; json?: unknown }> = {}) {
  const requests: CapturedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? null : JSON.parse(init.body) });
    const path = new URL(url).pathname;
    const r = respond[path] ?? { status: path === "/functions/v1/identify" ? 200 : 204 };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json ?? {} };
  };
  return { fetch, requests, paths: () => requests.map((r) => new URL(r.url).pathname) };
}

/** Makes `Intl.DateTimeFormat().resolvedOptions()` report the device's locale and time zone. Returns a restore function. */
export function stubIntl(device: Pick<FakeDevice, "locale" | "timeZone">): () => void {
  const Real = Intl.DateTimeFormat;
  const fake = function (this: unknown, ...a: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    if (a.length) return new Real(...a);
    return { resolvedOptions: () => ({ ...new Real().resolvedOptions(), locale: device.locale, timeZone: device.timeZone }) };
  } as unknown as typeof Intl.DateTimeFormat;
  Intl.DateTimeFormat = fake;
  return () => {
    Intl.DateTimeFormat = Real;
  };
}
