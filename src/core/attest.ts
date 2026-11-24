// App attestation: types, binding string, token lifetime and classification of
// the API's and the native module's answers, and the token manager. Pure: no
// dependency; every I/O (provider, fetch, storage, clock, timers) is injected.

import { safeDiagnostics, type DiagnosticHandler } from "./diagnostics";
import type { KeyValueStorage } from "./storage";
import type { Clock, Timers } from "./time";

/** The string the native module hashes (SHA-256 of its UTF-8 bytes) to bind a proof to one challenge, app and install. */
export const bindingString = (challenge: string, appId: string, rocaId: string): string => `${challenge}|${appId}|${rocaId}`;

export type AttestPlatform = "ios" | "android";

/** What the native module gives the manager. Every function rejects with an Error whose `code` is `E_DC_<n>`, `E_PI_<NAME>` or `E_ATTEST_UNKNOWN`. */
export type AttestProvider =
  | {
      platform: "ios";
      isSupported(): Promise<boolean>;
      generateKey(): Promise<string>; // keyId, base64
      attestKey(keyId: string, binding: string): Promise<string>; // attestation object, base64
      generateAssertion(keyId: string, binding: string): Promise<string>; // assertion, base64
      getStoredKeyId(): Promise<string | null>;
      setStoredKeyId(keyId: string | null): Promise<void>;
    }
  | {
      platform: "android";
      isSupported(): Promise<boolean>;
      prepare(cloudProjectNumber: string): Promise<void>;
      requestToken(binding: string): Promise<string>; // integrity token (compact JWE)
    };

export type AttestState = "idle" | "fetching" | "valid" | "renewing" | "backoff" | "unsupported" | "rejected";

/** The token's lifetime in seconds (`exp − iat` from its payload, unverified), or null when it can't be read. */
export function readTokenLifetime(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    let b64 = (parts[1] as string).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    // The payload is JSON of ASCII claims; atob's latin1 string is enough.
    const payload: unknown = JSON.parse(atob(b64));
    if (typeof payload !== "object" || payload === null) return null;
    const { iat, exp } = payload as { iat?: unknown; exp?: unknown };
    if (typeof iat !== "number" || typeof exp !== "number" || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    const lifetime = exp - iat;
    return lifetime > 0 ? lifetime : null;
  } catch {
    return null;
  }
}

export type AttestResponseAction =
  | { action: "token"; token: string }
  | { action: "new_challenge" } // 400 invalid_challenge
  | { action: "new_key" } // 409 unknown_key
  | { action: "unsupported"; detail: string } // 400 unknown_app
  | { action: "rejected"; detail: string } // 400 bad_request, 401, any other 4xx, a 200 without a token
  | { action: "backoff"; detail: string }; // 5xx (503, 500), 429, network error (status 0)

const field = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;

export function classifyAttestResponse(status: number, body: unknown): AttestResponseAction {
  const error = field(body, "error");
  const reason = field(body, "reason");
  const detail = `${status}${typeof error === "string" ? ` ${error}` : ""}${typeof reason === "string" ? ` (${reason})` : ""}`;
  if (status === 200) {
    const token = field(body, "token");
    return typeof token === "string" && token !== "" ? { action: "token", token } : { action: "rejected", detail: "200 without a token" };
  }
  if (status === 400 && error === "invalid_challenge") return { action: "new_challenge" };
  if (status === 409 && error === "unknown_key") return { action: "new_key" };
  if (status === 400 && error === "unknown_app") return { action: "unsupported", detail };
  if (status === 0 || status === 429 || status >= 500) return { action: "backoff", detail: status === 0 ? "network error" : detail };
  return { action: "rejected", detail };
}

export type ProviderErrorAction = "unsupported" | "new_key" | "backoff" | "config" | "rejected";

const PROVIDER_ERRORS: Record<string, ProviderErrorAction> = {
  // DCError.Code: unknownSystemFailure 0, featureUnsupported 1, invalidInput 2, invalidKey 3, serverUnavailable 4.
  E_DC_0: "backoff",
  E_DC_1: "unsupported",
  E_DC_2: "config",
  E_DC_3: "new_key",
  E_DC_4: "backoff",
  // StandardIntegrityErrorCode.
  E_PI_API_NOT_AVAILABLE: "unsupported",
  E_PI_PLAY_STORE_NOT_FOUND: "unsupported",
  E_PI_PLAY_SERVICES_NOT_FOUND: "unsupported",
  E_PI_PLAY_STORE_ACCOUNT_NOT_FOUND: "unsupported",
  E_PI_PLAY_SERVICES_VERSION_OUTDATED: "unsupported",
  E_PI_PLAY_STORE_VERSION_OUTDATED: "unsupported",
  E_PI_NETWORK_ERROR: "backoff",
  E_PI_GOOGLE_SERVER_UNAVAILABLE: "backoff",
  E_PI_TOO_MANY_REQUESTS: "backoff",
  E_PI_INTERNAL_ERROR: "backoff",
  E_PI_INTEGRITY_TOKEN_PROVIDER_INVALID: "backoff", // the module already retried once
  E_PI_CLIENT_TRANSIENT_ERROR: "backoff",
  E_PI_CANNOT_BIND_TO_SERVICE: "backoff",
  E_PI_CLOUD_PROJECT_NUMBER_IS_INVALID: "config",
  E_PI_REQUEST_HASH_TOO_LONG: "config",
};

export function classifyProviderError(error: unknown): ProviderErrorAction {
  const code = field(error, "code");
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_ERRORS, code) ? (PROVIDER_ERRORS[code] as ProviderErrorAction) : "rejected";
}

export interface AttestFetch {
  (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }): Promise<{ status: number; json(): Promise<unknown> }>;
}

export interface AttestManagerOptions {
  provider: AttestProvider;
  appId: string;
  /** The current roca id, read on every getToken: a change (adoptRocaId) invalidates the cached token. */
  getRocaId(): string | null;
  /** `${baseUrl}/functions/v1/attest` */
  attestUrl: string;
  fetch: AttestFetch;
  storage: KeyValueStorage;
  clock: Clock;
  timers: Timers;
  appVersion?: string | null;
  cloudProjectNumber?: string; // Android; without it Android is unsupported
  onDiagnostic?: DiagnosticHandler;
}

/** A token and what it is bound to: the API checks these against the request's app id, platform and roca id. */
export interface AttestBinding {
  token: string;
  app_id: string;
  platform: AttestPlatform;
  roca_id: string;
}

export interface AttestTokenManager {
  /** A token valid for the current app, platform and roca id, or null. Resolves within `waitMs` (default 3000). Never throws. */
  getToken(waitMs?: number): Promise<string | null>;
  /** `getToken`, with the app id, platform and roca id the token is bound to. */
  getBinding(waitMs?: number): Promise<AttestBinding | null>;
  state(): AttestState;
}

export const ATTEST_TOKEN_KEY = "rocalytics.attest.token.v1";
export const RENEW_BEFORE_MS = 2 * 3600_000;
export const BACKOFF_MS = [30_000, 120_000, 600_000] as const;
/** A flight (challenge, native proof, POST) not settled by then counts as a backoff failure; whatever it lands later is ignored. */
export const FLIGHT_DEADLINE_MS = 30_000;

/** How long a request waits for a token when `attest.waitMs` is not set. */
export const DEFAULT_ATTEST_WAIT_MS = 3000;
/** The API's token lifetime (`exp = iat + 86400`): the bound for a token whose own lifetime can't be read. */
const MAX_LIFETIME_S = 86400;

interface TokenRecord {
  v: 1;
  token: string;
  app_id: string;
  platform: AttestPlatform;
  roca_id: string;
  local_expires_at: number;
}

type FlightOutcome = AttestResponseAction | { action: "config"; detail: string };

/** One attestation in progress. `abandoned`: a caller timed out waiting on it, so later callers do not wait. */
interface Flight {
  rocaId: string;
  renewing: boolean;
  abandoned: boolean;
  promise: Promise<string | null>;
}

const describeError = (error: unknown): string => {
  const code = field(error, "code");
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === "string" && code !== message ? `${code}: ${message}` : message;
};

export function createAttestTokenManager(options: AttestManagerOptions): AttestTokenManager {
  const { provider, appId, attestUrl, clock, timers, storage } = options;
  const platform = provider.platform;
  const report = safeDiagnostics(options.onDiagnostic);
  const appVersion = typeof options.appVersion === "string" && options.appVersion.length <= 32 ? options.appVersion : undefined;

  let record: TokenRecord | null = null;
  let terminal: "unsupported" | "rejected" | null = null;
  let flight: Flight | null = null;
  let backoffUntil: number | null = null;
  let backoffStep = 0;
  let supported: boolean | undefined;
  let prepared = false;
  let loaded: Promise<void> | null = null;

  const storageFailed = (what: string, error: unknown) =>
    report({ code: "attest-storage", message: `the attest token could not be ${what} ${ATTEST_TOKEN_KEY}, so it is kept in memory only: ${describeError(error)}` });

  /** The record, when it belongs to this app, platform and roca id and has time left (never more than a token's lifetime). */
  const usable = (rocaId: string): TokenRecord | null => {
    if (!record || record.app_id !== appId || record.platform !== platform || record.roca_id !== rocaId) return null;
    const left = record.local_expires_at - clock.now();
    const lifetime = readTokenLifetime(record.token) ?? MAX_LIFETIME_S;
    return left > 0 && left <= lifetime * 1000 ? record : null;
  };

  const parseRecord = (raw: string): TokenRecord | null => {
    try {
      const r = JSON.parse(raw) as Partial<TokenRecord> | null;
      if (!r || r.v !== 1 || typeof r.token !== "string" || r.token === "" || typeof r.roca_id !== "string" || typeof r.local_expires_at !== "number") return null;
      return r.app_id === appId && r.platform === platform ? (r as TokenRecord) : null;
    } catch {
      return null;
    }
  };

  const load = (): Promise<void> =>
    (loaded ??= (async () => {
      try {
        const raw = await storage.getItem(ATTEST_TOKEN_KEY);
        // A flight can't have landed before the load: every getToken awaits it first.
        if (typeof raw === "string") record = parseRecord(raw);
      } catch (error) {
        storageFailed("read from", error);
      }
    })());

  const persist = (r: TokenRecord) => {
    try {
      Promise.resolve(storage.setItem(ATTEST_TOKEN_KEY, JSON.stringify(r))).catch((error: unknown) => storageFailed("written to", error));
    } catch (error) {
      storageFailed("written to", error);
    }
  };

  const request = async (method: "GET" | "POST", url: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    try {
      const res =
        method === "GET"
          ? await options.fetch(url, { method, headers: {} })
          : await options.fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      return { status: res.status, body: json };
    } catch {
      return { status: 0, body: undefined };
    }
  };

  /**
   * One challenge, one proof, one POST. Null once `f` is no longer the
   * current flight (its deadline passed): it then sends and writes nothing more.
   */
  const attempt = async (f: Flight, freshKey: boolean): Promise<(FlightOutcome & { expiresAt?: unknown }) | null> => {
    const live = () => flight === f;
    const rocaId = f.rocaId;
    const ch = await request("GET", `${attestUrl}/challenge?app_id=${encodeURIComponent(appId)}&platform=${platform}`);
    if (!live()) return null;
    if (ch.status !== 200) return classifyAttestResponse(ch.status, ch.body);
    const challenge = field(ch.body, "challenge");
    if (typeof challenge !== "string" || challenge === "") return { action: "rejected", detail: "challenge 200 without a challenge" };
    const binding = bindingString(challenge, appId, rocaId);

    let body: Record<string, unknown>;
    let newKeyId: string | null = null;
    try {
      if (provider.platform === "ios") {
        const keyId = freshKey ? null : await provider.getStoredKeyId();
        if (!live()) return null;
        if (keyId) {
          body = { kind: "ios_assertion", app_id: appId, roca_id: rocaId, challenge, key_id: keyId, assertion: await provider.generateAssertion(keyId, binding) };
        } else {
          newKeyId = await provider.generateKey();
          if (!live()) return null;
          body = { kind: "ios_attestation", app_id: appId, roca_id: rocaId, challenge, key_id: newKeyId, attestation: await provider.attestKey(newKeyId, binding) };
        }
      } else {
        if (!prepared) {
          await provider.prepare(options.cloudProjectNumber as string);
          if (!live()) return null;
          prepared = true;
        }
        body = { kind: "android_integrity", app_id: appId, roca_id: rocaId, challenge, integrity_token: await provider.requestToken(binding) };
      }
    } catch (error) {
      if (!live()) return null;
      // Play Integrity asks for a new token provider: the next flight prepares again.
      if (provider.platform === "android" && field(error, "code") === "E_PI_INTEGRITY_TOKEN_PROVIDER_INVALID") prepared = false;
      const action = classifyProviderError(error);
      return action === "new_key" ? { action } : { action, detail: describeError(error) };
    }
    if (!live()) return null;
    if (appVersion !== undefined) body.app_version = appVersion;

    const res = await request("POST", attestUrl, body);
    if (!live()) return null;
    const outcome = classifyAttestResponse(res.status, res.body);
    if (outcome.action === "token" && newKeyId !== null && provider.platform === "ios") {
      try {
        await provider.setStoredKeyId(newKeyId);
      } catch {
        // The token is good; the next renewal attests a new key.
      }
      if (!live()) return null;
    }
    return { ...outcome, expiresAt: field(res.body, "expires_at") };
  };

  const stop = (state: "unsupported" | "rejected", code: string, message: string): null => {
    terminal = state;
    report({ code, message: `${message}; requests go out without an attest token for the rest of this session` });
    return null;
  };

  const backoff = (): null => {
    backoffUntil = clock.now() + BACKOFF_MS[Math.min(backoffStep, BACKOFF_MS.length - 1)];
    backoffStep++;
    return null;
  };

  const accept = (token: string, expiresAt: unknown, rocaId: string): string => {
    backoffUntil = null;
    backoffStep = 0;
    const now = clock.now();
    const lifetime = readTokenLifetime(token) ?? (typeof expiresAt === "number" ? Math.min(expiresAt - now / 1000, MAX_LIFETIME_S) : 0);
    if (lifetime > 0) {
      record = { v: 1, token, app_id: appId, platform, roca_id: rocaId, local_expires_at: now + lifetime * 1000 };
      persist(record);
    }
    return token;
  };

  /** Every state write below happens only while `f` is the current flight: a flight past its deadline changes nothing. */
  const fly = async (f: Flight): Promise<string | null> => {
    const live = () => flight === f;
    const rocaId = f.rocaId;
    if (provider.platform === "android" && !options.cloudProjectNumber)
      return stop("unsupported", "attest-config", "Android attestation needs attest.cloudProjectNumber");
    if (supported === undefined) {
      try {
        const answer = await provider.isSupported();
        if (!live()) return null;
        supported = answer;
      } catch (error) {
        if (!live()) return null;
        const action = classifyProviderError(error);
        if (action === "unsupported") return stop("unsupported", "attest-unsupported", `attestation is not available on this device: ${describeError(error)}`);
        if (action === "config") return stop("unsupported", "attest-config", `attestation is misconfigured: ${describeError(error)}`);
        if (action === "rejected") return stop("rejected", "attest-rejected", `attestation failed: ${describeError(error)}`);
        return backoff();
      }
    }
    if (!supported) return stop("unsupported", "attest-unsupported", "attestation is not available on this device");

    let newChallenge = false;
    let newKey = false;
    let freshKey = false;
    for (;;) {
      const outcome = await attempt(f, freshKey);
      if (!outcome || !live()) return null;
      switch (outcome.action) {
        case "token":
          return accept(outcome.token, outcome.expiresAt, rocaId);
        case "new_challenge":
          if (newChallenge) return backoff();
          newChallenge = true;
          break;
        case "new_key":
          if (newKey) return backoff();
          newKey = true;
          freshKey = true;
          if (provider.platform === "ios") {
            try {
              await provider.setStoredKeyId(null);
            } catch {
              // freshKey already skips the stored key for this flight.
            }
            if (!live()) return null;
          }
          break;
        case "unsupported":
          return stop("unsupported", "attest-unsupported", `attestation is not available: ${outcome.detail}`);
        case "config":
          return stop("unsupported", "attest-config", `attestation is misconfigured: ${outcome.detail}`);
        case "rejected":
          return stop("rejected", "attest-rejected", `attestation was rejected: ${outcome.detail}`);
        case "backoff":
          return backoff();
      }
    }
  };

  /**
   * A flight that has not settled within FLIGHT_DEADLINE_MS (a fetch or a
   * native call that never answers) counts as a backoff failure: it stops
   * being the current flight, and whatever it lands later is ignored.
   */
  const startFlight = (rocaId: string, renewing: boolean): Flight => {
    const f: Flight = { rocaId, renewing, abandoned: false, promise: Promise.resolve<string | null>(null) };
    flight = f;
    let expire: (value: null) => void = () => {};
    const expired = new Promise<null>((resolve) => (expire = resolve));
    let handle: unknown;
    try {
      handle = timers.setTimeout(() => {
        if (flight !== f) return;
        flight = null;
        report({ code: "attest-timeout", message: `the attestation did not finish within ${FLIGHT_DEADLINE_MS / 1000} s; it is retried after a backoff` });
        expire(backoff());
      }, FLIGHT_DEADLINE_MS);
    } catch {
      // no deadline: the flight still settles on its own
    }
    const settled = fly(f)
      .catch(() => (flight === f ? backoff() : null))
      .then((token) => {
        try {
          timers.clearTimeout(handle);
        } catch {
          // nothing to clear
        }
        if (flight === f) flight = null;
        return token;
      });
    f.promise = Promise.race([settled, expired]);
    return f;
  };

  const inBackoff = () => backoffUntil !== null && clock.now() < backoffUntil;

  const bound = (token: string, rocaId: string): AttestBinding => ({ token, app_id: appId, platform, roca_id: rocaId });

  /** `wait.flight`: the flight this call is waiting on, which its getBinding marks abandoned if it times out first. */
  const obtain = async (wait: { flight: Flight | null }): Promise<AttestBinding | null> => {
    await load();
    const rocaId = options.getRocaId();
    if (rocaId === null || terminal) return null;
    const cached = usable(rocaId);
    if (cached) {
      if (cached.local_expires_at - clock.now() <= RENEW_BEFORE_MS && !flight && !inBackoff()) startFlight(rocaId, true);
      return bound(cached.token, cached.roca_id);
    }
    // A caller already gave up on this flight: nobody waits on it again.
    if (flight?.abandoned) return null;
    if (flight && flight.rocaId !== rocaId) {
      // A flight for another roca id: its token is not ours. Wait for it, then decide again.
      wait.flight = flight;
      await flight.promise;
      wait.flight = null;
      return obtain(wait);
    }
    const f = flight ?? (inBackoff() ? null : startFlight(rocaId, false));
    if (!f) return null;
    wait.flight = f;
    const token = await f.promise;
    return token !== null && options.getRocaId() === f.rocaId ? bound(token, f.rocaId) : null;
  };

  const getBinding = (waitMs = DEFAULT_ATTEST_WAIT_MS): Promise<AttestBinding | null> =>
    new Promise<AttestBinding | null>((resolve) => {
      let settled = false;
      let handle: unknown;
      const wait: { flight: Flight | null } = { flight: null };
      const finish = (value: AttestBinding | null) => {
        if (settled) return;
        settled = true;
        try {
          timers.clearTimeout(handle);
        } catch {
          // nothing to clear
        }
        resolve(value);
      };
      try {
        handle = timers.setTimeout(() => {
          if (!settled && wait.flight) wait.flight.abandoned = true;
          finish(null);
        }, waitMs);
        obtain(wait).then(finish, () => finish(null));
      } catch {
        finish(null);
      }
    });

  return {
    getBinding,
    getToken: (waitMs?: number) => getBinding(waitMs).then((b) => b?.token ?? null),
    state() {
      if (terminal) return terminal;
      if (flight) return flight.renewing ? "renewing" : "fetching";
      if (inBackoff()) return "backoff";
      const rocaId = options.getRocaId();
      return rocaId !== null && usable(rocaId) ? "valid" : "idle";
    },
  };
}
