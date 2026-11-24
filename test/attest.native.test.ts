import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadExpoModules, type AttestNativeModule, type ExpoModuleLoaders, type RocalyticsModules } from "../src/client/native";
import { secureStoreStorage, toAttestProvider } from "../src/client/attestProvider";

const ALL = ["ExpoApplication", "ExpoCrypto", "ExpoDevice", "ExpoNetwork", "ExpoSecureStore"];

function loaders(opts: { optional?: Record<string, unknown>; throwOn?: string } = {}): ExpoModuleLoaders {
  const core = {
    requireOptionalNativeModule: (name: string) => {
      if (name === opts.throwOn) throw new Error("boom");
      if (opts.optional && name in opts.optional) return opts.optional[name];
      return ALL.includes(name) ? {} : null;
    },
  };
  return {
    core: () => core,
    application: () => ({ applicationId: "a" }),
    crypto: () => ({}),
    device: () => ({}),
    network: () => ({}),
    secureStore: () => ({}),
    reactNative: () => ({ Platform: { OS: "ios", Version: "17" }, Dimensions: { get: () => ({ width: 1, height: 1, scale: 1 }) } }),
  };
}

describe("RocaAttest probe", () => {
  it("RocaAttest absent → modules.attest is null and loading still succeeds", () => {
    const result = loadExpoModules(loaders({ optional: { RocaAttest: null } }));
    expect(result).toMatchObject({ ok: true, modules: { attest: null } });
  });

  it("RocaAttest present → modules.attest is the object requireOptionalNativeModule returned", () => {
    const native = { isSupported: async () => true };
    const result = loadExpoModules(loaders({ optional: { RocaAttest: native } }));
    expect(result.ok && result.modules.attest).toBe(native);
  });

  it("requireOptionalNativeModule('RocaAttest') throwing → attest null, loading still succeeds", () => {
    const result = loadExpoModules(loaders({ throwOn: "RocaAttest" }));
    expect(result).toMatchObject({ ok: true, modules: { attest: null } });
  });

  it("RocaAttest is never in the required list: a binary without it is not inert", () => {
    const result = loadExpoModules(loaders());
    expect(result.ok).toBe(true);
  });

  it("no require of '@rocapine/rocalytics-attest' anywhere in src/", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const file of walk(join(__dirname, "..", "src"))) {
      expect(readFileSync(file, "utf8"), file).not.toContain("@rocapine/rocalytics-attest");
    }
  });
});

describe("toAttestProvider", () => {
  const full = (): AttestNativeModule & { calls: string[] } => {
    const self = {
      calls: [] as string[],
      token: "T",
      isSupported: async () => true,
      generateKey: async function (this: unknown) { return this === self ? "key" : "wrong-this"; },
      attestKey: async (k: string, b: string) => `att:${k}:${b}`,
      generateAssertion: async (k: string, b: string) => `ass:${k}:${b}`,
      getStoredKeyId: async () => null,
      setStoredKeyId: async () => undefined,
      prepare: async function (this: unknown, n: string) { self.calls.push(`prepare:${n}:${this === self}`); },
      requestToken: async (b: string) => `tok:${b}`,
    };
    return self;
  };

  it("exposes the iOS functions for 'ios' and the Android ones for 'android'; 'web' → null", async () => {
    const n = full();
    const ios = toAttestProvider(n, "ios");
    expect(ios?.platform).toBe("ios");
    if (ios?.platform === "ios") {
      expect(await ios.generateKey()).toBe("key");
      expect(await ios.attestKey("k", "b")).toBe("att:k:b");
      expect(await ios.generateAssertion("k", "b")).toBe("ass:k:b");
    }
    const android = toAttestProvider(n, "android");
    expect(android?.platform).toBe("android");
    if (android?.platform === "android") {
      await android.prepare("123");
      expect(await android.requestToken("b")).toBe("tok:b");
      expect(n.calls).toEqual(["prepare:123:true"]);
    }
    expect(toAttestProvider(n, "web")).toBeNull();
  });

  it("a missing function for the platform → null", () => {
    const n = full();
    delete n.generateAssertion;
    expect(toAttestProvider(n, "ios")).toBeNull();
    expect(toAttestProvider(n, "android")).not.toBeNull();
    const m = full();
    delete m.requestToken;
    expect(toAttestProvider(m, "android")).toBeNull();
    expect(toAttestProvider(m, "ios")).not.toBeNull();
  });
});

describe("secureStoreStorage", () => {
  it("removeItem writes '', getItem maps '' to null", async () => {
    const map = new Map<string, string>();
    const store: RocalyticsModules["secureStore"] = {
      getItemAsync: async (k) => map.get(k) ?? null,
      setItemAsync: vi.fn(async (k: string, v: string) => void map.set(k, v)),
    };
    const s = secureStoreStorage(store);
    expect(await s.getItem("k")).toBeNull();
    await s.setItem("k", "v");
    expect(await s.getItem("k")).toBe("v");
    await s.removeItem("k");
    expect(map.get("k")).toBe("");
    expect(await s.getItem("k")).toBeNull();
  });
});
