import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RocalyticsClient, loadExpoModules, type Diagnostic } from "../src/rocalytics";
import { FakeSecureStore, IOS, ROCA_ID, fakeModules, recordingFetch, stubIntl } from "./rocalytics.fakes";

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

function start(store: FakeSecureStore, device = IOS) {
  const http = recordingFetch();
  const diagnostics: Diagnostic[] = [];
  const client = new RocalyticsClient({ modules: fakeModules(device, store), fetch: http.fetch, onDiagnostic: (d) => diagnostics.push(d) });
  return { client, http, diagnostics };
}

describe("the roca id: migration from the misspelled key", () => {
  it("a fresh device mints an id and writes it under the corrected key only", async () => {
    const store = new FakeSecureStore();
    const { client } = start(store);
    await client.ready;
    expect(client.rocaId).toBe(ROCA_ID);
    expect(store.map.get(KEY)).toBe(ROCA_ID);
    expect(store.map.has(LEGACY_KEY)).toBe(false);
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
