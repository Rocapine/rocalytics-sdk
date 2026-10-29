import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RocalyticsClient, loadExpoModules, type Diagnostic, type FetchLike, type RocalyticsClientOptions, type TrackPurchaseParams } from "../src/client";
import { FakeSecureStore, IOS, ROCA_ID, fakeModules, recordingFetch, stubIntl } from "./client.fakes";

// The identity a device keeps across launches, the once-per-device install
// event, and what the client does when it cannot run at all.

const KEY = "rocalytics-roca-id";
const LEGACY_KEY = "rocalitics-roca-id";
const OTHER_ID = "0b6e5a2c-3d4f-4a1b-8c9d-0e1f2a3b4c5d";

let restoreIntl: () => void;
beforeEach(() => {
  restoreIntl = stubIntl(IOS);
});
afterEach(() => restoreIntl());

// The install ping is off here: these tests are about the API requests. The
// "installPing" block covers it.
function start(store: FakeSecureStore, device = IOS, options: Pick<RocalyticsClientOptions, "identifyOnStart" | "installPing"> = {}) {
  const http = recordingFetch();
  const diagnostics: Diagnostic[] = [];
  const client = new RocalyticsClient({ modules: fakeModules(device, store), fetch: http.fetch, onDiagnostic: (d) => diagnostics.push(d), installPing: false, ...options });
  return { client, http, diagnostics };
}

describe("the roca id: migration from the misspelled key", () => {
  it("a fresh device mints an id and writes it under both keys, so a rolled-back bundle still running a copied client reads the same id", async () => {
    const store = new FakeSecureStore();
    const { client } = start(store);
    await client.ready;
    expect(client.rocaId).toBe(ROCA_ID);
    expect(store.writes.slice(0, 2)).toEqual([
      [KEY, ROCA_ID],
      [LEGACY_KEY, ROCA_ID],
    ]);
    // What a copied client does on launch: read the misspelled key, mint only if it is empty.
    const copiedClientId = (await store.getItemAsync(LEGACY_KEY)) ?? "a-new-id";
    expect(copiedClientId).toBe(ROCA_ID);
  });

  it("keeps the minted id when writing it to the legacy key fails, and reports it", async () => {
    const store = new FakeSecureStore();
    store.failWrites.add(LEGACY_KEY);
    const { client, diagnostics } = start(store);
    await client.ready;
    expect(client.rocaId).toBe(ROCA_ID);
    expect(store.map.get(KEY)).toBe(ROCA_ID);
    expect(diagnostics.map((d) => d.code)).toContain("identity-legacy-write-failed");
  });

  it("a device holding only the legacy key keeps its id, copies it to the corrected key, and leaves the legacy key in place", async () => {
    const store = new FakeSecureStore({ [LEGACY_KEY]: OTHER_ID, "rocadata-install-tracked": "true" });
    const { client, http } = start(store);
    await client.ready;
    expect(client.rocaId).toBe(OTHER_ID);
    expect(store.dump()).toMatchObject({ [KEY]: OTHER_ID, [LEGACY_KEY]: OTHER_ID });
    expect(http.requests.every((r) => r.headers["X-Roca-ID"] === OTHER_ID)).toBe(true);
  });

  it("with both keys present the corrected key wins, and nothing is rewritten", async () => {
    const store = new FakeSecureStore({ [KEY]: ROCA_ID, [LEGACY_KEY]: OTHER_ID, "rocadata-install-tracked": "true" });
    const { client } = start(store);
    await client.ready;
    expect(client.rocaId).toBe(ROCA_ID);
    expect(store.writes).toEqual([]);
  });

  it("keeps the legacy id for the session when copying it to the corrected key fails", async () => {
    const store = new FakeSecureStore({ [LEGACY_KEY]: OTHER_ID, "rocadata-install-tracked": "true" });
    store.failWrites.add(KEY);
    const { client, diagnostics } = start(store);
    await client.ready;
    expect(client.rocaId).toBe(OTHER_ID);
    expect(diagnostics.map((d) => d.code)).toContain("identity-migration-failed");
  });

  it.each([KEY, LEGACY_KEY])("never mints an id when reading %s fails: the client goes inert and sends nothing", async (failing) => {
    const store = new FakeSecureStore({ "rocadata-install-tracked": "true" });
    store.failReads.add(failing);
    const { client, http, diagnostics } = start(store);
    await client.ready;
    expect(client.rocaId).toBeNull();
    expect(store.writes).toEqual([]);
    await client.track("onboarding_completed");
    expect(http.requests).toEqual([]);
    expect(diagnostics.map((d) => d.code)).toContain("identity-unavailable");
  });
});

describe("the install event", () => {
  it("fires once on a fresh device and records it under rocadata-install-tracked", async () => {
    const store = new FakeSecureStore();
    const { client, http } = start(store);
    await client.ready;
    expect(http.paths()).toEqual(["/functions/v1/identify", "/functions/v1/track"]);
    expect((http.requests[1].body as { name: string }).name).toBe("install");
    expect(store.map.get("rocadata-install-tracked")).toBe("true");

    const again = start(store);
    await again.client.ready;
    expect(again.http.paths()).toEqual(["/functions/v1/identify"]);
  });

  it.each(["rocadata-install-tracked", "rocadata-install-tracked-4"])("does not fire again on a device holding %s", async (key) => {
    const store = new FakeSecureStore({ [KEY]: ROCA_ID, [key]: "true" });
    const { client, http } = start(store);
    await client.ready;
    expect(http.paths()).toEqual(["/functions/v1/identify"]);
    expect(store.writes).toEqual([]);
  });

  it("does not fire when the install flag cannot be read", async () => {
    const store = new FakeSecureStore({ [KEY]: ROCA_ID });
    store.failReads.add("rocadata-install-tracked-4");
    const { client, http } = start(store);
    await client.ready;
    expect(http.paths()).toEqual(["/functions/v1/identify"]);
    expect(client.rocaId).toBe(ROCA_ID); // the id is fine; only the install event is skipped
  });
});

describe("installPing", () => {
  function startWithPing(store: FakeSecureStore, respond: Parameters<typeof recordingFetch>[0] = {}, options: RocalyticsClientOptions = {}) {
    const http = recordingFetch(respond);
    const diagnostics: Diagnostic[] = [];
    const client = new RocalyticsClient({ modules: fakeModules(IOS, store), fetch: http.fetch, onDiagnostic: (d) => diagnostics.push(d), ...options });
    return { client, http, diagnostics };
  }

  it("off with installPing: false: a fresh device sends no ping", async () => {
    const { client, http } = startWithPing(new FakeSecureStore(), {}, { installPing: false });
    await client.ready;
    expect(http.requests.map((r) => r.url)).not.toContain("https://track.rocapi.ne/install");
  });

  it("on by default: the install is followed by one POST to the attribution worker, with the identity headers and no body", async () => {
    const store = new FakeSecureStore();
    const { client, http, diagnostics } = startWithPing(store);
    await client.ready;
    expect(http.requests.map((r) => r.url)).toEqual([
      "https://rocalytics-api.rocapine.io/functions/v1/identify",
      "https://rocalytics-api.rocapine.io/functions/v1/track",
      "https://track.rocapi.ne/install",
    ]);
    expect(http.requests[2]).toEqual({
      url: "https://track.rocapi.ne/install",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Roca-ID": ROCA_ID, "X-Application-ID": IOS.applicationId, "X-Platform": "ios" },
      body: null,
    });
    expect(diagnostics).toEqual([]);

    const again = startWithPing(store);
    await again.client.ready;
    expect(again.http.paths()).toEqual(["/functions/v1/identify"]);
  });

  it("on: attributionBaseUrl moves the ping", async () => {
    const { client, http } = startWithPing(new FakeSecureStore(), {}, { attributionBaseUrl: "https://track.example.com" });
    await client.ready;
    expect(http.requests[2].url).toBe("https://track.example.com/install");
  });

  it("on: a failed ping is reported, and the install still counts as sent", async () => {
    const store = new FakeSecureStore();
    const { client, http, diagnostics } = startWithPing(store, { "/install": { status: 503 } });
    await client.ready;
    expect(http.paths()).toEqual(["/functions/v1/identify", "/functions/v1/track", "/install"]);
    expect(diagnostics).toEqual([{ code: "install-ping-failed", message: "[ROCALYTICS] install-ping failed: 503" }]);
    expect(store.map.get("rocadata-install-tracked")).toBe("true");
  });

  it("on: no ping when the install event itself fails", async () => {
    const { client, http } = startWithPing(new FakeSecureStore(), { "/functions/v1/track": { status: 500 } });
    await client.ready;
    expect(http.paths()).toEqual(["/functions/v1/identify", "/functions/v1/track"]);
  });
});

describe("identifyOnStart", () => {
  it.each([{}, { identifyOnStart: true }])("%o: start-up identifies the device, then sends install", async (options) => {
    const store = new FakeSecureStore();
    const { client, http } = start(store, IOS, options);
    await client.ready;
    expect(http.paths()).toEqual(["/functions/v1/identify", "/functions/v1/track"]);
    expect(http.requests[0].body).toEqual({ idfv: IOS.idfv, locale: IOS.locale });
  });

  it("false: no identify at start-up, the roca id still resolves, and install is still sent exactly once", async () => {
    const store = new FakeSecureStore();
    const { client, http, diagnostics } = start(store, IOS, { identifyOnStart: false });
    await client.ready;
    expect(client.rocaId).toBe(ROCA_ID);
    expect(http.paths()).toEqual(["/functions/v1/track"]);
    expect((http.requests[0].body as { name: string }).name).toBe("install");
    expect(diagnostics).toEqual([]);

    const again = start(store, IOS, { identifyOnStart: false });
    await again.client.ready;
    expect(again.client.rocaId).toBe(ROCA_ID);
    expect(again.http.paths()).toEqual([]);
  });

  it("false: does not read the device identifiers, so one that fails to read cannot cost the install event", async () => {
    const store = new FakeSecureStore();
    const modules = fakeModules(IOS, store);
    modules.application.getIosIdForVendorAsync = () => Promise.reject(new Error("idfv unavailable"));
    const http = recordingFetch();
    const diagnostics: Diagnostic[] = [];
    const client = new RocalyticsClient({ modules, fetch: http.fetch, onDiagnostic: (d) => diagnostics.push(d), identifyOnStart: false, installPing: false });
    await client.ready;
    expect(http.paths()).toEqual(["/functions/v1/track"]);
    expect(diagnostics).toEqual([]);
  });

  it("false: the host's own identify still goes out, after start-up", async () => {
    const store = new FakeSecureStore({ [KEY]: ROCA_ID, "rocadata-install-tracked": "true" });
    const { client, http } = start(store, IOS, { identifyOnStart: false });
    await client.identify({ user_id: "u", locale: "fr" });
    expect(http.paths()).toEqual(["/functions/v1/identify"]);
    expect(http.requests[0].body).toEqual({ user_id: "u", locale: "fr" });
  });
});

describe("an inert client", () => {
  it("with no native modules: ready resolves, every method resolves without a request, and the cause is reported", async () => {
    const http = recordingFetch();
    const diagnostics: Diagnostic[] = [];
    const client = new RocalyticsClient({ modules: null, fetch: http.fetch, onDiagnostic: (d) => diagnostics.push(d) });
    await expect(client.ready).resolves.toBeUndefined();
    expect(client.rocaId).toBeNull();
    await client.track("purchase");
    await client.trackEvent("install");
    await client.identify({ user_id: "u" });
    await client.trackCustomEvent("x");
    await client.trackOnboarding("welcome");
    await client.trackPurchase({ isTrial: false, value: 1, currency: "EUR", originalTransactionIdentifier: "t", productId: "p" });
    await expect(client.getDemandScore()).rejects.toThrow("[ROCALYTICS] demand-score unavailable: client failed to initialize");
    expect(http.requests).toEqual([]);
    expect(diagnostics.map((d) => d.code)).toEqual(["native-modules-unavailable"]);
  });

  it("by default (no modules injected) loads the Expo modules lazily: under plain Node they are absent, so the client is inert and does not throw", async () => {
    const diagnostics: Diagnostic[] = [];
    const client = new RocalyticsClient({ fetch: recordingFetch().fetch, onDiagnostic: (d) => diagnostics.push(d) });
    await client.ready;
    expect(client.rocaId).toBeNull();
    // Inert because the package is missing, not because of a bug in the loader.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("native-modules-unavailable");
    expect(diagnostics[0].message).toMatch(/Cannot find module 'expo-modules-core'/);
  });

  it("reports a failed init (such as identify failing) without rejecting ready", async () => {
    const store = new FakeSecureStore();
    const http = recordingFetch({ "/functions/v1/identify": { status: 503 } });
    const diagnostics: Diagnostic[] = [];
    const client = new RocalyticsClient({ modules: fakeModules(IOS, store), fetch: http.fetch, onDiagnostic: (d) => diagnostics.push(d) });
    await expect(client.ready).resolves.toBeUndefined();
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([["init-failed", "[ROCALYTICS] identify failed: 503"]]);
    // The id was obtained before identify failed, so later events still go out (as the reference does).
    expect(client.rocaId).toBe(ROCA_ID);
  });
});

describe("trackPurchase", () => {
  it("with only productId sends no experimental key at all", async () => {
    const store = new FakeSecureStore({ [KEY]: ROCA_ID, "rocadata-install-tracked": "true" });
    const { client, http } = start(store);
    await client.trackPurchase({ isTrial: false, value: 9.99, currency: "EUR", originalTransactionIdentifier: "t-1", productId: "pro_monthly" });
    const body = http.requests[http.requests.length - 1].body as { properties: Record<string, unknown> };
    expect(body.properties).toEqual({
      is_trial: false,
      original_transaction_identifier: "t-1",
      product_id: "pro_monthly",
      price: 9.99,
      currency_code: "EUR",
    });
  });

  it("forwards only the raw objects it was given under experimental", async () => {
    const store = new FakeSecureStore({ [KEY]: ROCA_ID, "rocadata-install-tracked": "true" });
    const { client, http } = start(store);
    await client.trackPurchase({ isTrial: true, value: 0, currency: "EUR", originalTransactionIdentifier: "t-2", productId: "p", redemptionResult: { code: "abc" } });
    const body = http.requests[http.requests.length - 1].body as { properties: Record<string, unknown> };
    expect(body.properties.experimental).toEqual({ redemption_result: { code: "abc" } });
  });

  describe("purchaseType", () => {
    const PARAMS = { isTrial: false, value: 4.99, currency: "EUR", originalTransactionIdentifier: "t-3", productId: "p", transaction: { id: "x" } } as const;
    // The raw request body, as sent: recordingFetch parses it, which would hide key order and formatting.
    const purchaseBody = async (params: TrackPurchaseParams, onDiagnostic?: (d: Diagnostic) => void) => {
      const bodies: string[] = [];
      const http = recordingFetch();
      const fetch: FetchLike = async (url, init) => {
        if (new URL(url).pathname === "/functions/v1/track") bodies.push(init.body ?? "");
        return http.fetch(url, init);
      };
      const store = new FakeSecureStore({ [KEY]: ROCA_ID, "rocadata-install-tracked": "true" });
      const client = new RocalyticsClient({ modules: fakeModules(IOS, store), fetch, clock: { now: () => 0 }, onDiagnostic });
      await client.trackPurchase(params);
      return bodies[bodies.length - 1];
    };

    it("is sent as properties.purchase_type when set", async () => {
      const body = JSON.parse(await purchaseBody({ ...PARAMS, purchaseType: "upsell" }));
      expect(body.properties.purchase_type).toBe("upsell");
    });

    it("absent, the body is byte-identical to the one sent before the field existed", async () => {
      // Captured from 0.5.0's trackPurchase with these PARAMS.
      const V0_5_0 = '{"name":"purchase","deduplication_id":"6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f-purchase-t-3","properties":{"is_trial":false,"original_transaction_identifier":"t-3","product_id":"p","price":4.99,"currency_code":"EUR","experimental":{"transaction":{"id":"x"}}},"device_context":{"ip":"203.0.113.7","user_agent":"Example/2.4.0 (Apple iPhone 15 Pro; iOS 18.1; en-US)","device_model":"iPhone 15 Pro","device_brand":"Apple","device_manufacturer":"Apple","os_name":"iOS","os_version":"18.1","screen_width":393,"screen_height":852,"screen_scale":3,"timezone":"Europe/Paris","locale":"en-US","app_version":"2.4.0","app_build":"412"}}';
      expect(await purchaseBody({ ...PARAMS })).toBe(V0_5_0);
      expect(await purchaseBody({ ...PARAMS, purchaseType: undefined })).toBe(V0_5_0);
    });

    it("set, the body differs only by that one property", async () => {
      const without = JSON.parse(await purchaseBody({ ...PARAMS }));
      const withType = JSON.parse(await purchaseBody({ ...PARAMS, purchaseType: "upsell" }));
      expect(withType).toEqual({ ...without, properties: { ...without.properties, purchase_type: "upsell" } });
    });

    it("an unknown value is a type error, and at runtime is not sent but reported", async () => {
      const diagnostics: Diagnostic[] = [];
      const before = await purchaseBody({ ...PARAMS });
      // @ts-expect-error not a PurchaseType
      const body = await purchaseBody({ ...PARAMS, purchaseType: "renewal" }, (d) => diagnostics.push(d));
      expect(body).toBe(before);
      expect(diagnostics.map((d) => d.code)).toEqual(["unknown-purchase-type"]);
    });
  });
});

describe("console output with the default onDiagnostic", () => {
  it("a working client writes nothing to the console: no request, response or purchase property", async () => {
    const methods = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const http = recordingFetch();
    const client = new RocalyticsClient({ modules: fakeModules(IOS, new FakeSecureStore()), fetch: http.fetch });
    await client.ready;
    await client.trackPurchase({ isTrial: false, value: 9.99, currency: "EUR", originalTransactionIdentifier: "t-1", productId: "pro_monthly" });
    await client.trackOnboarding("welcome", { goal: "x" });
    await client.identify({ email: "user@example.com" });
    // identify, install, install ping, purchase, onboarding, identify.
    expect(http.requests).toHaveLength(6);
    for (const spy of methods) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("loadExpoModules", () => {
  const present = (names: string[]) => ({ requireOptionalNativeModule: (n: string) => (names.includes(n) ? {} : null) });
  const ALL = ["ExpoApplication", "ExpoCrypto", "ExpoDevice", "ExpoNetwork", "ExpoSecureStore"];
  const wrappers = () => {
    const required: string[] = [];
    const w = (name: string, value: unknown) => () => {
      required.push(name);
      return value;
    };
    return {
      required,
      loaders: {
        application: w("expo-application", { applicationId: "a" }),
        crypto: w("expo-crypto", {}),
        device: w("expo-device", {}),
        network: w("expo-network", {}),
        secureStore: w("expo-secure-store", {}),
        reactNative: w("react-native", { Platform: { OS: "ios", Version: "18" }, Dimensions: { get: () => ({}) } }),
      },
    };
  };

  it("probes every native module through the Expo registry before requiring any wrapper, and requires none if one is missing", () => {
    const { required, loaders } = wrappers();
    const result = loadExpoModules({ ...loaders, core: () => present(ALL.filter((n) => n !== "ExpoNetwork")) });
    expect(result).toEqual({ ok: false, reason: "native module ExpoNetwork is not in this binary" });
    expect(required).toEqual([]);
  });

  it("requires the wrappers once every native module is present", () => {
    const { required, loaders } = wrappers();
    const result = loadExpoModules({ ...loaders, core: () => present(ALL) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modules.application.applicationId).toBe("a");
      expect(result.modules.platform.OS).toBe("ios");
    }
    expect(required.sort()).toEqual(["expo-application", "expo-crypto", "expo-device", "expo-network", "expo-secure-store", "react-native"]);
  });

  it("returns the error instead of throwing when a wrapper throws at require time", () => {
    const { loaders } = wrappers();
    const result = loadExpoModules({
      ...loaders,
      core: () => present(ALL),
      secureStore: () => {
        throw new Error("Cannot find native module 'ExpoSecureStore'");
      },
    });
    expect(result).toEqual({ ok: false, reason: "Cannot find native module 'ExpoSecureStore'" });
  });
});
