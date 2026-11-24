# @rocapine/rocalytics-attest

App attestation for the Rocalytics SDK (`@rocapine/rocalytics-sdk`): App Attest on iOS, Play Integrity on Android (coming in a later release).

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

## Simulators

App Attest is unavailable on the iOS simulator: `isSupported()` resolves `false` and the SDK sends no attestation header.

## Native surface

`RocaAttest` (also the default export, typed `AttestNativeModule`):

| Function | iOS |
| --- | --- |
| `isSupported(): Promise<boolean>` | `DCAppAttestService.shared.isSupported` |
| `generateKey(): Promise<string>` | new App Attest key id (base64) |
| `attestKey(keyId, binding): Promise<string>` | base64 attestation object, `clientDataHash = SHA256(binding)` |
| `generateAssertion(keyId, binding): Promise<string>` | base64 assertion, same hash |
| `getStoredKeyId(): Promise<string \| null>` | `UserDefaults` key `rocalytics.attest.keyId` |
| `setStoredKeyId(keyId \| null): Promise<void>` | `null` removes it |

Rejections carry `code` `E_DC_<n>` for a DeviceCheck error (`DCError` code `n`: 0 unknown system failure, 1 feature unsupported, 2 invalid input, 3 invalid key, 4 server unavailable) and `E_ATTEST_UNKNOWN` otherwise.

## Development

```sh
npm install --no-package-lock --legacy-peer-deps
npm run build   # build/ from src/
npm test        # config plugin tests (node --test)
```
