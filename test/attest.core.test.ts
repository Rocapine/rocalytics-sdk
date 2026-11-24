import { describe, expect, it } from "vitest";
import { bindingString, classifyAttestResponse, classifyProviderError, readTokenLifetime } from "../src/core/attest";

const jwt = (payload: object) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

describe("bindingString", () => {
  it("joins challenge, app id and roca id with |", () =>
    expect(bindingString("q7Tz", "com.rocapine.thatgirl", "3f1c")).toBe("q7Tz|com.rocapine.thatgirl|3f1c"));
});

describe("readTokenLifetime", () => {
  it("is exp − iat", () => expect(readTokenLifetime(jwt({ iat: 1795430411, exp: 1795516811 }))).toBe(86400));
  it("is null for a token that isn't three segments, isn't JSON, or lacks iat/exp", () => {
    for (const t of ["abc", "a.b", "e30.bm90LWpzb24.s", jwt({ exp: 5 }), jwt({ iat: 5, exp: 4 })]) expect(readTokenLifetime(t)).toBeNull();
  });
});

describe("classifyAttestResponse", () => {
  it.each([
    [200, { token: "t", expires_at: 1 }, { action: "token", token: "t" }],
    [200, {}, { action: "rejected" }],
    [400, { error: "invalid_challenge" }, { action: "new_challenge" }],
    [409, { error: "unknown_key" }, { action: "new_key" }],
    [400, { error: "unknown_app" }, { action: "unsupported" }],
    [400, { error: "bad_request" }, { action: "rejected" }],
    [401, { error: "attestation_failed", reason: "wrong_app" }, { action: "rejected" }],
    [503, { error: "upstream_unavailable" }, { action: "backoff" }],
    [500, undefined, { action: "backoff" }],
    [429, undefined, { action: "backoff" }],
    [0, undefined, { action: "backoff" }],
  ])("%i %j", (status, body, expected) => expect(classifyAttestResponse(status, body)).toMatchObject(expected));
});

describe("classifyProviderError", () => {
  const err = (code?: string) => Object.assign(new Error("x"), code ? { code } : {});
  it.each([
    ["E_DC_1", "unsupported"], ["E_PI_API_NOT_AVAILABLE", "unsupported"], ["E_PI_PLAY_STORE_NOT_FOUND", "unsupported"],
    ["E_DC_3", "new_key"],
    ["E_DC_4", "backoff"], ["E_DC_0", "backoff"], ["E_PI_NETWORK_ERROR", "backoff"], ["E_PI_TOO_MANY_REQUESTS", "backoff"],
    ["E_PI_CLOUD_PROJECT_NUMBER_IS_INVALID", "config"], ["E_DC_2", "config"],
    ["E_SOMETHING", "rejected"], [undefined, "rejected"],
  ])("%s → %s", (code, action) => expect(classifyProviderError(err(code))).toBe(action));
});
