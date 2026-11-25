# Capturing device proofs for the API's attest tests

The rocalytics-api device tests need two real captures. Nothing captured goes in this repository: the JSON goes straight into the API repository, and the service-account key stays out of git everywhere.

## Build

- A development build of any Expo app that has the SDK and `@rocapine/rocalytics-attest`.
- iOS: a real device (App Attest does not work on simulators), with the config plugin on the **development** environment, because the API's tests expect a development key:
  `["@rocapine/rocalytics-attest", { "appAttestEnvironment": "development" }]`
- Android: install the build from the Play internal testing track (Play Integrity needs a Play-distributed app), with the Cloud project linked to Play Integrity.

## Capture

`examples/capture-attest.ts` exports `captureIosProof` and `captureAndroidProof`. Copy the file into the app (or import it) and call one from a button. Pass the inputs as parameters, never hard-coded in a committed file:

```ts
await captureIosProof({ apiBaseUrl, appId, rocaId, teamId, bundleId });
await captureAndroidProof({ apiBaseUrl, appId, rocaId, cloudProjectNumber });
```

Each call fetches its challenges from the dev API (the attest endpoints need no `apikey` or `Authorization` header: they run with `verify_jwt = false`), runs the native module and logs the JSON (read it from the Metro / device log).

iOS output: `challenge`, `app_id`, `roca_id`, `key_id`, `attestation`, `assertions` (two `{ challenge, assertion }`), `team_id`, `bundle_id`, `captured_at`. Save it as `supabase/functions/attest/fixtures/ios.json` in rocalytics-api.

Android output: `challenge`, `app_id`, `roca_id`, `integrity_token`, `captured_at`.

## Android: decode once

The token is only decodable within about 10 minutes of capture. With the API's Play Integrity service account, call:

```sh
curl -X POST "https://playintegrity.googleapis.com/v1/<package>:decodeIntegrityToken" \
  -H "Authorization: Bearer $(gcloud auth print-access-token --impersonate-service-account=<service-account>)" \
  -H "Content-Type: application/json" \
  -d '{"integrity_token": "<integrity_token>"}'
```

Save the response's `tokenPayloadExternal` as `supabase/functions/attest/fixtures/android-verdict-device.json` in rocalytics-api. Keep the captured `challenge`, `app_id` and `roca_id` next to it: the test needs them to rebuild the binding.

## Rules

- Never commit the service-account key or its path, here or in the API repository.
- Commit only the two fixture files, in rocalytics-api. Nothing of the captures goes in this repository.
- The iOS key is single-use for the test: capture again if the app was reinstalled or the key was attested already.
