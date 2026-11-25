import { beforeEach, describe, expect, it } from "vitest";
import {
  createAttestTokenManager,
  ATTEST_TOKEN_KEY,
  BACKOFF_MS,
  FLIGHT_DEADLINE_MS,
  RENEW_BEFORE_MS,
  type AttestManagerOptions,
  type AttestProvider,
} from "../src/core/attest";
import type { Diagnostic } from "../src/core/diagnostics";
import { memoryStorage, type KeyValueStorage } from "../src/core/storage";
import { ManualTime, flushMicrotasks } from "./fakes";

const URL_ = "https://api.test/functions/v1/attest";
const CHALLENGE_URL = `${URL_}/challenge?app_id=com.a&platform=ios`;
const jwt = (iat: number, ttl = 86400) => `e30.${Buffer.from(JSON.stringify({ iat, exp: iat + ttl })).toString("base64url")}.s`;
const HOUR = 3600_000;

type Answer = { status: number; body?: unknown; gate?: Promise<unknown> };
type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

const challenge = (c: string): Answer => ({ status: 200, body: { challenge: c, expires_at: 1 } });
const token = (t: string): Answer => ({ status: 200, body: { token: t, expires_at: 1 } });

/** Scripted API: answers in order (status 0 rejects like a network error); records every call. */
function scriptedFetch(answers: Answer[]) {
  const queue = [...answers];
  const calls: Call[] = [];
  const fetch = async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    const a = queue.shift();
    if (!a) throw new Error(`unscripted fetch ${init.method} ${url}`);
    if (a.gate) await a.gate;
    if (a.status === 0) throw new TypeError("Network request failed");
    return { status: a.status, json: async () => a.body };
  };
  return { fetch, calls, queue };
}

const providerError = (code: string) => Object.assign(new Error(code), { code });

/** Scripted iOS provider: records calls; `fail` maps a function name to an error code to reject with once. */
function iosProvider(o: { supported?: boolean; storedKeyId?: string | null; fail?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const fail = { ...o.fail };
  let stored = o.storedKeyId ?? null;
  let keys = 0;
  const step = async <T>(name: string, value: () => T): Promise<T> => {
    const code = fail[name];
    if (code) {
      delete fail[name];
      throw providerError(code);
    }
    return value();
  };
  const p = {
    platform: "ios" as const,
    calls,
    isSupported: () => (calls.push("isSupported"), step("isSupported", () => o.supported ?? true)),
    generateKey: () => (calls.push("generateKey"), step("generateKey", () => `K${++keys}`)),
    attestKey: (keyId: string, binding: string) => (calls.push(`attestKey:${keyId}:${binding}`), step("attestKey", () => "ATT")),
    generateAssertion: (keyId: string, binding: string) => (calls.push(`generateAssertion:${keyId}:${binding}`), step("generateAssertion", () => "ASR")),
    getStoredKeyId: () => (calls.push("getStoredKeyId"), step("getStoredKeyId", () => stored)),
    setStoredKeyId: (keyId: string | null) => (calls.push(`setStoredKeyId:${keyId}`), step("setStoredKeyId", () => void (stored = keyId))),
  };
  return p satisfies AttestProvider & { calls: string[] };
}

function androidProvider(o: { fail?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const fail = { ...o.fail };
  const step = async <T>(name: string, value: () => T): Promise<T> => {
    const code = fail[name];
    if (code) {
      delete fail[name];
      throw providerError(code);
    }
    return value();
  };
  const p = {
    platform: "android" as const,
    calls,
    isSupported: () => (calls.push("isSupported"), step("isSupported", () => true)),
    prepare: (n: string) => (calls.push(`prepare:${n}`), step("prepare", () => undefined)),
    requestToken: (binding: string) => (calls.push(`requestToken:${binding}`), step("requestToken", () => "INT")),
  };
  return p satisfies AttestProvider & { calls: string[] };
}

const sent = (calls: Call[], i: number) => JSON.parse(calls[i]!.init.body!) as Record<string, unknown>;
const POST = { method: "POST", headers: { "Content-Type": "application/json" } };
const GET = { method: "GET", headers: {} };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("attest token manager", () => {
  let time: ManualTime;
  let rocaId: string | null;
  let store: ReturnType<typeof memoryStorage>;
  let diags: Diagnostic[];
  beforeEach(() => {
    time = new ManualTime();
    rocaId = "r1";
    store = memoryStorage();
    diags = [];
  });
  const manager = (provider: AttestProvider, fetch: unknown, extra: Partial<AttestManagerOptions> = {}) =>
    createAttestTokenManager({
      provider,
      appId: "com.a",
      getRocaId: () => rocaId,
      attestUrl: URL_,
      fetch: fetch as never,
      storage: store,
      clock: time.clock,
      timers: time.timers,
      appVersion: "1.4.0",
      onDiagnostic: (d) => void diags.push(d),
      ...extra,
    });
  const stored = () => JSON.parse(store.dump()[ATTEST_TOKEN_KEY]!) as Record<string, unknown>;
  const record = (o: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, token: jwt(0), app_id: "com.a", platform: "ios", roca_id: "r1", local_expires_at: time.clock.now() + 10 * HOUR, ...o });

  it("exports the storage key, the renewal margin and the backoff steps", () => {
    expect(ATTEST_TOKEN_KEY).toBe("rocalytics.attest.token.v1");
    expect(RENEW_BEFORE_MS).toBe(2 * HOUR);
    expect(BACKOFF_MS).toEqual([30_000, 120_000, 600_000]);
  });

  it("first token on iOS: challenge, generateKey, attestKey, POST ios_attestation, keyId stored after the 200", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(0))]);
    const p = iosProvider();
    const m = manager(p, fetch);
    expect(m.state()).toBe("idle");
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ url: CHALLENGE_URL, init: GET });
    expect(calls[1]).toMatchObject({ url: URL_, init: POST });
    expect(sent(calls, 1)).toEqual({ kind: "ios_attestation", app_id: "com.a", roca_id: "r1", challenge: "c1", key_id: "K1", attestation: "ATT", app_version: "1.4.0" });
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateKey", "attestKey:K1:c1|com.a|r1", "setStoredKeyId:K1"]);
    expect(m.state()).toBe("valid");
    expect(stored()).toEqual({ v: 1, token: jwt(0), app_id: "com.a", platform: "ios", roca_id: "r1", local_expires_at: time.clock.now() + 86400_000 });
    expect(time.pendingTimers).toBe(0); // the wait timer is cleared when the flight wins
    expect(diags).toEqual([]);
  });

  it("the keyId is not stored when the attestation is not accepted", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), { status: 503, body: { error: "upstream_unavailable" } }]);
    const p = iosProvider();
    const m = manager(p, fetch);
    expect(await m.getToken()).toBeNull();
    expect(calls).toHaveLength(2);
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateKey", "attestKey:K1:c1|com.a|r1"]);
    expect(m.state()).toBe("backoff");
  });

  it("stored keyId → generateAssertion and ios_assertion, no generateKey", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(0))]);
    const p = iosProvider({ storedKeyId: "K9" });
    const m = manager(p, fetch);
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls.map((c) => c.url)).toEqual([CHALLENGE_URL, URL_]);
    expect(sent(calls, 1)).toEqual({ kind: "ios_assertion", app_id: "com.a", roca_id: "r1", challenge: "c1", key_id: "K9", assertion: "ASR", app_version: "1.4.0" });
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateAssertion:K9:c1|com.a|r1"]);
    expect(m.state()).toBe("valid");
  });

  it("cached token with more than 2 h left → returned, no fetch", async () => {
    // From storage (a previous launch): no request, no provider call.
    store.setItem(ATTEST_TOKEN_KEY, record({ local_expires_at: time.clock.now() + 2 * HOUR + 1 }));
    const { fetch, calls } = scriptedFetch([]);
    const p = iosProvider({ storedKeyId: "K9" });
    const m = manager(p, fetch);
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls).toEqual([]);
    expect(p.calls).toEqual([]);
    expect(m.state()).toBe("valid");
    expect(time.pendingTimers).toBe(0);

    // From memory, after a flight: 21 h later, 3 h left.
    const s2 = scriptedFetch([challenge("c1"), token(jwt(5))]);
    const m2 = manager(iosProvider({ storedKeyId: "K9" }), s2.fetch, { storage: memoryStorage() });
    expect(await m2.getToken()).toBe(jwt(5));
    await time.advance(21 * HOUR);
    expect(await m2.getToken()).toBe(jwt(5));
    expect(s2.calls).toHaveLength(2);
    expect(m2.state()).toBe("valid");
  });

  it("less than 2 h left → returned at once, renewal in the background; a failed renewal keeps it", async () => {
    const gate = deferred();
    const { fetch, calls } = scriptedFetch([
      challenge("c1"),
      token(jwt(0)),
      { ...challenge("c2"), gate: gate.promise },
      { status: 503, body: { error: "upstream_unavailable" } },
      challenge("c3"),
      token(jwt(100)),
    ]);
    const p = iosProvider();
    const m = manager(p, fetch);
    expect(await m.getToken()).toBe(jwt(0));
    await time.advance(23 * HOUR); // 1 h left

    expect(await m.getToken()).toBe(jwt(0)); // at once: the renewal's challenge is still pending
    expect(m.state()).toBe("renewing");
    expect(calls).toHaveLength(3);
    expect(await m.getToken()).toBe(jwt(0)); // joins nothing, starts nothing
    expect(calls).toHaveLength(3);

    gate.resolve();
    await flushMicrotasks();
    expect(calls).toHaveLength(4);
    expect(calls[2]!.url).toBe(CHALLENGE_URL);
    expect(sent(calls, 3)).toEqual({ kind: "ios_assertion", app_id: "com.a", roca_id: "r1", challenge: "c2", key_id: "K1", assertion: "ASR", app_version: "1.4.0" });
    expect(m.state()).toBe("backoff");
    expect(stored().token).toBe(jwt(0));

    await time.advance(10_000);
    expect(await m.getToken()).toBe(jwt(0)); // kept, and no new renewal inside the backoff
    expect(calls).toHaveLength(4);

    await time.advance(HOUR); // expired; the backoff is long over
    expect(await m.getToken()).toBe(jwt(100));
    expect(calls).toHaveLength(6);
    expect(p.calls).toEqual([
      "isSupported", "getStoredKeyId", "generateKey", "attestKey:K1:c1|com.a|r1", "setStoredKeyId:K1",
      "getStoredKeyId", "generateAssertion:K1:c2|com.a|r1",
      "getStoredKeyId", "generateAssertion:K1:c3|com.a|r1",
    ]);
    expect(m.state()).toBe("valid");
  });

  it("a successful renewal replaces the token and goes back to valid", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(0)), challenge("c2"), token(jwt(100))]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    expect(await m.getToken()).toBe(jwt(0));
    await time.advance(22 * HOUR + 1);
    expect(await m.getToken()).toBe(jwt(0));
    await flushMicrotasks();
    expect(calls).toHaveLength(4);
    expect(m.state()).toBe("valid");
    expect(await m.getToken()).toBe(jwt(100));
    expect(stored()).toMatchObject({ token: jwt(100), local_expires_at: time.clock.now() + 86400_000 });
  });

  it("roca id changed (adoptRocaId) → the cached token is never returned; a new flight binds the new roca id", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(0)), challenge("c2"), { status: 409, body: { error: "unknown_key" } }, challenge("c3"), token(jwt(100))]);
    const p = iosProvider();
    const m = manager(p, fetch);
    expect(await m.getToken()).toBe(jwt(0));
    rocaId = "r2";
    expect(m.state()).toBe("idle"); // the r1 token is not valid for r2
    expect(await m.getToken()).toBe(jwt(100));
    expect(calls).toHaveLength(6);
    expect(sent(calls, 3)).toEqual({ kind: "ios_assertion", app_id: "com.a", roca_id: "r2", challenge: "c2", key_id: "K1", assertion: "ASR", app_version: "1.4.0" });
    expect(sent(calls, 5)).toEqual({ kind: "ios_attestation", app_id: "com.a", roca_id: "r2", challenge: "c3", key_id: "K2", attestation: "ATT", app_version: "1.4.0" });
    expect(p.calls.slice(5)).toEqual(["getStoredKeyId", "generateAssertion:K1:c2|com.a|r2", "setStoredKeyId:null", "generateKey", "attestKey:K2:c3|com.a|r2", "setStoredKeyId:K2"]);
    expect(stored()).toMatchObject({ token: jwt(100), roca_id: "r2" });
    expect(m.state()).toBe("valid");
    rocaId = "r1";
    expect(m.state()).toBe("idle");
  });

  it("roca id changed during a flight → that flight's token is never returned for the new roca id", async () => {
    const gate = deferred();
    const { fetch, calls } = scriptedFetch([challenge("c1"), { ...token(jwt(0)), gate: gate.promise }, challenge("c2"), token(jwt(100))]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    const first = m.getToken(); // r1
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    rocaId = "r2";
    const second = m.getToken(); // r2: waits for the r1 flight, then its own
    gate.resolve();
    expect(await first).toBeNull(); // landed for r1, but the roca id is now r2
    expect(await second).toBe(jwt(100));
    expect(calls).toHaveLength(4);
    expect(sent(calls, 3)).toMatchObject({ roca_id: "r2", challenge: "c2" });
    expect(stored()).toMatchObject({ token: jwt(100), roca_id: "r2" });
  });

  it("getBinding: the token with the app id, platform and roca id it is bound to, from a flight and from the cache", async () => {
    const { fetch } = scriptedFetch([challenge("c1"), token(jwt(0)), challenge("c2"), token(jwt(100))]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    expect(await m.getBinding()).toEqual({ token: jwt(0), app_id: "com.a", platform: "ios", roca_id: "r1" });
    expect(await m.getBinding()).toEqual({ token: jwt(0), app_id: "com.a", platform: "ios", roca_id: "r1" });
    rocaId = "r2";
    expect(await m.getBinding()).toEqual({ token: jwt(100), app_id: "com.a", platform: "ios", roca_id: "r2" });
    rocaId = null;
    expect(await m.getBinding()).toBeNull();
  });

  it("getBinding resolves null within waitMs while the first attestation is pending", async () => {
    const gate = deferred();
    const { fetch } = scriptedFetch([{ ...challenge("c1"), gate: gate.promise }, token(jwt(0))]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    let result: unknown = "pending";
    void m.getBinding(500).then((b) => (result = b));
    await time.advance(499);
    expect(result).toBe("pending");
    await time.advance(1);
    expect(result).toBeNull();
    gate.resolve();
    await flushMicrotasks();
    expect(await m.getBinding(500)).toMatchObject({ token: jwt(0), roca_id: "r1" });
  });

  it("a cached record for another app or platform is ignored", async () => {
    for (const bad of [record({ app_id: "com.b" }), record({ platform: "android" }), record({ roca_id: "r0" }), record({ v: 2 }), "{not json", JSON.stringify({ v: 1 })]) {
      store = memoryStorage();
      store.setItem(ATTEST_TOKEN_KEY, bad);
      const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(100))]);
      const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
      expect(m.state()).toBe("idle");
      expect(await m.getToken()).toBe(jwt(100));
      expect(calls.map((c) => c.url)).toEqual([CHALLENGE_URL, URL_]);
      expect(stored()).toEqual({ v: 1, token: jwt(100), app_id: "com.a", platform: "ios", roca_id: "r1", local_expires_at: time.clock.now() + 86400_000 });
    }
  });

  it("device clock 3 days ahead: a fresh token stays valid for its lifetime, no renewal loop", async () => {
    const serverNow = Math.floor(time.clock.now() / 1000) - 3 * 86400;
    const t = jwt(serverNow);
    // expires_at (server time) is already in the device's past: it must not be what expiry is measured by.
    const { fetch, calls } = scriptedFetch([challenge("c1"), { status: 200, body: { token: t, expires_at: serverNow + 86400 } }, challenge("c2"), token(jwt(serverNow + 86400))]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    expect(await m.getToken()).toBe(t);
    expect(m.state()).toBe("valid");
    expect(stored().local_expires_at).toBe(time.clock.now() + 86400_000);
    for (let i = 0; i < 5; i++) expect(await m.getToken()).toBe(t);
    await time.advance(22 * HOUR - 60_000);
    expect(await m.getToken()).toBe(t);
    expect(calls).toHaveLength(2);
    expect(m.state()).toBe("valid");
    await time.advance(60_001); // now inside the last 2 h: one renewal
    expect(await m.getToken()).toBe(t);
    await flushMicrotasks();
    expect(calls).toHaveLength(4);
    expect(await m.getToken()).toBe(jwt(serverNow + 86400));
    expect(calls).toHaveLength(4);
  });

  it("device clock set back after receipt: a token is never trusted for longer than its lifetime", async () => {
    store.setItem(ATTEST_TOKEN_KEY, record({ local_expires_at: time.clock.now() + 30 * 86400_000 }));
    const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(100))]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    expect(await m.getToken()).toBe(jwt(100));
    expect(calls).toHaveLength(2);
  });

  it("a token whose lifetime can't be read uses expires_at − now, and is not cached when that is not positive", async () => {
    const nowS = time.clock.now() / 1000;
    const { fetch, calls } = scriptedFetch([challenge("c1"), { status: 200, body: { token: "opaque", expires_at: nowS + 3 * 3600 } }]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    expect(await m.getToken()).toBe("opaque");
    expect(stored()).toMatchObject({ token: "opaque", local_expires_at: time.clock.now() + 3 * HOUR });
    expect(await m.getToken()).toBe("opaque");
    expect(calls).toHaveLength(2);

    store = memoryStorage();
    const s2 = scriptedFetch([challenge("c1"), { status: 200, body: { token: "opaque", expires_at: nowS - 10 } }, challenge("c2"), token(jwt(0))]);
    const m2 = manager(iosProvider({ storedKeyId: "K9" }), s2.fetch);
    expect(await m2.getToken()).toBe("opaque"); // handed to the waiting callers
    expect(store.dump()).toEqual({}); // but not cached
    expect(await m2.getToken()).toBe(jwt(0));
    expect(s2.calls).toHaveLength(4);
  });

  it("ten concurrent getToken() → one challenge, one proof, one POST", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(0))]);
    const p = iosProvider();
    const m = manager(p, fetch);
    const results = await Promise.all(Array.from({ length: 10 }, () => m.getToken()));
    expect(results).toEqual(Array(10).fill(jwt(0)));
    expect(calls.map((c) => c.url)).toEqual([CHALLENGE_URL, URL_]);
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateKey", "attestKey:K1:c1|com.a|r1", "setStoredKeyId:K1"]);
    expect(time.pendingTimers).toBe(0);
    expect(m.state()).toBe("valid");
  });

  it("409 unknown_key → keyId cleared, one retry with a new key, then a token", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), { status: 409, body: { error: "unknown_key" } }, challenge("c2"), token(jwt(0))]);
    const p = iosProvider({ storedKeyId: "K9" });
    const m = manager(p, fetch);
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls.map((c) => c.url)).toEqual([CHALLENGE_URL, URL_, CHALLENGE_URL, URL_]);
    expect(sent(calls, 1)).toMatchObject({ kind: "ios_assertion", key_id: "K9", challenge: "c1" });
    expect(sent(calls, 3)).toEqual({ kind: "ios_attestation", app_id: "com.a", roca_id: "r1", challenge: "c2", key_id: "K1", attestation: "ATT", app_version: "1.4.0" });
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateAssertion:K9:c1|com.a|r1", "setStoredKeyId:null", "generateKey", "attestKey:K1:c2|com.a|r1", "setStoredKeyId:K1"]);
    expect(m.state()).toBe("valid");
  });

  it("409 twice in one flight → no third attempt; backoff", async () => {
    const unknownKey = { status: 409, body: { error: "unknown_key" } };
    const { fetch, calls } = scriptedFetch([challenge("c1"), unknownKey, challenge("c2"), unknownKey]);
    const p = iosProvider({ storedKeyId: "K9" });
    const m = manager(p, fetch);
    expect(await m.getToken()).toBeNull();
    expect(calls).toHaveLength(4);
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateAssertion:K9:c1|com.a|r1", "setStoredKeyId:null", "generateKey", "attestKey:K1:c2|com.a|r1"]);
    expect(m.state()).toBe("backoff");
    expect(await m.getToken()).toBeNull();
    expect(calls).toHaveLength(4);
    expect(diags).toEqual([]);
  });

  it("400 invalid_challenge → one retry with a new challenge", async () => {
    const invalid = { status: 400, body: { error: "invalid_challenge" } };
    const { fetch, calls } = scriptedFetch([challenge("c1"), invalid, challenge("c2"), token(jwt(0))]);
    const p = iosProvider({ storedKeyId: "K9" });
    const m = manager(p, fetch);
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls.map((c) => c.url)).toEqual([CHALLENGE_URL, URL_, CHALLENGE_URL, URL_]);
    expect(sent(calls, 1)).toMatchObject({ kind: "ios_assertion", challenge: "c1" });
    expect(sent(calls, 3)).toMatchObject({ kind: "ios_assertion", challenge: "c2", key_id: "K9" });
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateAssertion:K9:c1|com.a|r1", "getStoredKeyId", "generateAssertion:K9:c2|com.a|r1"]);
    expect(m.state()).toBe("valid");

    // Twice in one flight → backoff, no third attempt.
    const s2 = scriptedFetch([challenge("c1"), invalid, challenge("c2"), invalid]);
    const m2 = manager(iosProvider({ storedKeyId: "K9" }), s2.fetch, { storage: memoryStorage() });
    expect(await m2.getToken()).toBeNull();
    expect(s2.calls).toHaveLength(4);
    expect(m2.state()).toBe("backoff");
  });

  it("400 unknown_app → unsupported for the session, no further request", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 400, body: { error: "unknown_app" } }]);
    const p = iosProvider();
    const m = manager(p, fetch);
    expect(await m.getToken()).toBeNull();
    expect(calls).toEqual([{ url: CHALLENGE_URL, init: GET }]);
    expect(p.calls).toEqual(["isSupported"]);
    expect(m.state()).toBe("unsupported");
    expect(diags).toEqual([{ code: "attest-unsupported", message: expect.stringContaining("unknown_app") }]);
    await time.advance(86400_000);
    expect(await m.getToken()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(diags).toHaveLength(1);
  });

  it("401 attestation_failed → rejected for the session, diagnostic carries the reason, no retry", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), { status: 401, body: { error: "attestation_failed", reason: "wrong_app" } }]);
    const p = iosProvider();
    const m = manager(p, fetch);
    expect(await m.getToken()).toBeNull();
    expect(calls.map((c) => c.url)).toEqual([CHALLENGE_URL, URL_]);
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateKey", "attestKey:K1:c1|com.a|r1"]);
    expect(m.state()).toBe("rejected");
    expect(diags).toEqual([{ code: "attest-rejected", message: expect.stringContaining("401 attestation_failed (wrong_app)") }]);
    await time.advance(86400_000);
    expect(await m.getToken()).toBeNull();
    expect(calls).toHaveLength(2);
    expect(store.dump()).toEqual({});
  });

  it("503, 500, network error → backoff 30 s, 2 min, 10 min, 10 min; keyId kept", async () => {
    const { fetch, calls } = scriptedFetch([
      challenge("c1"), { status: 503, body: { error: "upstream_unavailable" } },
      challenge("c2"), { status: 500, body: { error: "internal_error" } },
      { status: 0 },
      challenge("c4"), { status: 503 },
      challenge("c5"), token(jwt(0)),
    ]);
    const p = iosProvider({ storedKeyId: "K9" });
    const m = manager(p, fetch);
    const expectBackoff = async (ms: number, count: number) => {
      expect(m.state()).toBe("backoff");
      await time.advance(ms - 1);
      expect(await m.getToken()).toBeNull(); // at once, no request
      expect(calls).toHaveLength(count);
      expect(time.pendingTimers).toBe(0);
      await time.advance(1);
    };
    expect(await m.getToken()).toBeNull();
    await expectBackoff(30_000, 2);
    expect(await m.getToken()).toBeNull();
    await expectBackoff(120_000, 4);
    expect(await m.getToken()).toBeNull(); // network error on the challenge
    await expectBackoff(600_000, 5);
    expect(await m.getToken()).toBeNull();
    await expectBackoff(600_000, 7);
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls).toHaveLength(9);
    expect(p.calls.filter((c) => c.startsWith("setStoredKeyId") || c === "generateKey")).toEqual([]);
    expect(p.calls.filter((c) => c.startsWith("generateAssertion:K9"))).toHaveLength(4);
    expect(m.state()).toBe("valid");
    expect(diags).toEqual([]);
  });

  it("a token resets the backoff steps", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), { status: 503 }, challenge("c2"), token(jwt(0)), challenge("c3"), { status: 503 }, challenge("c4"), token(jwt(100))]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    expect(await m.getToken()).toBeNull();
    await time.advance(BACKOFF_MS[0]);
    expect(await m.getToken()).toBe(jwt(0));
    await time.advance(86400_000);
    expect(await m.getToken()).toBeNull();
    await time.advance(BACKOFF_MS[0]); // 30 s again, not 2 min
    expect(await m.getToken()).toBe(jwt(100));
    expect(calls).toHaveLength(8);
  });

  it("E_DC_3 invalidKey from generateAssertion → keyId cleared, new key attested once", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), challenge("c2"), token(jwt(0))]);
    const p = iosProvider({ storedKeyId: "K9", fail: { generateAssertion: "E_DC_3" } });
    const m = manager(p, fetch);
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls.map((c) => c.url)).toEqual([CHALLENGE_URL, CHALLENGE_URL, URL_]);
    expect(sent(calls, 2)).toEqual({ kind: "ios_attestation", app_id: "com.a", roca_id: "r1", challenge: "c2", key_id: "K1", attestation: "ATT", app_version: "1.4.0" });
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateAssertion:K9:c1|com.a|r1", "setStoredKeyId:null", "generateKey", "attestKey:K1:c2|com.a|r1", "setStoredKeyId:K1"]);

    // The new key invalid too → backoff, not a loop.
    const s2 = scriptedFetch([challenge("c1"), challenge("c2")]);
    const p2 = iosProvider({ storedKeyId: "K9", fail: { generateAssertion: "E_DC_3", attestKey: "E_DC_3" } });
    const m2 = manager(p2, s2.fetch, { storage: memoryStorage() });
    expect(await m2.getToken()).toBeNull();
    expect(s2.calls).toHaveLength(2);
    expect(p2.calls).toEqual(["isSupported", "getStoredKeyId", "generateAssertion:K9:c1|com.a|r1", "setStoredKeyId:null", "generateKey", "attestKey:K1:c2|com.a|r1"]);
    expect(m2.state()).toBe("backoff");
  });

  it("E_DC_1 / isSupported false → unsupported with no request", async () => {
    for (const p of [iosProvider({ supported: false }), iosProvider({ fail: { isSupported: "E_DC_1" } })]) {
      diags = [];
      const { fetch, calls } = scriptedFetch([]);
      const m = manager(p, fetch);
      expect(await m.getToken()).toBeNull();
      expect(calls).toEqual([]);
      expect(p.calls).toEqual(["isSupported"]);
      expect(m.state()).toBe("unsupported");
      expect(diags).toEqual([{ code: "attest-unsupported", message: expect.any(String) }]);
      expect(await m.getToken()).toBeNull();
      expect(p.calls).toEqual(["isSupported"]);
    }
    // E_DC_1 from generateKey: unsupported after the challenge, no POST.
    const { fetch, calls } = scriptedFetch([challenge("c1")]);
    const p = iosProvider({ fail: { generateKey: "E_DC_1" } });
    const m = manager(p, fetch);
    expect(await m.getToken()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(m.state()).toBe("unsupported");
  });

  it("E_DC_4 → backoff", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1")]);
    const p = iosProvider({ fail: { attestKey: "E_DC_4" } });
    const m = manager(p, fetch);
    expect(await m.getToken()).toBeNull();
    expect(calls).toEqual([{ url: CHALLENGE_URL, init: GET }]);
    expect(p.calls).toEqual(["isSupported", "getStoredKeyId", "generateKey", "attestKey:K1:c1|com.a|r1"]);
    expect(m.state()).toBe("backoff");
    expect(diags).toEqual([]);
  });

  it("an unknown provider error → rejected with its code", async () => {
    const { fetch } = scriptedFetch([challenge("c1")]);
    const m = manager(iosProvider({ fail: { generateKey: "E_ATTEST_UNKNOWN" } }), fetch);
    expect(await m.getToken()).toBeNull();
    expect(m.state()).toBe("rejected");
    expect(diags).toEqual([{ code: "attest-rejected", message: expect.stringContaining("E_ATTEST_UNKNOWN") }]);
  });

  it("a provider that never resolves → getToken(3000) is null after 3 s; the token is returned by a later call once it lands", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(0))]);
    const p = iosProvider();
    const hold = deferred<string>();
    const attestKey = p.attestKey;
    p.attestKey = (k, b) => (attestKey(k, b), hold.promise);
    const m = manager(p, fetch);

    let first: string | null | undefined;
    void m.getToken(3000).then((v) => (first = v));
    await time.advance(2999);
    expect(first).toBeUndefined();
    expect(m.state()).toBe("fetching");
    await time.advance(1);
    expect(first).toBeNull();
    expect(time.pendingTimers).toBe(1); // only the flight's deadline

    let second: string | null | undefined;
    void m.getToken(1000).then((v) => (second = v)); // joins the same flight, which a caller already gave up on
    await flushMicrotasks();
    expect(second).toBeNull(); // at once
    expect(calls).toHaveLength(1);
    expect(p.calls.filter((c) => c === "generateKey")).toHaveLength(1);

    hold.resolve("ATT"); // lands before FLIGHT_DEADLINE_MS
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    expect(m.state()).toBe("valid");
    expect(stored().token).toBe(jwt(0));
    expect(time.pendingTimers).toBe(0);
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls).toHaveLength(2);
  });

  it("a flight that never settles → backoff after FLIGHT_DEADLINE_MS, then a new flight; the hung flight's late result is ignored", async () => {
    expect(FLIGHT_DEADLINE_MS).toBe(30_000);
    const { fetch, calls } = scriptedFetch([challenge("c1"), challenge("c2"), token(jwt(100))]);
    const p = iosProvider({ storedKeyId: "K9" });
    const hold = deferred<string>();
    const generateAssertion = p.generateAssertion;
    let n = 0;
    p.generateAssertion = (k, b) => (generateAssertion(k, b), ++n === 1 ? hold.promise : Promise.resolve("ASR"));
    const m = manager(p, fetch);

    let first: string | null | undefined;
    void m.getToken(3000).then((v) => (first = v));
    await time.advance(3000);
    expect(first).toBeNull();
    let second: string | null | undefined;
    void m.getToken(3000).then((v) => (second = v));
    await flushMicrotasks();
    expect(second).toBeNull(); // at once, no second 3 s wait

    await time.advance(FLIGHT_DEADLINE_MS - 3000 - 1);
    expect(m.state()).toBe("fetching");
    await time.advance(1);
    expect(m.state()).toBe("backoff");
    expect(diags).toEqual([{ code: "attest-timeout", message: expect.stringContaining("30 s") }]);
    expect(time.pendingTimers).toBe(0);
    expect(await m.getToken()).toBeNull(); // inside the backoff: no request
    expect(calls).toHaveLength(1);

    await time.advance(BACKOFF_MS[0]);
    expect(await m.getToken()).toBe(jwt(100)); // a new flight
    expect(calls).toHaveLength(3);
    expect(m.state()).toBe("valid");

    hold.resolve("ASR"); // the hung flight lands late
    await flushMicrotasks();
    expect(calls).toHaveLength(3); // it sends nothing
    expect(m.state()).toBe("valid");
    expect(stored().token).toBe(jwt(100));
    expect(time.pendingTimers).toBe(0);
  });

  it("a hung flight's late token is not stored, and does not reset the backoff", async () => {
    const gate = deferred();
    const { fetch, calls } = scriptedFetch([challenge("c1"), { ...token(jwt(0)), gate: gate.promise }, challenge("c2"), { status: 503 }]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    void m.getToken(100);
    await time.advance(FLIGHT_DEADLINE_MS);
    expect(m.state()).toBe("backoff");

    gate.resolve(); // the 200 lands after the deadline
    await flushMicrotasks();
    expect(store.dump()[ATTEST_TOKEN_KEY]).toBeUndefined();
    expect(m.state()).toBe("backoff");
    expect(await m.getToken()).toBeNull();
    expect(calls).toHaveLength(2);

    await time.advance(BACKOFF_MS[0]);
    expect(await m.getToken()).toBeNull(); // 503
    expect(calls).toHaveLength(4);
    await time.advance(BACKOFF_MS[0]);
    expect(m.state()).toBe("backoff"); // the second step (2 min): the late token reset nothing
    await time.advance(BACKOFF_MS[1] - BACKOFF_MS[0]);
    expect(m.state()).toBe("idle");
    expect(time.pendingTimers).toBe(0);
  });

  it("state() is backoff only inside the backoff window", async () => {
    const { fetch } = scriptedFetch([challenge("c1"), { status: 503 }]);
    const m = manager(iosProvider({ storedKeyId: "K9" }), fetch);
    expect(await m.getToken()).toBeNull();
    expect(m.state()).toBe("backoff");
    await time.advance(BACKOFF_MS[0] - 1);
    expect(m.state()).toBe("backoff");
    await time.advance(1);
    expect(m.state()).toBe("idle");
  });

  it("Android: prepare(cloudProjectNumber) once, then requestToken; body android_integrity", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(0)), challenge("c2"), token(jwt(100))]);
    const p = androidProvider();
    const m = manager(p, fetch, { cloudProjectNumber: "123" });
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls[0]).toEqual({ url: `${URL_}/challenge?app_id=com.a&platform=android`, init: GET });
    expect(calls[1]).toMatchObject({ url: URL_, init: POST });
    expect(sent(calls, 1)).toEqual({ kind: "android_integrity", app_id: "com.a", roca_id: "r1", challenge: "c1", integrity_token: "INT", app_version: "1.4.0" });
    expect(stored()).toMatchObject({ platform: "android", roca_id: "r1" });
    rocaId = "r2";
    expect(await m.getToken()).toBe(jwt(100));
    expect(sent(calls, 3)).toMatchObject({ kind: "android_integrity", roca_id: "r2", challenge: "c2" });
    expect(p.calls).toEqual(["isSupported", "prepare:123", "requestToken:c1|com.a|r1", "requestToken:c2|com.a|r2"]);
    expect(m.state()).toBe("valid");
  });

  it("Android: a prepare that fails transiently is retried on the next flight", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1"), challenge("c2"), token(jwt(0))]);
    const p = androidProvider({ fail: { prepare: "E_PI_CLIENT_TRANSIENT_ERROR" } });
    const m = manager(p, fetch, { cloudProjectNumber: "123" });
    expect(await m.getToken()).toBeNull();
    expect(m.state()).toBe("backoff");
    await time.advance(BACKOFF_MS[0]);
    expect(await m.getToken()).toBe(jwt(0));
    expect(calls).toHaveLength(3);
    expect(p.calls).toEqual(["isSupported", "prepare:123", "prepare:123", "requestToken:c2|com.a|r1"]);
  });

  it("Android: E_PI_INTEGRITY_TOKEN_PROVIDER_INVALID → backoff, and the next flight calls prepare again", async () => {
    const { fetch } = scriptedFetch([challenge("c1"), challenge("c2"), token(jwt(0))]);
    const p = androidProvider({ fail: { requestToken: "E_PI_INTEGRITY_TOKEN_PROVIDER_INVALID" } });
    const m = manager(p, fetch, { cloudProjectNumber: "123" });
    expect(await m.getToken()).toBeNull();
    expect(m.state()).toBe("backoff");
    await time.advance(BACKOFF_MS[0]);
    expect(await m.getToken()).toBe(jwt(0));
    expect(p.calls).toEqual(["isSupported", "prepare:123", "requestToken:c1|com.a|r1", "prepare:123", "requestToken:c2|com.a|r1"]);
  });

  it("Android without cloudProjectNumber → unsupported, diagnostic attest-config, no request", async () => {
    const { fetch, calls } = scriptedFetch([]);
    const p = androidProvider();
    const m = manager(p, fetch);
    expect(await m.getToken()).toBeNull();
    expect(calls).toEqual([]);
    expect(p.calls).toEqual([]);
    expect(m.state()).toBe("unsupported");
    expect(diags).toEqual([{ code: "attest-config", message: expect.stringContaining("cloudProjectNumber") }]);
  });

  it("E_PI_CLOUD_PROJECT_NUMBER_IS_INVALID → unsupported with attest-config", async () => {
    const { fetch, calls } = scriptedFetch([challenge("c1")]);
    const p = androidProvider({ fail: { prepare: "E_PI_CLOUD_PROJECT_NUMBER_IS_INVALID" } });
    const m = manager(p, fetch, { cloudProjectNumber: "999" });
    expect(await m.getToken()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(p.calls).toEqual(["isSupported", "prepare:999"]);
    expect(m.state()).toBe("unsupported");
    expect(diags).toEqual([{ code: "attest-config", message: expect.stringContaining("E_PI_CLOUD_PROJECT_NUMBER_IS_INVALID") }]);
    expect(await m.getToken()).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("app_version longer than 32 chars or null → omitted from the body", async () => {
    for (const [appVersion, expected] of [["x".repeat(33), undefined], [null, undefined], [undefined, undefined], ["y".repeat(32), "y".repeat(32)]] as const) {
      store = memoryStorage();
      const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(0))]);
      const m = manager(androidProvider(), fetch, { cloudProjectNumber: "1", appVersion });
      expect(await m.getToken()).toBe(jwt(0));
      const body = sent(calls, 1);
      expect(body.app_version).toBe(expected);
      expect("app_version" in body).toBe(expected !== undefined);
    }
  });

  it("getRocaId() null → null, no request", async () => {
    rocaId = null;
    const { fetch, calls } = scriptedFetch([]);
    const p = iosProvider();
    const m = manager(p, fetch);
    expect(await m.getToken()).toBeNull();
    expect(calls).toEqual([]);
    expect(p.calls).toEqual([]);
    expect(m.state()).toBe("idle");
    expect(time.pendingTimers).toBe(0);
  });

  it("a storage read or write that throws → still returns the token (memory only), never throws", async () => {
    const throwing: KeyValueStorage[] = [
      { getItem: () => { throw new Error("read"); }, setItem: () => { throw new Error("write"); }, removeItem: () => undefined },
      { getItem: () => Promise.reject(new Error("read")), setItem: () => Promise.reject(new Error("write")), removeItem: () => undefined },
    ];
    for (const storage of throwing) {
      const { fetch, calls } = scriptedFetch([challenge("c1"), token(jwt(0))]);
      const p = iosProvider();
      // A diagnostic handler that throws too.
      const m = manager(p, fetch, { storage, onDiagnostic: () => { throw new Error("handler"); } });
      expect(await m.getToken()).toBe(jwt(0));
      await flushMicrotasks();
      expect(await m.getToken()).toBe(jwt(0)); // from memory
      expect(calls).toHaveLength(2);
      expect(m.state()).toBe("valid");
    }
  });

  it("storage failures are reported as attest-storage", async () => {
    const storage: KeyValueStorage = { getItem: () => Promise.reject(new Error("read")), setItem: () => Promise.reject(new Error("write")), removeItem: () => undefined };
    const { fetch } = scriptedFetch([challenge("c1"), token(jwt(0))]);
    const m = manager(iosProvider(), fetch, { storage });
    expect(await m.getToken()).toBe(jwt(0));
    await flushMicrotasks();
    expect(diags).toEqual([
      { code: "attest-storage", message: expect.stringContaining("read") },
      { code: "attest-storage", message: expect.stringContaining("write") },
    ]);
  });

  it("a fetch whose json() throws, and a challenge 200 without a challenge, never throw", async () => {
    const fetch = async () => ({ status: 503, json: async () => { throw new SyntaxError("bad json"); } });
    const m = manager(iosProvider(), fetch);
    expect(await m.getToken()).toBeNull();
    expect(m.state()).toBe("backoff");

    const s2 = scriptedFetch([{ status: 200, body: { nope: 1 } }]);
    const m2 = manager(iosProvider(), s2.fetch);
    expect(await m2.getToken()).toBeNull();
    expect(m2.state()).toBe("rejected");
    expect(diags).toEqual([{ code: "attest-rejected", message: expect.stringContaining("challenge") }]);
  });
});
