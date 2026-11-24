// App attestation: types, binding string, token lifetime and classification of
// the API's and the native module's answers. Pure: no dependency, no I/O.

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
  E_PI_CLOUD_PROJECT_NUMBER_IS_INVALID: "config",
};

export function classifyProviderError(error: unknown): ProviderErrorAction {
  const code = field(error, "code");
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_ERRORS, code) ? (PROVIDER_ERRORS[code] as ProviderErrorAction) : "rejected";
}
