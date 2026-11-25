import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadExpoModules, type AttestNativeModule, type ExpoModuleLoaders, type RocalyticsModules } from "../src/client/native";
import { createHash } from "node:crypto";
import { ATTEST_KEY_ID_KEY, requestHashOf, secureStoreStorage, toAttestProvider } from "../src/client/attestProvider";
import { memoryStorage } from "../src/core";

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

describe("ExpoAppIntegrity probe", () => {
  it("ExpoAppIntegrity absent → modules.attest is null and loading still succeeds", () => {
    const result = loadExpoModules(loaders({ optional: { ExpoAppIntegrity: null } }));
    expect(result).toMatchObject({ ok: true, modules: { attest: null } });
  });

  it("ExpoAppIntegrity present → modules.attest is the object requireOptionalNativeModule returned", () => {
    const native = { isSupported: true };
    const result = loadExpoModules(loaders({ optional: { ExpoAppIntegrity: native } }));
    expect(result.ok && result.modules.attest).toBe(native);
  });

  it("requireOptionalNativeModule('ExpoAppIntegrity') throwing → attest null, loading still succeeds", () => {
    const result = loadExpoModules(loaders({ throwOn: "ExpoAppIntegrity" }));
    expect(result).toMatchObject({ ok: true, modules: { attest: null } });
  });

  it("ExpoAppIntegrity is never in the required list: a binary without it is not inert", () => {
    const result = loadExpoModules(loaders());
    expect(result.ok).toBe(true);
  });

  it("no import or require of '@expo/app-integrity' anywhere in src/: it is probed, never loaded", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const file of walk(join(__dirname, "..", "src"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/(?:from|require\()\s*["']@expo\/app-integrity["']/);
    }
  });
});

const sha256Crypto: Required<RocalyticsModules["crypto"]> = {
  randomUUID: () => "u",
  digestStringAsync: async (_a, data) => createHash("sha256").update(data, "utf8").digest("base64"),
};

describe("requestHashOf", () => {
  it("is SHA-256 of the binding's UTF-8 bytes, base64url without padding", async () => {
    const binding = "c|com.a|r1é";
    expect(await requestHashOf(sha256Crypto, binding)).toBe(createHash("sha256").update(binding, "utf8").digest("base64url"));
    expect(await requestHashOf(sha256Crypto, binding)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("toAttestProvider", () => {
  const codeError = (code: string) => Object.assign(new Error(code), { code });
  const full = () => {
    const calls: string[] = [];
    const self: AttestNativeModule & { failNext: string[] } = {
      failNext: [],
      isSupported: true,
      generateKeyAsync: async function (this: unknown) { return this === self ? "key" : "wrong-this"; },
      attestKeyAsync: async (k: string, b: string) => `att:${k}:${b}`,
      generateAssertionAsync: async (k: string, b: string) => `ass:${k}:${b}`,
      prepareIntegrityTokenProviderAsync: async function (this: unknown, n: string) { calls.push(`prepare:${n}:${this === self}`); },
      requestIntegrityCheckAsync: async (h: string) => {
        calls.push(`request:${h}`);
        const fail = self.failNext.shift();
        if (fail) throw codeError(fail);
        return "tok";
      },
    };
    return { native: self, calls };
  };
  const deps = () => ({ storage: memoryStorage(), crypto: sha256Crypto });
  const hash = (b: string) => createHash("sha256").update(b, "utf8").digest("base64url");

  it("iOS: forwards the binding as the challenge, keeps the key id in storage, reads isSupported", async () => {
    const { native } = full();
    const d = deps();
    const ios = toAttestProvider(native, "ios", d);
    if (ios?.platform !== "ios") throw new Error("expected ios");
    expect(await ios.isSupported()).toBe(true);
    expect(await ios.generateKey()).toBe("key");
    expect(await ios.attestKey("k", "b")).toBe("att:k:b");
    expect(await ios.generateAssertion("k", "b")).toBe("ass:k:b");
    expect(await ios.getStoredKeyId()).toBeNull();
    await ios.setStoredKeyId("K1");
    expect(await ios.getStoredKeyId()).toBe("K1");
    expect(await d.storage.getItem(ATTEST_KEY_ID_KEY)).toBe("K1");
    await ios.setStoredKeyId(null);
    expect(await ios.getStoredKeyId()).toBeNull();
    const unsupported = toAttestProvider({ ...native, isSupported: false }, "ios", d);
    expect(await unsupported?.isSupported()).toBe(false);
    const noFlag = toAttestProvider({ ...native, isSupported: undefined }, "ios", d);
    expect(await noFlag?.isSupported()).toBe(false);
  });

  it("Android: prepare passes the number through; requestToken sends the binding's request hash", async () => {
    const { native, calls } = full();
    const android = toAttestProvider(native, "android", deps());
    if (android?.platform !== "android") throw new Error("expected android");
    await android.prepare("123");
    expect(await android.requestToken("b")).toBe("tok");
    expect(calls).toEqual(["prepare:123:true", `request:${hash("b")}`]);
  });

  it("Android: ERR_APP_INTEGRITY_PROVIDER_INVALID → prepares again with the same number and retries once", async () => {
    const { native, calls } = full();
    const android = toAttestProvider(native, "android", deps());
    if (android?.platform !== "android") throw new Error("expected android");
    await android.prepare("123");
    native.failNext = ["ERR_APP_INTEGRITY_PROVIDER_INVALID"];
    expect(await android.requestToken("b")).toBe("tok");
    expect(calls).toEqual(["prepare:123:true", `request:${hash("b")}`, "prepare:123:true", `request:${hash("b")}`]);
    native.failNext = ["ERR_APP_INTEGRITY_PROVIDER_INVALID", "ERR_APP_INTEGRITY_PROVIDER_INVALID"];
    await expect(android.requestToken("b")).rejects.toMatchObject({ code: "ERR_APP_INTEGRITY_PROVIDER_INVALID" });
  });

  it("Android: any other error passes through without a retry", async () => {
    const { native, calls } = full();
    const android = toAttestProvider(native, "android", deps());
    if (android?.platform !== "android") throw new Error("expected android");
    await android.prepare("123");
    native.failNext = ["ERR_APP_INTEGRITY_NETWORK_ERROR"];
    await expect(android.requestToken("b")).rejects.toMatchObject({ code: "ERR_APP_INTEGRITY_NETWORK_ERROR" });
    expect(calls).toEqual(["prepare:123:true", `request:${hash("b")}`]);
  });

  it("'web' → null; a missing function for the platform → null", () => {
    const { native } = full();
    expect(toAttestProvider(native, "web", deps())).toBeNull();
    const n = { ...native, generateAssertionAsync: undefined };
    expect(toAttestProvider(n, "ios", deps())).toBeNull();
    expect(toAttestProvider(n, "android", deps())).not.toBeNull();
    const m = { ...native, requestIntegrityCheckAsync: undefined };
    expect(toAttestProvider(m, "android", deps())).toBeNull();
    expect(toAttestProvider(m, "ios", deps())).not.toBeNull();
    const noDigest = { storage: memoryStorage(), crypto: { randomUUID: () => "u" } };
    expect(toAttestProvider(native, "android", noDigest)).toBeNull();
    expect(toAttestProvider(native, "ios", noDigest)).not.toBeNull();
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
