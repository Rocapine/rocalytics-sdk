# Onboarding run contract

**Schema version 1.** This document defines the payload a client sends to describe one run of an onboarding flow. It also defines how analytics turns those payloads into a funnel that tells a skipped screen apart from a quit.

Every decision below is **Decided**. The status column remains so that a later revision can mark a new decision Proposed.

Companion files, which move together with this document:

| File | What it is |
|---|---|
| [`onboarding-run.schema.json`](onboarding-run.schema.json) | JSON Schema (draft 2020-12) for one snapshot. Closed: an unknown field is an error. |
| [`onboarding-run.types.ts`](onboarding-run.types.ts) | The same shape as TypeScript types, with no imports. |
| [`onboarding-run.examples.ts`](onboarding-run.examples.ts) | Every payload and every run used in this document. |

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

## Contents

1. [Decisions](#1-decisions)
2. [A complete payload](#2-a-complete-payload)
3. [Fields](#3-fields)
4. [Rules beyond the schema](#4-rules-beyond-the-schema)
5. [Transport](#5-transport-d4-d12-d13-d27)
6. [Funnel measures](#6-funnel-measures-d14-d15-d16)
7. [Worked examples](#7-worked-examples)
8. [Versioning](#8-versioning-d19-d20)
9. [Pre-v1 payloads](#9-pre-v1-payloads-d22-d23)
10. [Reference tracker](#10-reference-tracker)

## 1. Decisions

| # | Topic | Decision | Status | Rationale |
|---|---|---|---|---|
| D1 | Identity | The app declares `onboarding.key`, `onboarding.version`, an optional `onboarding.variant_key` (see D25), and a `step_key` per step. Studio ids are optional links under `studio`. | Decided | Analytics must work for a flow the Studio never served. Links add detail but are never required. |
| D2 | Field names | Identity is nested under `onboarding` (`onboarding.key`, not a top-level `onboarding_key`). | Decided | A top-level `version` would be read as `schema_version` or the app version. |
| D3 | Run | Each run has a client-minted UUID `run_id`, plus `schema_version`, `status` (`in_progress` or `completed`), `started_at` and `completed_at`. A quit is never sent. | Decided | The client knows when a run starts and when it completes, but never when it is abandoned. |
| D4 | Ordering | Each send carries `seq`, an integer that goes up with every send. The server keeps the snapshot with the highest `seq`. | Decided | `sent_at` is the device clock and is advisory, so it cannot order sends. |
| D5 | Run context | App version, build, platform, OS version, locale and timezone are captured once, at run start, and repeated unchanged in every snapshot (the schema requires them in each). The server pins them from the first snapshot it stores. | Decided | A run is analysed against the build and settings it started with. |
| D6 | Country | The client does not send it. The server derives it. | Decided | Device region settings are not location. A server-side source is consistent across apps. |
| D7 | Custom properties | A run-level `properties` map of scalar values (string, number, boolean, null). User-level traits stay in the backend's identify call, outside this contract. | Decided | The funnel slices runs, so the value that applies is the one the run was seen with. |
| D8 | Limits | 20 properties, 40-character property keys, 256-character property strings, 200 manifest steps, 500 entries, 50 answers per entry, 1,000-character text answers, 256 KiB per snapshot. The tracker enforces the size limit by stopping recording at a budget of 261,120 bytes, 256 KiB minus 1 KiB (D26). The ingest rejects a snapshot over 256 KiB with an explicit `rejected` outcome (section 5, rule 2). The exception is a run already completed: such a snapshot is ignored, because rule 1 runs first. | Decided | Ingest storage and query cost need a hard bound. The numbers are generous for a real flow with back navigation. |
| D9 | Steps | `steps` holds one entry per screen shown, in the order shown. Back navigation appends a repeated entry. There is no skip entry and no skip call: a step that was not shown simply has no entry. | Decided | This is the order the user actually went through. Repeats keep that order without rewriting history. A skip is a fact about the flow, so it is derived from the manifest (D17) rather than reported. |
| D10 | Last `exited_at` | `exited_at` is null on at most one entry: the last entry of an `in_progress` run. In a completed run every entry has an exit, and the last one equals `completed_at`, except in a truncated run (D26): there the last kept entry may already be closed while in progress, and it keeps its own exit on completion and on restore. | Decided | A null exit then means "still on this screen, or left here". A finished run has no open entry. |
| D11 | Answers | Four kinds: `single`, `multi`, `numeric` and `text`. Values are stable option keys, never displayed labels. Free text is never aggregated. | Decided | A translated label would split one option into one row per language. |
| D12 | Transport | Each send is a full snapshot that replaces the previous one. Retries are idempotent. `completed` is terminal: the first completed snapshot wins. See D27. | Decided | A lost or repeated send cannot corrupt the run. |
| D13 | Time | Analytics buckets a run by the server's receive time of its first snapshot. Client times are used only for durations within one run. | Decided | Device clocks drift and can be set in the future. A run's bucket must never move. |
| D14 | Quit | A run is quit when it is `in_progress` and no snapshot has been received for **24 hours**. This is recomputed at read time, so a run that resumes stops counting as quit. | Decided | The threshold trades early numbers for accuracy. 24 hours tolerates a user who comes back later the same day. |
| D15 | Funnel unit | Funnels count runs, not people. A replay is a second run. | Decided | A run is what the payload identifies. Counting people needs a stable person id, which this contract does not carry. |
| D16 | Funnel measures | *Still in the flow*, *Saw it*, *Skipped*, *Quit here* and the quit rate are defined per position, over runs. *Skipped* is derived at read time: a declared step with no entry, on a run that reached a later position or completed, counts as skipped, not as a quit. See [section 6](#6-funnel-measures-d14-d15-d16). | Decided | Makes the four measures computable and consistent with each other. *Still in the flow* means "reached this position". |
| D17 | Who declares the step list | Every run carries a `manifest`, declared once at run start and repeated unchanged in every snapshot (the schema requires it in each; a change within a run is rejected, see section 5): the flow's ordered step list, where an optional `slot` groups alternatives. For a Studio-served flow, the tracker fills it from the deployment. For a hand-coded flow, the app declares it. | Decided | *Skipped* and position cannot be computed from observed paths alone. See [3.5](#35-manifest-d17-d18). |
| D18 | Manifest identity | One `(onboarding.key, onboarding.version)` has exactly one manifest. A run that declares a different one (*differs* as defined in section 5, rule 4) is stored, excluded from funnels and reported as a version conflict. The version `draft` is exempt (D21). | Decided | A changed flow must never merge silently into the old flow's funnel. |
| D19 | Flow versioning | `onboarding.version` MUST change whenever the manifest or a question's keys change. The version `draft` is exempt (D21). | Decided | See [section 8](#8-versioning-d19-d20). |
| D20 | Schema versioning | The schema is closed, so every change increments `schema_version`. A change is *additive* when an older payload needs no conversion, and *breaking* otherwise. | Decided | One rule with no exception. See [section 8](#8-versioning-d19-d20). |
| D21 | Drafts | `onboarding.version` `"draft"` is reserved for a flow that has not been published. Readers exclude it by default. It is exempt from D18 and D19: there is no version-conflict handling for it, and its manifest may change between runs without a version change. | Decided | Keeps preview traffic out of funnels without adding a field. A draft is edited constantly, so holding it to one manifest would reject every edit. |
| D22 | Pre-v1 payloads | Pre-v1 payloads are converted on the server into v1-shaped rows marked `schema_version` 0, with `onboarding.version` `legacy:<deployment id>`. | Decided | They carry no run id, and their revision can only be recovered by time, so they must never mix with v1 runs. See [section 9](#9-pre-v1-payloads-d22-d23). |
| D23 | Pre-v1 deployment | The deployment behind a converted run is resolved by time: the one live for the run's audience when the run was first received. Its step list is the run's manifest, and converted runs appear in funnels under their own `legacy:` versions. | Decided | Keeps existing history visible. Resolving by time is best-effort: a run that spans a publish is attributed to the deployment live at its start. |
| D24 | Timestamp form | Every timestamp has exactly three fractional digits: `2026-01-10T09:00:00.000Z`. | Decided | One form sorts correctly as text and compares byte for byte. It is what `Date.prototype.toISOString` produces. |
| D25 | A/B arms | Each Studio-served A/B arm keeps its own `onboarding.key`: the arms are separate Studio onboardings, and they are compared as separate keys. `variant_key` is only for an app that runs one flow, under one key, with its own in-flow variants. A Studio-served run does not set it. | Decided | Studio arms are already separate records with separate step lists, so a shared key would merge different manifests. |
| D26 | Overflow | When recording more would take a run past 500 entries or past the recording budget of 261,120 bytes (256 KiB minus 1 KiB of headroom, measured on the completion form), the tracker stops recording and sets `truncated: true`. This covers a new entry, and also growth inside an entry: a new answer, or a new or changed property. It keeps what it already has and still sends the run, including the `completed` status when the run completes, so the run is not counted as quit. | Decided | Keeping the first entries keeps `started_at` valid and keeps the early funnel, which is where most runs are. See [3.9](#39-overflow-d26). |
| D27 | Snapshot acceptance | The server answers each snapshot with `accepted`, `ignored` or `rejected`, in the response body. Any response without an outcome in its body, whatever its status, and no response at all, is transient and retried. See [section 5](#5-transport-d4-d12-d13-d27). | Decided | A tracker needs to know when to drop a snapshot and when to send it again. |

## 2. A complete payload

A run is sent several times, and each send is a snapshot of everything so far. Below are two snapshots of the same run. The run is Studio-served, so its `onboarding.key` is the Studio onboarding id and its `onboarding.version` the deployment id ([3.1](#31-identity-d1-d2-d25)). Together the two snapshots use every optional part of the shape except `variant_key` (shown in 3.1) and `truncated` (shown in [3.9](#39-overflow-d26)).

The first send shown here is taken mid-flow. The user is on `experience`, so its `exited_at` is null:

```json
{
  "schema_version": 1,
  "run_id": "00000000-0000-4000-8000-000000000001",
  "seq": 3,
  "status": "in_progress",
  "started_at": "2026-01-10T08:00:00.000Z",
  "completed_at": null,
  "sent_at": "2026-01-10T08:00:20.000Z",
  "onboarding": { "key": "6f1c2b0e-3d4a-4f8e-9b7c-2a1d0e9f8c7b", "version": "412" },
  "studio": {
    "onboarding_id": "6f1c2b0e-3d4a-4f8e-9b7c-2a1d0e9f8c7b",
    "deployment_id": "412",
    "audience_id": "7"
  },
  "context": {
    "app_version": "2.4.0",
    "build": "2040",
    "platform": "android",
    "os_version": "15",
    "locale": "fr-FR",
    "timezone": "Europe/Paris",
    "library_version": "0.1.0"
  },
  "manifest": {
    "steps": [
      { "step_key": "welcome" },
      { "step_key": "goal" },
      { "step_key": "experience" },
      { "step_key": "plan_quick", "slot": "plan" },
      { "step_key": "plan_detailed", "slot": "plan" },
      { "step_key": "permissions" },
      { "step_key": "summary" }
    ]
  },
  "properties": { "signup_source": "email", "returning_user": false, "cohort_week": 2 },
  "steps": [
    {
      "step_key": "welcome",
      "entered_at": "2026-01-10T08:00:00.000Z",
      "exited_at": "2026-01-10T08:00:10.000Z",
      "answers": []
    },
    {
      "step_key": "goal",
      "entered_at": "2026-01-10T08:00:10.000Z",
      "exited_at": "2026-01-10T08:00:20.000Z",
      "answers": [
        { "question_key": "goal", "kind": "single", "value": "practice" },
        { "question_key": "topics", "kind": "multi", "value": ["vocabulary", "listening"] }
      ]
    },
    {
      "step_key": "experience",
      "entered_at": "2026-01-10T08:00:20.000Z",
      "exited_at": null,
      "answers": [
        { "question_key": "daily_time", "kind": "numeric", "value": 15, "unit": "minute" }
      ]
    }
  ]
}
```

The completion send replaces that snapshot. Along the way, the user went back from `experience` to `goal` (the repeated entries), saw one of the two `plan` alternatives, and was never shown `permissions`. There is no entry for `permissions`. Because the run went on to `summary`, a reader derives the skip from the manifest. Here is the completed snapshot:

```json
{
  "schema_version": 1,
  "run_id": "00000000-0000-4000-8000-000000000001",
  "seq": 8,
  "status": "completed",
  "started_at": "2026-01-10T08:00:00.000Z",
  "completed_at": "2026-01-10T08:01:10.000Z",
  "sent_at": "2026-01-10T08:01:10.000Z",
  "onboarding": { "key": "6f1c2b0e-3d4a-4f8e-9b7c-2a1d0e9f8c7b", "version": "412" },
  "studio": {
    "onboarding_id": "6f1c2b0e-3d4a-4f8e-9b7c-2a1d0e9f8c7b",
    "deployment_id": "412",
    "audience_id": "7"
  },
  "context": {
    "app_version": "2.4.0",
    "build": "2040",
    "platform": "android",
    "os_version": "15",
    "locale": "fr-FR",
    "timezone": "Europe/Paris",
    "library_version": "0.1.0"
  },
  "manifest": {
    "steps": [
      { "step_key": "welcome" },
      { "step_key": "goal" },
      { "step_key": "experience" },
      { "step_key": "plan_quick", "slot": "plan" },
      { "step_key": "plan_detailed", "slot": "plan" },
      { "step_key": "permissions" },
      { "step_key": "summary" }
    ]
  },
  "properties": { "signup_source": "email", "returning_user": false, "cohort_week": 2 },
  "steps": [
    {
      "step_key": "welcome",
      "entered_at": "2026-01-10T08:00:00.000Z",
      "exited_at": "2026-01-10T08:00:10.000Z",
      "answers": []
    },
    {
      "step_key": "goal",
      "entered_at": "2026-01-10T08:00:10.000Z",
      "exited_at": "2026-01-10T08:00:20.000Z",
      "answers": [
        { "question_key": "goal", "kind": "single", "value": "practice" },
        { "question_key": "topics", "kind": "multi", "value": ["vocabulary", "listening"] }
      ]
    },
    {
      "step_key": "experience",
      "entered_at": "2026-01-10T08:00:20.000Z",
      "exited_at": "2026-01-10T08:00:30.000Z",
      "answers": [
        { "question_key": "daily_time", "kind": "numeric", "value": 15, "unit": "minute" }
      ]
    },
    {
      "step_key": "goal",
      "entered_at": "2026-01-10T08:00:30.000Z",
      "exited_at": "2026-01-10T08:00:40.000Z",
      "answers": [
        { "question_key": "goal", "kind": "single", "value": "practice" },
        { "question_key": "topics", "kind": "multi", "value": ["vocabulary", "listening"] }
      ]
    },
    {
      "step_key": "experience",
      "entered_at": "2026-01-10T08:00:40.000Z",
      "exited_at": "2026-01-10T08:00:50.000Z",
      "answers": [
        { "question_key": "daily_time", "kind": "numeric", "value": 15, "unit": "minute" }
      ]
    },
    {
      "step_key": "plan_detailed",
      "entered_at": "2026-01-10T08:00:50.000Z",
      "exited_at": "2026-01-10T08:01:00.000Z",
      "answers": []
    },
    {
      "step_key": "summary",
      "entered_at": "2026-01-10T08:01:00.000Z",
      "exited_at": "2026-01-10T08:01:10.000Z",
      "answers": [{ "question_key": "feedback", "kind": "text", "value": "Looking forward to it" }]
    }
  ]
}
```

## 3. Fields

All timestamps are RFC 3339 in UTC with **exactly three fractional digits** and a `Z` suffix, for example `2026-01-10T08:00:00.000Z` (D24). `2026-01-10T08:00:00Z` and `2026-01-10T08:00:00.000000Z` are both rejected.
- One form sorts correctly as text.
- The user's local offset is recorded once, in `context.timezone`.

A **key** is 1 to 128 characters from `A–Z a–z 0–9 _ . : -`, starting with a letter or a digit, and is case-sensitive. Onboarding, step, question, option, slot and variant keys are all keys.
- Both readable slugs and UUIDs fit.
- Whitespace and punctuation that break URLs and CSV exports do not.

### 3.1 Identity (D1, D2, D25)

| Field | Required | Meaning |
|---|---|---|
| `onboarding.key` | yes | A stable key for one flow. It MUST NOT be reused for a different flow. |
| `onboarding.version` | yes | The flow's revision: 1 to 64 characters from `A–Z a–z 0–9 _ . : + -`, starting with a letter or a digit. See [section 8](#8-versioning-d19-d20). |
| `onboarding.variant_key` | no | An in-flow variant, for an app that runs one flow under one key with its own variants. Not set for a Studio-served run. Absent or null means the run is not in such a test. |
| `studio.onboarding_id`, `studio.deployment_id`, `studio.audience_id` | no | Links to Studio records. Opaque strings of 1 to 128 characters; a numeric id is sent in decimal. |

For a Studio-served flow, the tracker uses the Studio onboarding id as `onboarding.key` and the deployment id as `onboarding.version`, unless the app declares its own. A Studio-served draft or preview MUST send `onboarding.version` `"draft"` (D21), because it has no deployment id. A run's identity MUST NOT change between its snapshots ([section 5](#5-transport-d4-d12-d13-d27) rejects a change).

**A/B tests (D25).** There are two kinds, and they are identified differently:
- **Studio-served arms.** Each arm of a Studio A/B test is its own Studio onboarding, so each arm keeps its **own `onboarding.key`**, with its own versions and its own manifest. Arms are compared as separate keys: one funnel per key, side by side. A Studio-served run does not set `variant_key`.
- **In-flow variants.** An app that runs one flow, under one key and one manifest, and varies something inside it (copy, order of options, an intro screen chosen by a slot) sets `variant_key` on each run. Its funnel can then be split by `variant_key`.

A hand-coded flow running an in-flow variant:

```json
{
  "schema_version": 1,
  "run_id": "00000000-0000-4000-8000-000000000002",
  "seq": 1,
  "status": "in_progress",
  "started_at": "2026-01-10T08:30:00.000Z",
  "completed_at": null,
  "sent_at": "2026-01-10T08:30:00.000Z",
  "onboarding": { "key": "main", "version": "7", "variant_key": "short-intro" },
  "context": {
    "app_version": "2.4.0",
    "build": "412",
    "platform": "ios",
    "os_version": "18.1",
    "locale": "en-US",
    "timezone": "America/New_York"
  },
  "manifest": {
    "steps": [{ "step_key": "welcome" }, { "step_key": "goal" }, { "step_key": "summary" }]
  },
  "steps": [
    {
      "step_key": "welcome",
      "entered_at": "2026-01-10T08:30:00.000Z",
      "exited_at": null,
      "answers": []
    }
  ]
}
```

### 3.2 Run (D3, D4)

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | `1` for this document. |
| `run_id` | yes | A lowercase UUID, minted by the client when the first step is entered. UUIDv7 is RECOMMENDED because it sorts by time. Any version is accepted. |
| `seq` | yes | `1` on the first send. It increases by at least 1 with every later send of the run, and a retry reuses the same value. |
| `status` | yes | `in_progress` or `completed`. A quit is never sent: see D14. |
| `started_at` | yes | Equal to the first entry's `entered_at`. |
| `completed_at` | yes | A timestamp when `status` is `completed`, null otherwise. |
| `sent_at` | yes | The client clock when the snapshot left the device. Advisory: stored so clock skew can be measured, never used to order or bucket. |

A run is one pass through the flow. If the flow restarts from its first step, or a finished flow is replayed, that is a new `run_id`. The abandoned run stays `in_progress` and counts as quit once D14's threshold passes.

**Resume after relaunch.** If the app restores the user's position after it was killed, the run continues with the same `run_id`. To make that possible, a conforming tracker MUST persist, on every change:
- the `run_id`;
- the last `seq` it assigned;
- the full `steps` list, together with the rest of the snapshot (manifest, context, properties);
- `last_active_at`: the last moment the app was known to be in the foreground on the current screen. It is updated on every entry, every send and every move to the background.

On restore, the tracker:
1. if the pre-kill entry is still open, sets its `exited_at` to the persisted `last_active_at`, because the time after that is not time spent on the screen. An exit already set, as on a truncated run's last kept entry, is never rewritten;
2. appends a **new entry** for the restored screen, with `entered_at` set to the restore time, subject to [3.9](#39-overflow-d26). The run then shows that step twice, as with back navigation, and it still counts once per position. If the entry would break a limit, the tracker follows 3.9 instead: it stops recording and sets `truncated`, rather than append it. An example is a run that already has 500 entries. A truncated run ([3.9](#39-overflow-d26)) appends **no** entry, because it has stopped recording;
3. sends the next snapshot with the persisted `seq` + 1.

A tracker that cannot restore the position starts a new run instead.

### 3.3 Context (D5, D6)

Captured once, when the run starts, and repeated unchanged in every snapshot: the schema requires `context` in each one. The server keeps the context of the first snapshot it stores, and ignores any different context sent later.

| Field | Required | Meaning |
|---|---|---|
| `app_version` | yes | Marketing version, for example `2.4.0`. 1 to 32 characters. |
| `build` | yes, nullable | Build number, 1 to 32 characters. Null on a platform with no build number. |
| `platform` | yes | `ios`, `android` or `web`. |
| `os_version` | yes, nullable | OS version, 1 to 32 characters. Null when the platform cannot report it. |
| `locale` | yes | BCP 47 tag of the language the flow is shown in. |
| `timezone` | yes | IANA name, for example `Europe/Paris`. At most 64 characters. |
| `library_version` | no | Version of the tracker that produced the payload. 1 to 32 characters. |

There is no `country` field, and the schema rejects one. The server derives country from its own records for the sender, or from the network address at receive time (D6).

### 3.4 Custom properties (D7, D8)

`properties` is an optional map from a key to a scalar value.
- **Keys:** at most 20, each matching `^[a-z][a-z0-9_]{0,39}$`.
- **Values:** a string of at most 256 characters, a finite number, a boolean, or null. Objects and arrays are not allowed, so every property can be a column.

The map MAY change during a run. Each snapshot carries the whole current map, and the last stored snapshot wins. Properties MUST NOT contain personal data: no names, email addresses, phone numbers or free-form user input.

A property is for slicing runs. A trait of the person, such as a subscription state, belongs to the backend's identify call. The analytics side MAY join those traits the same way it derives country.

### 3.5 Manifest (D17, D18)

The manifest is declared once, when the run starts, and repeated unchanged in every snapshot: the schema requires `manifest` in each one. `manifest.steps` lists every step the flow can show, in flow order, from 1 to 200 entries. A step key appears at most once. A screen shown at two different positions needs two keys.

A **position** is either:
- one step with no `slot`, or
- a run of consecutive steps that share a `slot`.

Steps in one slot are **alternatives**: different screens shown at the same point in the flow, of which a run is expected to see one. Steps that share a slot MUST be listed next to each other.

Who declares the manifest:
- **For a Studio-served flow**, it is the deployment's step list, and the tracker copies it into the payload.
- **For a hand-coded flow**, the app declares it when the run starts.

Either way the payload has the same shape, so ingest has one code path.

The rejected alternative was a step list inferred from the paths runs actually took. That list cannot place a step no run has seen yet. It cannot tell a skipped step from one that was not reached. And its order shifts every time a new path appears.

The first manifest the server receives for a `(onboarding.key, onboarding.version)` is canonical. A run declaring a different manifest for the same pair is kept, but excluded from funnels and reported as a version conflict. *Different* means the JSON values differ as defined in [section 5](#5-transport-d4-d12-d13-d27), rule 4: key order is ignored, an absent optional field equals `null`, and arrays are compared in order. Readers MAY merge funnels across versions of one key whose manifests are equal by the same definition.

The reserved version `draft` (D21) is exempt: there is no canonical manifest and no version-conflict handling for it, and its manifest may change from one run to the next. Readers exclude `draft` from funnels by default.

### 3.6 Steps (D9, D10)

`steps` holds 1 to 500 entries, one per screen shown, in the order shown:

| Field | Meaning |
|---|---|
| `step_key` | A key from the manifest. |
| `entered_at` | When the screen was shown. |
| `exited_at` | When the user left it. Null only on the last entry of an `in_progress` run; in a truncated run that entry may already be closed. |
| `answers` | What was answered on this visit. Empty when nothing was. |

**Back navigation** appends a new entry for the step returned to. Earlier entries are never rewritten.

**No skip mechanism.** A step the flow does not show has no entry, and there is no way to report a skip: no flag, no entry kind, no tracker call. Whether a run skipped a step is derived when the funnel is read. A declared step with no entry, on a run that went on to reach a later position or completed, counts as skipped rather than as a quit (see [section 6](#6-funnel-measures-d14-d15-d16)). This covers a step the app decides not to show, such as a permission prompt when the permission is already granted, and a step at the very end of the flow, because a completed run has reached every position.

**The last `exited_at`.** While the run is in progress, the last entry has `exited_at: null`, and every earlier entry has one. On completion, the tracker sets the last entry's `exited_at` to `completed_at` if it is still open, so every entry has an exit. In a truncated run ([3.9](#39-overflow-d26)) the last kept entry may already be closed; it keeps its own exit, so completion does not inflate its time on screen. A run that is quit keeps its null exit forever. That null is how "left on this screen" shows up in the data.

### 3.7 Answers (D11)

Each answer is `{ question_key, kind, value }`. Within one entry, `question_key` is unique. For a step with a single question, the step key is a good question key.

| `kind` | `value` | Aggregated as |
|---|---|---|
| `single` | One option key. | Runs per option. |
| `multi` | Option keys: unique, at most 50, possibly empty. | Runs that selected each option. The shares can add up to more than 100%. |
| `numeric` | A finite number, with an optional `unit` key. The unit MUST be the same for one question within one version. | A distribution. The reader chooses the buckets. |
| `text` | At most 1,000 characters. | **Never aggregated.** Free text is stored for each run, is never turned into a distribution, and is never shown in one. |

Option values MUST be the option's stable key, never its displayed label. Otherwise one option splits into one row per language.

If a run answers the same question on several visits, its effective answer is the one in the **last** entry that contains the question.

### 3.8 Limits (D8)

D8 sets the limits that bound ingest cost. The schema also enforces a few field-level limits, listed here so the two agree:

| Field | Limit |
|---|---|
| `properties` | At most 20 keys, each matching `^[a-z][a-z0-9_]{0,39}$`. String values at most 256 characters. |
| `manifest.steps` | 1 to 200 steps. |
| `steps` | 1 to 500 entries (see [3.9](#39-overflow-d26)). |
| `steps[].answers` | At most 50 answers per entry; a `multi` value holds at most 50 option keys. |
| `text` answer | At most 1,000 characters. |
| Whole snapshot | At most 256 KiB (262,144 bytes) serialized. This is the one limit the schema cannot express. The tracker stops recording at a budget of 261,120 bytes ([3.9](#39-overflow-d26)). The ingest rejects a larger snapshot with `{ "outcome": "rejected" }` ([section 5](#5-transport-d4-d12-d13-d27), rule 2). The exception is a run already completed: such a snapshot is ignored, because rule 1 runs first. |
| Keys | 1 to 128 characters from `A–Z a–z 0–9 _ . : -`, starting with a letter or a digit. |
| `onboarding.version` | 1 to 64 characters from `A–Z a–z 0–9 _ . : + -`, starting with a letter or a digit. |
| `context.app_version`, `build`, `os_version`, `library_version` | 1 to 32 characters. |
| `context.timezone` | At most 64 characters. |
| `context.locale` | A BCP 47 tag: `^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$`. |
| `studio.*` links | 1 to 128 characters. |
| Timestamps | Exactly three fractional digits (D24). |

### 3.9 Overflow (D26)

A run that would break the entry limit or the size limit is **truncated**, not dropped. `truncated: true` means the tracker has **stopped recording**. It is set when recording one more thing would take the snapshot past 500 entries or past the **recording budget**. That thing can be a new entry, or growth inside an entry: a new answer, or a new or changed property.

The recording budget is **261,120 bytes**: 256 KiB (262,144 bytes) minus 1 KiB of headroom.
- **What is measured:** the tracker measures the serialized snapshot in the form its completion send would take: `status` `completed`, `completed_at` set, and every open exit set.
- **What the headroom covers:** the bytes that land after that measure. These are the `,"truncated":true` flag (17 bytes) and `seq` gaining digits on later sends (at most 15 bytes: a JSON-safe integer has at most 16 digits).
- **Result:** every later send, the completion included, stays within the ingest's 256 KiB hard limit.

When the limit would be crossed, the tracker:

1. does not record the change that would cross it, and records no further entries, answers or property changes for the rest of the run;
2. closes the current entry when the user leaves it, as usual. When the limit is hit by a new entry, the user has just left the current screen, so it is closed at once;
3. sets `truncated: true` on the snapshot, and keeps it there in every later snapshot;
4. keeps sending the run. In particular it MUST send the `completed` status when the run completes, so the run counts as Completed rather than quit.

The first entries are kept, never the last. So `steps[0]` is still the run's first screen and rule 4 in [section 4](#4-rules-beyond-the-schema), `started_at` = `steps[0].entered_at`, still holds.

A truncated run follows rules 6 and 7 in their truncated form:
- Its last kept entry may already be closed while the run is `in_progress`.
- On completion that entry keeps its own exit, which is at or before `completed_at` instead of equal to it.
- On restore after relaunch it appends no entry ([3.2](#32-run-d3-d4)).

In the funnel ([section 6](#6-funnel-measures-d14-d15-d16)), a truncated run is counted like any other run, with one exception: the screen it was on after truncation is unknown. If it completes, it is Completed and has reached every position. If it goes quiet, it counts as Quit in the totals but in no position's *Quit here*.

This run loops between `question` and `review` 300 times. The tracker keeps its first 500 entries, and the run still completes. Entries `steps[2]` to `steps[498]` are elided here; the full payload is in [`onboarding-run.examples.ts`](onboarding-run.examples.ts):

<!-- overflow -->
```jsonc
{
  "schema_version": 1,
  "run_id": "00000000-0000-4000-8000-000000000401",
  "seq": 502,
  "status": "completed",
  "started_at": "2026-01-10T07:00:00.000Z",
  "completed_at": "2026-01-10T08:40:20.000Z",
  "sent_at": "2026-01-10T08:40:20.000Z",
  "onboarding": { "key": "example-long", "version": "1" },
  "context": {
    "app_version": "2.4.0",
    "build": "412",
    "platform": "ios",
    "os_version": "18.1",
    "locale": "en-US",
    "timezone": "America/New_York"
  },
  "manifest": {
    "steps": [
      { "step_key": "welcome" },
      { "step_key": "question" },
      { "step_key": "review" },
      { "step_key": "summary" }
    ]
  },
  "truncated": true,
  "steps": [
    {
      "step_key": "welcome",
      "entered_at": "2026-01-10T07:00:00.000Z",
      "exited_at": "2026-01-10T07:00:10.000Z",
      "answers": []
    },
    {
      "step_key": "question",
      "entered_at": "2026-01-10T07:00:10.000Z",
      "exited_at": "2026-01-10T07:00:20.000Z",
      "answers": []
    },
    /* steps[2] to steps[498] elided */
    {
      "step_key": "question",
      "entered_at": "2026-01-10T08:23:10.000Z",
      "exited_at": "2026-01-10T08:23:20.000Z",
      "answers": []
    }
  ]
}
```

## 4. Rules beyond the schema

JSON Schema cannot express these rules, so the ingest MUST check them. A snapshot that breaks one of them is rejected whole, and the tracker MUST NOT resend it unchanged.

1. Every `steps[].step_key` appears in `manifest.steps`.
2. Manifest step keys are unique, and steps that share a `slot` are listed next to each other.
3. Entries are in chronological order: `entered_at` never decreases.
4. `started_at` equals `steps[0].entered_at`.
5. On every entry, `exited_at` is null or not earlier than `entered_at`.
6. Only the last entry may have a null `exited_at`, and it MUST be null when `status` is `in_progress`. **Truncated form:** when `truncated` is set, the last entry MAY also have an exit while `in_progress`.
7. When `status` is `completed`, the last entry's `exited_at` equals `completed_at`. **Truncated form:** when `truncated` is set, it is set and at or before `completed_at`.
8. `question_key` is unique within an entry.

These rules apply to one snapshot. The rules between snapshots of one run (identity, manifest, `seq`, completion) are acceptance rules, in [section 5](#5-transport-d4-d12-d13-d27).

The JSON Schema itself also requires the following:
- `completed_at` is set exactly when `status` is `completed`.
- The schema is closed: an unknown field is an error.
- Keys, timestamps and UUIDs match their patterns.
- The limits in [3.8](#38-limits-d8) hold, except the snapshot size.

## 5. Transport (D4, D12, D13, D27)

**Full snapshots, not deltas.** Every send carries the whole run so far.

**Who is sending.** The server identifies a run by the sender plus `run_id`. The sender is whatever the transport authenticates, such as an installation id and an application id. The sender is not part of the payload, which keeps device identifiers out of it.

### Acceptance rules

For each incoming snapshot, the server looks up the stored snapshot for the same sender and `run_id`, then applies these rules in order. The first rule that matches decides the outcome.

1. **Completed guard.** If the stored snapshot is `completed`, the incoming one is **ignored**, whatever its `seq`, its status or its validity. An `in_progress` snapshot never overwrites a completed run. If two completed snapshots arrive, the first one stored wins, and later ones are ignored.
2. **Validation.** A snapshot is **rejected** if it:
   - is larger than 256 KiB serialized (D8), which is checked before schema validation;
   - fails the schema of its `schema_version` (see [section 8](#8-versioning-d19-d20));
   - or breaks a rule in [section 4](#4-rules-beyond-the-schema).
3. **New run.** With nothing stored, the snapshot is **accepted** and stored.
4. **Identity and manifest.** A snapshot whose `onboarding` or `manifest` differs from the stored one is **rejected**: a run's identity and its declared step list never change within the run. Here *differs* means JSON values are unequal, compared:
   - without regard to object key order;
   - with an absent optional field equal to `null`, so a `variant_key` of `null` equals no `variant_key`;
   - with arrays compared in order.

   (The context is not compared: the server pins it from the first stored snapshot and ignores later differences, see [3.3](#33-context-d5-d6).)
5. **Higher `seq`.** A snapshot with a higher `seq` than the stored one is **accepted** and replaces it.
6. **Equal `seq`.** A snapshot with the same `seq` is a retry and is **ignored**: a retry is always safe. If its body differs from the stored one, the stored one is kept and the difference is logged.
7. **Lower `seq`.** A snapshot with a lower `seq` is stale and is **ignored**.

Every case, with the outcome it gets:

<!-- acceptance -->
| Case | Stored snapshot | Incoming snapshot | Outcome |
|---|---|---|---|
| A1 | none | `in_progress`, valid | accepted |
| A2 | `in_progress`, `seq` 3 | `completed`, `seq` 8 | accepted |
| A3 | `in_progress`, `seq` 3 | `in_progress`, `seq` 4 | accepted |
| A4 | `in_progress`, `seq` 3 | the same snapshot again (a retry) | ignored |
| A5 | `in_progress`, `seq` 3 | `seq` 3 with a different body | ignored |
| A6 | `in_progress`, `seq` 3 | `in_progress`, `seq` 2 | ignored |
| A7 | `completed`, `seq` 8 | `in_progress`, `seq` 9 | ignored |
| A8 | `completed`, `seq` 8 | `completed`, `seq` 9 | ignored |
| A9 | `in_progress`, `seq` 3 | `status` `quit`, which fails the schema | rejected |
| A10 | `in_progress`, `seq` 3 | `seq` 4 with a different `onboarding.version` | rejected |
| A11 | `completed`, `seq` 8 | `status` `quit`, which fails the schema | ignored |
| A12 | `in_progress`, `seq` 3 | `seq` 4 with a different `manifest` | rejected |
| A13 | `in_progress`, `seq` 3 | `seq` 4, otherwise valid, larger than 256 KiB | rejected |
| A14 | `in_progress`, `seq` 3, no `variant_key` | `seq` 4 with `variant_key` `null` | accepted |
| A15 | `in_progress`, `seq` 3 | `seq` 4 with the keys of `onboarding` and of each manifest step in another order | accepted |

### Outcomes and retries

The server answers every snapshot with exactly one outcome, carried **in the response body** as `{ "outcome": "accepted" }`, `{ "outcome": "ignored" }` or `{ "outcome": "rejected", "reason": "…" }`. A rejection SHOULD use a 4xx status, for example 413 for a snapshot over 256 KiB. **The body is what counts, never the status alone.**

| Outcome | Meaning | What the tracker does |
|---|---|---|
| `accepted` | The snapshot is now the stored one. | Drops it from its send queue. |
| `ignored` | The server already holds this snapshot, a newer one, or a completed one. | Drops it. This is a success, not an error. |
| `rejected` | The snapshot is invalid and will never be accepted. This is a permanent failure. | Drops it, MUST NOT resend it unchanged, and reports it locally, for example in a debug log. |
| *transient* | Any response without one of these outcomes in its body, whatever its status, or no response at all. | Keeps the snapshot and retries later with the same `seq` and body, backing off between attempts. |

A response counts as `rejected` **only** when its body says `"outcome": "rejected"`. Some responses carry no outcome body, for example a 401, 404 or 413 from a proxy or gateway. Those are transient, because they may say nothing about the snapshot. So a completed snapshot is never dropped on an unclear response, and a retry is always safe, because the server ignores what it already holds.

<!-- responses -->
| Case | Response | Tracker |
|---|---|---|
| R1 | 200, body `{ "outcome": "accepted" }` | drops it |
| R2 | 200, body `{ "outcome": "ignored" }` | drops it |
| R3 | 400, body `{ "outcome": "rejected", "reason": "…" }` | drops it permanently |
| R4 | 401, no body | retries with backoff |
| R5 | 413, a body with no outcome | retries with backoff |
| R6 | 503, no body | retries with backoff |
| R7 | 200, no body | retries with backoff |
| R8 | no response, or a timeout | retries with backoff |

**Server time.** The server stamps its own receive time on every snapshot it accepts, and keeps `first_received_at` and `last_received_at` for the run.
- A run belongs to the time bucket of its `first_received_at`, so its bucket never moves.
- The quit threshold (D14) is measured from `last_received_at`.
- Client timestamps are used only for differences within one run, such as time spent on a step, because they all come from one clock.

**When to send.** A tracker SHOULD send:
- on every step entry,
- on completion,
- when the app moves to the background.

It MUST keep the latest unsent snapshot across app restarts (see *Resume after relaunch* in [3.2](#32-run-d3-d4)). A snapshot is at most 256 KiB serialized; past that, see [3.9](#39-overflow-d26).

## 6. Funnel measures (D14, D15, D16)

A funnel is drawn for one `(onboarding.key, onboarding.version)`, optionally for one `variant_key`. It covers the runs whose `first_received_at` falls in the chosen range, minus runs with a version conflict. It is computed at a moment *now*.

For each run *r*:

- **viewed(r)** is the set of step keys of *r*'s entries.
- **furthest(r)** is infinite if *r* is completed. Otherwise it is the highest position among *r*'s entries.
- **last_seen(r)** is the step key of *r*'s last entry. A truncated run ([3.9](#39-overflow-d26)) has no last_seen, because its last screen was not recorded.
- ***r* is quit** when it is `in_progress` and *now* − `last_received_at` ≥ 24 hours.
- ***r* is still in progress** when it is neither completed nor quit.

For each position *p*, with member steps *M* (one step, or a slot's alternatives):

| Measure | Definition |
|---|---|
| **Still in the flow** | Runs with furthest(r) ≥ *p*: the runs that got at least as far as this position. |
| **Saw it** | Runs where viewed(r) includes a step in *M*. |
| **Skipped** | Still in the flow − Saw it: runs that got past this position without seeing any of its screens. Derived here, never sent: the run has no entry for the position but reached a later one, or completed. |
| **Quit here** | Quit runs where last_seen(r) is in *M*. |
| **Quit rate** | Quit here ÷ Saw it. Shown as `—` when Saw it is 0. |

In the tables below the quit rate is rounded to the nearest whole percent.

For a slot, the row describes the position as a whole. Under it, each alternative gets a row with its own *Saw it*, *Quit here* and quit rate. *Still in the flow* and *Skipped* are reported for the slot only, because seeing one alternative is not skipping the other.

Totals: **Started** counts every run. Each run is then exactly one of **Completed**, **Quit** or **Still in progress**.

These consequences follow from the definitions and can be checked in every example below:

- A run counts **once per position**, however many times it visits (back navigation).
- Saw it ≤ Still in the flow at every position.
- Started = Still in the flow(*p*) + runs whose furthest(r) < *p*, at every position *p*.
- A run whose furthest position is before *p* is counted in no column at *p*. It shows up only in the totals, as Quit or Still in progress. A missing entry therefore reads as a skip only when the run went further; otherwise the run left, or has not arrived yet.
- *Quit here* belongs to the last screen the user saw. If they had gone further and navigated back before leaving, the quit belongs to the screen they went back to.

*Still in the flow* means "reached this position" (D16). A reading of "every run that has neither completed nor quit" would give the same number at every position, so it could not be drawn as a funnel.

## 7. Worked examples

In all three examples the funnel is computed at `2026-01-12T00:00:00.000Z`, with the 24-hour quit threshold (D14). The complete payload of every run is in [`onboarding-run.examples.ts`](onboarding-run.examples.ts). The path column lists each run's entries: the screens it was shown, in order.

### 7.1 A skipped step

Manifest: `welcome`, `goal`, `experience`, `permissions`, `summary`.

The flow passes over two steps, and the app reports neither:
- It does not show `experience` when the goal answer is `learn`.
- It does not show `permissions` when the permission is already granted.

In both cases the run simply has no entry for the step. The funnel derives the skip from the manifest.

<!-- funnel:derived_skip-runs -->
| Run | Status | Path | Last snapshot received | Counts as |
|---|---|---|---|---|
| r1 | completed | welcome → goal → permissions → summary | 2026-01-10T09:00:40.300Z | Completed |
| r2 | completed | welcome → goal → experience → goal → experience → summary | 2026-01-10T09:16:00.300Z | Completed |
| r3 | in_progress | welcome → goal → experience | 2026-01-10T09:30:20.300Z | Quit |
| r4 | in_progress | welcome → goal → permissions | 2026-01-10T09:45:20.300Z | Quit |
| r5 | in_progress | welcome | 2026-01-11T23:00:00.300Z | Still in progress |
| r6 | in_progress | welcome | 2026-01-10T10:00:00.300Z | Quit |

r2 went back from `experience` to `goal` once, and was never shown `permissions`, so its payload has no entry for it:

```json
{
  "schema_version": 1,
  "run_id": "00000000-0000-4000-8000-000000000102",
  "seq": 7,
  "status": "completed",
  "started_at": "2026-01-10T09:15:00.000Z",
  "completed_at": "2026-01-10T09:16:00.000Z",
  "sent_at": "2026-01-10T09:16:00.000Z",
  "onboarding": { "key": "example-skip", "version": "1" },
  "context": {
    "app_version": "2.4.0",
    "build": "412",
    "platform": "ios",
    "os_version": "18.1",
    "locale": "en-US",
    "timezone": "America/New_York"
  },
  "manifest": {
    "steps": [
      { "step_key": "welcome" },
      { "step_key": "goal" },
      { "step_key": "experience" },
      { "step_key": "permissions" },
      { "step_key": "summary" }
    ]
  },
  "steps": [
    {
      "step_key": "welcome",
      "entered_at": "2026-01-10T09:15:00.000Z",
      "exited_at": "2026-01-10T09:15:10.000Z",
      "answers": []
    },
    {
      "step_key": "goal",
      "entered_at": "2026-01-10T09:15:10.000Z",
      "exited_at": "2026-01-10T09:15:20.000Z",
      "answers": [{ "question_key": "goal", "kind": "single", "value": "practice" }]
    },
    {
      "step_key": "experience",
      "entered_at": "2026-01-10T09:15:20.000Z",
      "exited_at": "2026-01-10T09:15:30.000Z",
      "answers": []
    },
    {
      "step_key": "goal",
      "entered_at": "2026-01-10T09:15:30.000Z",
      "exited_at": "2026-01-10T09:15:40.000Z",
      "answers": [{ "question_key": "goal", "kind": "single", "value": "practice" }]
    },
    {
      "step_key": "experience",
      "entered_at": "2026-01-10T09:15:40.000Z",
      "exited_at": "2026-01-10T09:15:50.000Z",
      "answers": []
    },
    {
      "step_key": "summary",
      "entered_at": "2026-01-10T09:15:50.000Z",
      "exited_at": "2026-01-10T09:16:00.000Z",
      "answers": []
    }
  ]
}
```

Funnel:

<!-- funnel:derived_skip -->
| Step | Still in the flow | Saw it | Skipped | Quit here | Quit rate |
|---|---|---|---|---|---|
| `welcome` | 6 | 6 | 0 | 1 | 17% |
| `goal` | 4 | 4 | 0 | 0 | 0% |
| `experience` | 4 | 2 | 2 | 1 | 50% |
| `permissions` | 3 | 2 | 1 | 1 | 50% |
| `summary` | 2 | 2 | 0 | 0 | 0% |

<!-- totals:derived_skip -->
Started 6 · Completed 2 · Quit 3 · Still in progress 1

How to read it:
- **Skips at `experience`.** Two runs saw `experience`, but four got that far. r1 and r4 have no entry for it, yet each reached a later position, so they count as skipped, not quit.
- **The drop at `welcome`.** r5 was last heard from one hour before the funnel was computed, so it is still in progress rather than quit. It is counted at `welcome` but not at `goal`. That is why *Still in the flow* falls from 6 to 4 with only one quit.
- **The skip at `permissions`.** r2 has no entry for it and completed, so it reached every position: it counts as skipped there. r3 has no entry either, but it quit at `experience` before reaching `permissions`, so it is not counted at `permissions` at all.
- **Back navigation.** r2 visited `goal` and `experience` twice each, but is counted once at each.

A count of step views alone would read `experience` as a fall from 4 to 2 and call it a drop. The quit rate shows that only one of the two runs that saw it left there.

### 7.2 Two alternative screens at one position

Manifest: `welcome`, `goal`, then slot `plan` holding `plan_quick` and `plan_detailed`, then `summary`. The `pace` answer on `goal` decides which plan screen is shown.

<!-- funnel:alternative_screens-runs -->
| Run | Status | Path | Last snapshot received | Counts as |
|---|---|---|---|---|
| r1 | completed | welcome → goal → plan_quick → summary | 2026-01-10T09:00:40.300Z | Completed |
| r2 | completed | welcome → goal → plan_detailed → summary | 2026-01-10T09:15:40.300Z | Completed |
| r3 | in_progress | welcome → goal → plan_detailed | 2026-01-10T09:30:20.300Z | Quit |
| r4 | completed | welcome → goal → plan_quick → summary | 2026-01-10T09:45:40.300Z | Completed |
| r5 | in_progress | welcome → goal | 2026-01-10T10:00:10.300Z | Quit |

r3 was shown the detailed plan and left there:

```json
{
  "schema_version": 1,
  "run_id": "00000000-0000-4000-8000-000000000203",
  "seq": 3,
  "status": "in_progress",
  "started_at": "2026-01-10T09:30:00.000Z",
  "completed_at": null,
  "sent_at": "2026-01-10T09:30:20.000Z",
  "onboarding": { "key": "example-slot", "version": "1" },
  "context": {
    "app_version": "2.4.0",
    "build": "412",
    "platform": "ios",
    "os_version": "18.1",
    "locale": "en-US",
    "timezone": "America/New_York"
  },
  "manifest": {
    "steps": [
      { "step_key": "welcome" },
      { "step_key": "goal" },
      { "step_key": "plan_quick", "slot": "plan" },
      { "step_key": "plan_detailed", "slot": "plan" },
      { "step_key": "summary" }
    ]
  },
  "steps": [
    {
      "step_key": "welcome",
      "entered_at": "2026-01-10T09:30:00.000Z",
      "exited_at": "2026-01-10T09:30:10.000Z",
      "answers": []
    },
    {
      "step_key": "goal",
      "entered_at": "2026-01-10T09:30:10.000Z",
      "exited_at": "2026-01-10T09:30:20.000Z",
      "answers": [{ "question_key": "pace", "kind": "single", "value": "detailed" }]
    },
    {
      "step_key": "plan_detailed",
      "entered_at": "2026-01-10T09:30:20.000Z",
      "exited_at": null,
      "answers": []
    }
  ]
}
```

Funnel:

<!-- funnel:alternative_screens -->
| Step | Still in the flow | Saw it | Skipped | Quit here | Quit rate |
|---|---|---|---|---|---|
| `welcome` | 5 | 5 | 0 | 0 | 0% |
| `goal` | 5 | 5 | 0 | 1 | 20% |
| slot `plan` | 4 | 4 | 0 | 1 | 25% |
| ↳ `plan_quick` | — | 2 | — | 0 | 0% |
| ↳ `plan_detailed` | — | 2 | — | 1 | 50% |
| `summary` | 3 | 3 | 0 | 0 | 0% |

<!-- totals:alternative_screens -->
Started 5 · Completed 3 · Quit 2 · Still in progress 0

How to read it:
- **The slot row.** Every run that reached the plan position saw one of the two screens, so the slot shows no skips.
- **The alternative rows.** They compare the two screens directly: `plan_detailed` lost one of its two viewers, `plan_quick` none.
- **Without a slot.** Each plan screen would sit at its own position. Every run that saw the other screen would then count as a skip, and half of all traffic would look routed around both screens.

### 7.3 Branches that merge back

Manifest: `welcome`, `goal`, then slot `routine` holding `routine_a1` and `routine_b1`, then `routine_a2`, then `summary`. Path `a` is two screens long (`routine_a1` → `routine_a2`), path `b` is one screen (`routine_b1`), and both continue to `summary`.

<!-- funnel:merge_back-runs -->
| Run | Status | Path | Last snapshot received | Counts as |
|---|---|---|---|---|
| r1 | completed | welcome → goal → routine_a1 → routine_a2 → summary | 2026-01-10T09:00:50.300Z | Completed |
| r2 | in_progress | welcome → goal → routine_a1 | 2026-01-10T09:15:20.300Z | Quit |
| r3 | completed | welcome → goal → routine_b1 → summary | 2026-01-10T09:30:40.300Z | Completed |
| r4 | in_progress | welcome → goal → routine_b1 | 2026-01-10T09:45:20.300Z | Quit |
| r5 | completed | welcome → goal → routine_b1 → summary | 2026-01-10T10:00:40.300Z | Completed |

r3 took the short path and merged back at `summary`:

```json
{
  "schema_version": 1,
  "run_id": "00000000-0000-4000-8000-000000000303",
  "seq": 5,
  "status": "completed",
  "started_at": "2026-01-10T09:30:00.000Z",
  "completed_at": "2026-01-10T09:30:40.000Z",
  "sent_at": "2026-01-10T09:30:40.000Z",
  "onboarding": { "key": "example-merge", "version": "1" },
  "context": {
    "app_version": "2.4.0",
    "build": "412",
    "platform": "ios",
    "os_version": "18.1",
    "locale": "en-US",
    "timezone": "America/New_York"
  },
  "manifest": {
    "steps": [
      { "step_key": "welcome" },
      { "step_key": "goal" },
      { "step_key": "routine_a1", "slot": "routine" },
      { "step_key": "routine_b1", "slot": "routine" },
      { "step_key": "routine_a2" },
      { "step_key": "summary" }
    ]
  },
  "steps": [
    {
      "step_key": "welcome",
      "entered_at": "2026-01-10T09:30:00.000Z",
      "exited_at": "2026-01-10T09:30:10.000Z",
      "answers": []
    },
    {
      "step_key": "goal",
      "entered_at": "2026-01-10T09:30:10.000Z",
      "exited_at": "2026-01-10T09:30:20.000Z",
      "answers": [{ "question_key": "path", "kind": "single", "value": "b" }]
    },
    {
      "step_key": "routine_b1",
      "entered_at": "2026-01-10T09:30:20.000Z",
      "exited_at": "2026-01-10T09:30:30.000Z",
      "answers": []
    },
    {
      "step_key": "summary",
      "entered_at": "2026-01-10T09:30:30.000Z",
      "exited_at": "2026-01-10T09:30:40.000Z",
      "answers": []
    }
  ]
}
```

Funnel:

<!-- funnel:merge_back -->
| Step | Still in the flow | Saw it | Skipped | Quit here | Quit rate |
|---|---|---|---|---|---|
| `welcome` | 5 | 5 | 0 | 0 | 0% |
| `goal` | 5 | 5 | 0 | 0 | 0% |
| slot `routine` | 5 | 5 | 0 | 2 | 40% |
| ↳ `routine_a1` | — | 2 | — | 1 | 50% |
| ↳ `routine_b1` | — | 3 | — | 1 | 33% |
| `routine_a2` | 3 | 1 | 2 | 0 | 0% |
| `summary` | 3 | 3 | 0 | 0 | 0% |

<!-- totals:merge_back -->
Started 5 · Completed 3 · Quit 2 · Still in progress 0

How to read it:
- **Where the branches split.** The first screen of each path shares the `routine` slot. The longer path's second screen, `routine_a2`, is a position of its own.
- **The skips at `routine_a2`.** r3 and r5 took path `b` and reached `summary` without seeing `routine_a2`, so they are its two skips. Its one viewer is r1: the other path-`a` run, r2, quit before reaching it.
- **After the merge.** *Still in the flow* stays at 3 from `routine_a2` to `summary`, so nobody was lost after the branches joined.

## 8. Versioning (D19, D20)

### `onboarding.version`: the flow's revision

`onboarding.version` MUST change when:
- the manifest changes in any way: a step added, removed, reordered or renamed, or a slot changed;
- a question's `question_key`, its option keys or its `kind` change;
- a numeric question's unit changes.

It SHOULD change when a screen's content changes enough that before and after should not be compared. It MAY stay the same for a copy or visual change.

The reserved version `draft` (D21) is exempt from all of this: a draft's manifest and questions may change without a version change.

A Studio-served flow uses the deployment id, so every publish is a new version. Readers who want one funnel across publishes merge the versions whose manifests are equal, in the sense of section 5, rule 4 (see [3.5](#35-manifest-d17-d18)).

### `schema_version`: this document's revision

The schema is closed, so any change to it is a new `schema_version`. The tracker sends the version it was built against. The ingest MUST keep accepting every `schema_version` it has ever accepted, and validates each payload against the schema of its own version. Each version gets its own schema file.

- **Additive:** a payload of the previous version, relabelled with the new number, is valid under the new schema. The ingest stores both versions without conversion. Examples:
  - a new optional field or object;
  - a limit loosened;
  - a new `context.platform` value.
- **Breaking:** every other change. The new version's contract MUST define how older payloads convert to it. Examples:
  - a field removed, renamed, or changed in type or meaning;
  - an optional field made required;
  - a limit tightened;
  - a new `status` or answer `kind` (readers branch on both);
  - any change to the rules in [section 4](#4-rules-beyond-the-schema) or to the meaning of an entry or of `exited_at`.

## 9. Pre-v1 payloads (D22, D23)

Before this contract, a client sent one snapshot per sender, with no run id. The sender and platform came from the transport:

```jsonc
{
  "onboarding_metadata": { /* free-form */ },
  "responses": [
    { "step_id": "…", "entered_at": "…", "exited_at": null, "answers": { "<element id>": "<value>" } }
  ],
  "sent_at": "…"
}
```

For Studio-served flows, `onboarding_metadata` is the onboarding SDK's `metadata` object: `id`, `onboardingId`, `name`, `onboardingName`, `audienceId`, `audienceName`, `audienceOrder`, `locale`, `startStepId` and `draft`. Hand-coded senders put whatever they chose there. Completion arrived separately, as its own completion event.

The server converts each stored pre-v1 snapshot into a v1-shaped row. Such rows are never sent in this form.

| v1 | From the pre-v1 payload |
|---|---|
| `schema_version` | `0`, meaning converted. |
| `run_id` | A UUIDv5 of the sender and the first `entered_at`, so converting again gives the same id. When the sender's only row is overwritten by a new run, the new run gets a new id, and the old one is lost, as it already was. |
| `seq` | Not applicable. Pre-v1 rows were ordered by `sent_at`. A row whose stored `sent_at` is in the future could never be updated, and the conversion cannot recover what it missed. |
| `status`, `completed_at` | `completed`, at the completion event's time, when the same sender has a completion event at or after the first `entered_at`. Otherwise `in_progress`. |
| `onboarding.key` | `onboardingId`, or `onboarding_id` from a hand-coded sender. With neither, the run is unattributed: it is stored but excluded from funnels. |
| `onboarding.version` | `legacy:<deployment id>`, using the deployment resolved below, or `legacy` when none can be resolved. |
| `onboarding.variant_key` | null. |
| `studio.onboarding_id` | `onboardingId`. |
| `studio.audience_id` | `audienceId`, unless it is `"none"`. That value means no audience matched, so the link is null. |
| `studio.deployment_id` | `deployment_id` if the sender set it. Otherwise it is resolved by time (D23): the deployment live for the run's audience when the row was first received. An audience can pin a deployment, so the audience's own deployment is used, not the onboarding's latest. Null when it cannot be resolved. |
| `context.platform` | From the transport. |
| `context.locale` | `locale` from the metadata. |
| Other `context` fields | Null, unless the ingest fills them from the sender's device context recorded closest to the first `entered_at`. |
| `manifest` | The step list of the resolved deployment. Without a resolved deployment there is no manifest, and the run is excluded from funnels. |
| `steps` | `responses` in order: `step_id` becomes `step_key`. On a completed run, a null last `exited_at` becomes `completed_at`. |
| `answers` | One answer per key of the `answers` map. The key becomes `question_key`; it is whatever the sender used, an element id or a generic key such as `answer`. An array of strings becomes `multi` and a number becomes `numeric`. A string becomes `single` when the deployment defines the step as a choice question, and `text` otherwise: the pre-v1 shape cannot tell them apart. Any other value is dropped. |

Pre-v1 answer values are whatever the sender recorded. That may be a displayed label rather than an option key, so the guarantee in D11 does not hold for converted runs, and their answer distributions can split by language.

Two kinds of pre-v1 row are excluded from funnels:
- `draft: true` rows, which are preview traffic.
- Rows whose steps are not in the reconstructed manifest, which are flagged as version conflicts.

## 10. Reference tracker

The reference implementation is the headless package `@rocapine/rocalytics-sdk`. Apps import the tracker from its `/onboarding` subpath:

```ts
import { onboardingRun } from "@rocapine/rocalytics-sdk/onboarding";
```

- **Zero-dependency core.** It needs nothing beyond `react`. The clock, the id generator and the run context are injected, so the core has no platform dependency and tests can supply fixed values.
- **Pluggable sinks.** The tracker produces snapshots in this contract's shape, and a sink delivers them. A backend adapter is a sink, which keeps the contract backend-neutral. A sink MAY also forward derived events to another analytics tool; those events are outside this contract.
- **Tracking stands alone.** The tracking module never imports remote-control code, and the heavier dependencies of remote control are optional peers. An app that only tracks does not install them.
- **Studio-served flows.** The existing onboarding SDK emits through the same tracker, so a Studio-served flow and a hand-coded one produce identical payloads.
