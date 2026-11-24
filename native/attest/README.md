# @rocapine/rocalytics-attest

App attestation for the Rocalytics SDK (`@rocapine/rocalytics-sdk`): App Attest on iOS, Play Integrity (standard requests) on Android.

Install it next to the SDK and the Rocalytics client attests the app on its own. The SDK never imports this package: it looks up the `RocaAttest` native module by name, and without it simply sends no attestation.

## Install

```sh
npx expo install @rocapine/rocalytics-attest
```

Add the config plugin to `app.json` / `app.config.js`, then rebuild the native app (`npx expo prebuild` or an EAS build):

```json
{
  "expo": {
    "plugins": [
      ["@rocapine/rocalytics-attest", { "appAttestEnvironment": "production" }]
    ]
  }
}
```

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `appAttestEnvironment` | `"production"`, `"development"` | `"production"` | iOS entitlement `com.apple.developer.devicecheck.appattest-environment` |

Use `"production"` for TestFlight and App Store builds. `"development"` targets Apple's development App Attest environment.

The App ID also needs the App Attest capability in the Apple Developer portal.

Android needs no plugin option. The app's Google Cloud project must have the Play Integrity API enabled and be linked to the app in the Play Console; the SDK passes its cloud project number to `prepare`.

## Simulators and emulators

App Attest is unavailable on the iOS simulator: `isSupported()` resolves `false` and the SDK sends no attestation header.

On Android `isSupported()` always resolves `true`; a device or emulator without Google Play fails `prepare` / `requestToken` with an `E_PI_*` code (`E_PI_API_NOT_AVAILABLE`, `E_PI_PLAY_STORE_NOT_FOUND`, …) that the SDK treats as unsupported, so it sends no header.

## Native surface

`RocaAttest` (also the default export, typed `AttestNativeModule`):

| Function | iOS | Android |
| --- | --- | --- |
| `isSupported(): Promise<boolean>` | `DCAppAttestService.shared.isSupported` | `true` |
| `generateKey(): Promise<string>` | new App Attest key id (base64) | – |
| `attestKey(keyId, binding): Promise<string>` | base64 attestation object, `clientDataHash = SHA256(binding)` | – |
| `generateAssertion(keyId, binding): Promise<string>` | base64 assertion, same hash | – |
| `getStoredKeyId(): Promise<string \| null>` | `UserDefaults` key `rocalytics.attest.keyId` | – |
| `setStoredKeyId(keyId \| null): Promise<void>` | `null` removes it | – |
| `prepare(cloudProjectNumber): Promise<void>` | – | `prepareIntegrityToken`, keeps the token provider |
| `requestToken(binding): Promise<string>` | – | integrity token, `requestHash = base64url(SHA256(binding))` without padding (43 chars); prepares again and retries once when the provider expired |

Rejections carry `code` `E_DC_<n>` for a DeviceCheck error (`DCError` code `n`: 0 unknown system failure, 1 feature unsupported, 2 invalid input, 3 invalid key, 4 server unavailable) and `E_ATTEST_UNKNOWN` otherwise.

On Android they carry `E_PI_<NAME>` for a `StandardIntegrityException`, `NAME` being the `StandardIntegrityErrorCode` constant's name (`E_PI_NETWORK_ERROR`, `E_PI_INTEGRITY_TOKEN_PROVIDER_INVALID`, …), and `E_ATTEST_UNKNOWN` otherwise. `requestToken` before `prepare` rejects `E_PI_INTEGRITY_TOKEN_PROVIDER_INVALID`; a non-numeric project number rejects `E_PI_CLOUD_PROJECT_NUMBER_IS_INVALID`.

## Development

```sh
npm ci --legacy-peer-deps
npm run build   # build/ from src/
npm test        # config plugin tests (node --test)
```

## Publishing

Bump `version` in `package.json`, then publish a GitHub release tagged `attest-v<version>` (e.g. `attest-v0.1.0`). `.github/workflows/publish-attest.yml` checks the tag against the version, builds (`prepack`) and publishes with npm trusted publishing; the SDK's own `publish.yml` skips `attest-v*` releases.
