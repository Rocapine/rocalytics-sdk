# Paywall presentation contract

Version 1.1 (`schema_version: 1`). This document is normative. The [JSON Schema](paywall-presentation.schema.json) and the [TypeScript types](paywall-presentation.types.ts) implement it, and [examples](paywall-presentation.examples.ts) illustrate it. Where they disagree, this text wins and the others are bugs.

A **presentation** is one paywall shown to one device: from the moment a paywall is resolved for display until it closes. Since v1.1 the paywall may be one the Studio does not serve: a third-party paywall service's, or one the app renders with its own code (P14). The tracker in `@rocapine/rocalytics-sdk/paywall` sends it as up to three snapshots. Its envelope (`schema_version`, `seq`, `sent_at`, `context`) is the [onboarding run contract](onboarding-run-contract.md)'s, unchanged.

## Contents

1. [Decisions](#1-decisions)
2. [A complete payload](#2-a-complete-payload)
3. [Fields](#3-fields)
4. [Rules beyond the schema](#4-rules-beyond-the-schema)
5. [Transport](#5-transport)
6. [Measures](#6-measures)
7. [Versioning](#7-versioning)
8. [Changes in v1.1](#8-changes-in-v11)

## 1. Decisions

| # | Topic | Decision |
|---|---|---|
| P1 | Unit | One presentation is one `present()` call, or one display of a `Paywall` onboarding step, that resolved to a paywall. For a paywall the Studio does not serve, it is one display the app reports, from the moment the paywall is about to show; a trigger that shows nothing (skipped, or failed before display) sends nothing. Calls refused before resolution (`unknown-moment`, `already-presenting`) send nothing. Errors after resolution (`parse-error`, `render-error`, `unknown-custom-screen`, `host-never-presented`, `paywall-disappeared`) send a start and an `error` end. |
| P2 | Identity | `presentation_id` is a client-minted lowercase UUIDv7. The ingest keys rows on `(roca_id, presentation_id)`. |
| P3 | Envelope | `schema_version`, `seq`, `sent_at` and `context` are exactly as in the onboarding run contract (D4, D5, D24). |
| P4 | Sends | At most three per presentation: on start (`in_progress`, `shown_at` null), on shown, and on end (`ended`). Each send is a full snapshot that replaces the previous one. |
| P5 | Terminal | `ended` is terminal: the first ended snapshot the server accepts wins, and anything after it is `ignored`. |
| P6 | Immutable | `presentation_id`, `started_at`, `paywall`, `surface`, `provider`, `onboarding_run` and `context` never change within a presentation. A snapshot that changes one is `rejected`. |
| P7 | Shown | `shown_at` is set when the host acknowledges that the paywall is on screen. A presentation that ends without it was never seen, and counts toward no user-facing measure. |
| P8 | Outcome | One of `purchased`, `dismissed`, `cancelled` or `error`. `reason` appears only with `error`, carrying the SDK's error reason. `transaction` appears only with `purchased`. |
| P9 | Join key | `transaction.original_transaction_identifier` is the exact value the app passes to Rocalytics' `purchase` call (`TrackPurchaseParams.originalTransactionIdentifier`, required there). iOS: it is StoreKit's original transaction id and joins the store-notification rows' `original_transaction_identifier` directly, with no lookup. Android: `transaction.purchase_token` is the Play purchase token and is the join key; `original_transaction_identifier` carries the Play order id (`GPA.…`) there and is not used to join. |
| P10 | Unattributed | A `purchased` outcome without the platform's join key (iOS: `original_transaction_identifier`; Android: `purchase_token`) is a valid snapshot. It counts as a conversion and earns no proceeds. |
| P11 | Time | Analytics buckets a presentation by the server's receive time of its first snapshot, as onboarding D13. Within a presentation the client clamps timestamps to be monotonic. |
| P12 | No money | The client never sends a price. Proceeds come from store transaction rows joined on P9. |
| P13 | Restored | `transaction.restored: true` marks a `purchased` outcome that only restored existing access: a restore or a web redemption. It counts in neither `purchases` nor conversions. Only `true` is ever sent; an absent field means a new purchase. |
| P14 | Provider | `provider` says who served the paywall: `studio` (the Studio's paywall host), `external` (a third-party paywall service) or `native` (the app's own code). It is optional, and absent means `studio`: every v1 snapshot is a `studio` one, and the tracker sends no `provider` unless the app sets one. Absent and `studio` are the same value for P6. |
| P15 | Ids per provider | `studio` requires `paywall.moment_key` and `paywall.paywall_id`. `external` requires `paywall.placement` and `paywall.external_paywall_id`. `native` requires `paywall.external_paywall_id`. Any of them may also appear with another provider: Studio ids are kept when a non-Studio presentation carries them. |
| P16 | No vendor enum | The service's name travels only as free text in `paywall.provider_name`, never as an enum value. |

## 2. A complete payload

The last of three sends of a purchased presentation on Android:

```json
{
  "schema_version": 1,
  "presentation_id": "0192f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b",
  "seq": 3,
  "status": "ended",
  "started_at": "2026-01-10T09:00:00.000Z",
  "shown_at": "2026-01-10T09:00:00.350Z",
  "ended_at": "2026-01-10T09:00:41.120Z",
  "sent_at": "2026-01-10T09:00:41.120Z",
  "paywall": {
    "moment_key": "settings_upgrade",
    "paywall_id": "4b1f0e7c-2d1a-4c55-9a0e-6f2d3c1b7a90",
    "audience_id": "a9e1c3d2-7b6f-4e21-8c0d-5f4a3b2c1d0e",
    "render_mode": "custom",
    "billing": "store"
  },
  "surface": "present",
  "context": {
    "app_version": "2.4.0",
    "build": "412",
    "platform": "android",
    "os_version": "15",
    "locale": "en-US",
    "timezone": "America/New_York",
    "library_version": "0.1.0"
  },
  "outcome": {
    "status": "purchased",
    "transaction": {
      "original_transaction_identifier": "GPA.3311-4849-7511-34728",
      "purchase_token": "mboecpopplapdphlhgegnpol.AO-J1OxExampleToken",
      "product_id": "pro_annual"
    }
  }
}
```

## 3. Fields

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | `1` | This document's revision. |
| `presentation_id` | lowercase UUID | Minted by the client when the presentation starts (P2). |
| `seq` | integer ≥ 1 | Increases with every send of this presentation (onboarding D4). |
| `status` | `in_progress` \| `ended` | `ended` is terminal (P5). |
| `started_at` | timestamp | When the paywall was resolved for display. |
| `shown_at` | timestamp \| null | When the host acknowledged the paywall on screen (P7). |
| `ended_at` | timestamp \| null | Set exactly when `status` is `ended`. |
| `sent_at` | timestamp | Device clock at send time. Advisory only. |
| `paywall.moment_key` | string, optional | The moment the host presented. Required with provider `studio` (P15). |
| `paywall.paywall_id` | string, optional | The paywall the moment resolved to. Required with provider `studio` (P15). |
| `paywall.audience_id` | string \| null | The audience that matched, if the catalog carried one. Null for a paywall the Studio did not serve. |
| `paywall.render_mode` | `elements` \| `custom` \| `external` | How the paywall was rendered. `external`: by a third-party paywall service. |
| `paywall.billing` | `store` \| `stripe` | The paywall's billing path. |
| `paywall.variant_key`, `paywall.deployment_id` | string, optional | Present only when the catalog carries them. `variant_key` also carries a paywall service's experiment variant, when it has one. A Studio-served paywall reports its variant's key, and the reserved value `"main"` for the parent paywall. |
| `paywall.placement` | string, optional, 1 to 128 | v1.1. The app's trigger name for the paywall. Required with provider `external` (P15). |
| `paywall.external_paywall_id` | string, optional, 1 to 128 | v1.1. The non-Studio paywall's id: the service's paywall identifier, or the app's own variant key for `native`. Required with provider `external` or `native` (P15). |
| `paywall.provider_name` | string, optional, 1 to 32 | v1.1. Free text naming the paywall service (P16). |
| `surface` | `present` \| `paywall_step` \| `placement` | A `present()` call, a `Paywall` step inside an onboarding, or (v1.1) any other in-app trigger. |
| `provider` | `studio` \| `external` \| `native`, optional | v1.1. Who served the paywall (P14). Absent means `studio`. |
| `onboarding_run` | object, optional | Only with `paywall_step`: the onboarding run's `run_id` and `step_key`. |
| `outcome` | object \| null | Set exactly when `status` is `ended` (P8). |
| `outcome.reason` | string, optional | Only with `error`. |
| `outcome.transaction` | object, optional | Only with `purchased`, never empty. Fields: `original_transaction_identifier`, `purchase_token`, `product_id`, `restored` (P9, P10, P13). |
| `context` | object | The onboarding contract's run context, captured once at start (onboarding D5). |

All timestamps have exactly three fractional digits (onboarding D24). A snapshot is at most 16 KiB.

## 4. Rules beyond the schema

- `ended_at` and `outcome` are non-null exactly when `status` is `ended`.
- `shown_at`, when set, is not before `started_at`.
- `ended_at`, when set, is not before `shown_at` (or `started_at` when never shown).
- `sent_at` is not before `started_at`.
- `reason` appears only with outcome status `error`.
- `transaction` appears only with outcome status `purchased`, and is never an empty object.
- A `purchased` outcome requires `shown_at`.
- `onboarding_run` appears only with surface `paywall_step`.
- The ids `provider` requires are present (P15), with an absent `provider` read as `studio`.

## 5. Transport

**Endpoint.** `POST /functions/v1/paywall-presentations` on the Rocalytics API. The sender is identified by the same headers the onboarding endpoint uses (`X-Roca-ID`, `X-Application-ID`, `X-Platform`); the body is the bare snapshot, with no device identifiers in it.

**Acceptance.** The server keys a presentation on the sender's `roca_id` and `presentation_id`, and answers each snapshot in its body:

- `ignored` when the stored snapshot is already `ended` (P5), or when the incoming `seq` is not higher than the stored one.
- `rejected` when the snapshot fails the schema or section 4, exceeds 16 KiB, or changes an immutable field (P6).
- `accepted` otherwise: the snapshot replaces the stored one.

The server checks the `paywall` string fields' lengths in UTF-8 bytes, not characters: 128 bytes for the ids, 32 for `provider_name`. A value within the character limit but over the byte limit, which only multibyte text can be, is `rejected`. So is a snapshot holding a U+0000 or a lone surrogate in any string. The SDK's tracker checks the `paywall` ids and `provider_name` by these rules: `start()` refuses a value that breaks them as `invalid-info` and sends nothing. A store id in `transaction` that breaks them, or its 1024-byte limit, is left out rather than sent. The `context` strings are not checked this way.

**Outcomes and retries.** As onboarding D27: the outcome is always in the response body, on a 2xx and on a 4xx alike. A response without an outcome, and no response at all, are transient and retried with backoff. `accepted`, `ignored` and `rejected` settle the snapshot for good.

## 6. Measures

Per moment and per paywall, over presentations bucketed by P11. Since v1.1 the same measures apply app-wide, over every provider, and per provider, placement or moment, and paywall (`paywall_id` or `external_paywall_id`):

- **Users:** distinct senders with a presentation that was shown or purchased.
- **Conversions:** distinct senders with a `purchased` presentation that is not `restored` (P13).
- **Conversion rate:** conversions divided by users.
- **Unattributed purchases:** `purchased`, not restored, and missing the platform's join key (P10).
- **Proceeds:** the store transaction rows joined on P9. Never a client-sent price (P12).

## 7. Versioning

As onboarding D20, a change an older payload needs no conversion for is additive; anything else is breaking and increments `schema_version`.

v1.1 is additive and keeps `schema_version: 1`: every v1 snapshot is a valid v1.1 snapshot, with the same meaning. The schema is closed, though, so an ingest that only knows v1 rejects a snapshot that carries a v1.1 field or value. The ingest must accept v1.1 before any client sends one. A client that never sets `provider` keeps sending v1 snapshots, byte for byte.

## 8. Changes in v1.1

All additive (section 7):

- `provider` (P14), optional, absent meaning `studio`.
- `surface` adds `placement`; `paywall.render_mode` adds `external`.
- `paywall.moment_key` and `paywall.paywall_id` become optional, required with provider `studio` (P15).
- `paywall.placement`, `paywall.external_paywall_id` and `paywall.provider_name`, optional (P15, P16).
- P6 adds `provider` to the immutable fields.
