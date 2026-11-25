// Developer-only: captures real App Attest / Play Integrity proofs so they can
// become the rocalytics-api device-test fixtures (see scripts/capture-attest-fixtures.md).
// Call one of these from any button of a development build that has
// @expo/app-integrity installed. Nothing here is shipped, and nothing captured is committed.
import { requestHashOf, type AttestNativeModule, type RocalyticsModules } from "@rocapine/rocalytics-sdk/client";
import { bindingString } from "@rocapine/rocalytics-sdk/core";

declare const require: (id: string) => unknown;

export interface CaptureOptions {
  /** The dev API's base URL, without a trailing slash. */
  apiBaseUrl: string;
  appId: string;
  rocaId: string;
}

export interface CaptureIosOptions extends CaptureOptions {
  teamId: string;
  bundleId: string;
}

export interface CaptureAndroidOptions extends CaptureOptions {
  /** The Google Cloud project number linked to Play Integrity. */
  cloudProjectNumber: string;
}

function nativeModule(): AttestNativeModule {
  const core = require("expo-modules-core") as { requireOptionalNativeModule(name: string): unknown };
  const mod = core.requireOptionalNativeModule("ExpoAppIntegrity") as AttestNativeModule | null;
  if (!mod) throw new Error("ExpoAppIntegrity is not in this build: install @expo/app-integrity and make a development build.");
  return mod;
}

async function fetchChallenge(o: CaptureOptions, platform: "ios" | "android"): Promise<string> {
  const url = `${o.apiBaseUrl}/functions/v1/attest/challenge?app_id=${encodeURIComponent(o.appId)}&platform=${platform}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`challenge request failed: ${res.status}`);
  const body = (await res.json()) as { challenge: string };
  return body.challenge;
}

const need = <T>(fn: T | undefined, name: string): T => {
  if (!fn) throw new Error(`${name} is not available on this platform`);
  return fn;
};

/** iOS: one attestation and two assertions, each over its own challenge. Build with the App Attest entitlement set to "development". */
export async function captureIosProof(o: CaptureIosOptions) {
  const m = nativeModule();
  if (m.isSupported !== true) throw new Error("App Attest is not supported here (a simulator?): use a real device.");
  const challenge = await fetchChallenge(o, "ios");
  const keyId = await need(m.generateKeyAsync, "generateKeyAsync").call(m);
  const attestation = await need(m.attestKeyAsync, "attestKeyAsync").call(m, keyId, bindingString(challenge, o.appId, o.rocaId));
  const assertions: { challenge: string; assertion: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const c = await fetchChallenge(o, "ios");
    const assertion = await need(m.generateAssertionAsync, "generateAssertionAsync").call(m, keyId, bindingString(c, o.appId, o.rocaId));
    assertions.push({ challenge: c, assertion });
  }
  const proof = {
    challenge,
    app_id: o.appId,
    roca_id: o.rocaId,
    key_id: keyId,
    attestation,
    assertions,
    team_id: o.teamId,
    bundle_id: o.bundleId,
    captured_at: new Date().toISOString(),
  };
  console.log(JSON.stringify(proof, null, 2));
  return proof;
}

/** Android: one integrity token. Install the build from the Play internal testing track. */
export async function captureAndroidProof(o: CaptureAndroidOptions) {
  const m = nativeModule();
  const challenge = await fetchChallenge(o, "android");
  await need(m.prepareIntegrityTokenProviderAsync, "prepareIntegrityTokenProviderAsync").call(m, o.cloudProjectNumber);
  const crypto = require("expo-crypto") as Required<RocalyticsModules["crypto"]>;
  const requestHash = await requestHashOf(crypto, bindingString(challenge, o.appId, o.rocaId));
  const integrityToken = await need(m.requestIntegrityCheckAsync, "requestIntegrityCheckAsync").call(m, requestHash);
  const proof = {
    challenge,
    app_id: o.appId,
    roca_id: o.rocaId,
    integrity_token: integrityToken,
    captured_at: new Date().toISOString(),
  };
  console.log(JSON.stringify(proof, null, 2));
  return proof;
}
