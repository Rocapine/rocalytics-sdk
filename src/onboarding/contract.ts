// Onboarding run contract, schema_version 1: TypeScript types.
//
// The normative text is onboarding-run-contract.md; the machine-checkable shape
// is onboarding-run.schema.json. These types mirror the schema. Where a rule is
// a pattern or a limit (key characters, list lengths), the type says `string`
// or `T[]` and the comment names the rule; the schema enforces it.
//
// This file has no imports, so it can be copied into any TypeScript project.

/**
 * RFC 3339 timestamp in UTC with exactly three fractional digits and a `Z`
 * suffix, e.g. `2026-01-10T09:00:00.000Z`.
 */
export type Timestamp = string;

/**
 * An identifier chosen by the app: 1 to 128 characters from `A-Z a-z 0-9 _ . : -`,
 * starting with a letter or digit. Case-sensitive. Used for onboarding, step,
 * question, option, slot and variant keys.
 */
export type Key = string;

export interface OnboardingIdentity {
  /**
   * Stable key for one flow. Never reused for a different flow. Each
   * Studio-served A/B arm is its own onboarding, so it has its own key.
   */
  key: Key;
  /**
   * Revision of the flow. 1 to 64 characters from `A-Z a-z 0-9 _ . : + -`,
   * starting with a letter or digit. Must change whenever the manifest changes,
   * except for the reserved version `draft`, which a Studio-served draft or
   * preview must send because it has no deployment id.
   */
  version: string;
  /**
   * In-flow variant, for an app that runs one flow (one key) with its own
   * variants. Not set for a Studio-served run. Absent or null otherwise.
   */
  variant_key?: Key | null;
}

/** Optional links to Studio records. Opaque strings of 1 to 128 characters; numeric ids are sent in decimal. */
export interface StudioLinks {
  onboarding_id?: string | null;
  deployment_id?: string | null;
  audience_id?: string | null;
}

/** Captured once, at run start, and repeated unchanged in every snapshot. */
export interface RunContext {
  /** Marketing version, e.g. `2.4.0`. 1 to 32 characters. */
  app_version: string;
  /** Build number, 1 to 32 characters, or null on a platform with no such concept. */
  build: string | null;
  platform: "ios" | "android" | "web";
  /** OS version, 1 to 32 characters, or null when the platform cannot report one. */
  os_version: string | null;
  /** BCP 47 language tag the onboarding is shown in, e.g. `fr-FR`. */
  locale: string;
  /** IANA time zone, e.g. `Europe/Paris`. At most 64 characters. */
  timezone: string;
  /** Version of the tracking library that produced the payload. 1 to 32 characters. */
  library_version?: string;
}

export interface ManifestStep {
  step_key: Key;
  /** Steps sharing a slot are alternatives shown at one position. Must be contiguous. */
  slot?: Key;
}

/** Declared once, at run start, and repeated unchanged in every snapshot. */
export interface Manifest {
  /** Every step the flow can show, in flow order. 1 to 200 entries. */
  steps: ManifestStep[];
}

/** Run-level custom property value. Strings are at most 256 characters; numbers are finite. */
export type PropertyValue = string | number | boolean | null;

/** At most 20 keys, each matching `^[a-z][a-z0-9_]{0,39}$`. */
export type Properties = Record<string, PropertyValue>;

export type Answer =
  | { question_key: Key; kind: "single"; value: Key }
  /** At most 50 option keys, unique. */
  | { question_key: Key; kind: "multi"; value: Key[] }
  | { question_key: Key; kind: "numeric"; value: number; unit?: Key }
  /** At most 1,000 characters. Never aggregated. */
  | { question_key: Key; kind: "text"; value: string };

/**
 * One visit to a screen the user was shown. A step that was not shown has no
 * entry; whether the run passed over it is derived from the manifest.
 */
export interface StepEntry {
  step_key: Key;
  entered_at: Timestamp;
  /**
   * Null only on the last entry of an in_progress run. In a truncated run the
   * last kept entry may already be closed, and keeps its own exit on completion.
   */
  exited_at: Timestamp | null;
  /** At most 50. `question_key` is unique within an entry. */
  answers: Answer[];
}

interface RunSnapshotBase {
  schema_version: 1;
  /** Client-minted, lowercase UUID. One per run. */
  run_id: string;
  /** Starts at 1 and increases with every send of this run. A retry reuses it. */
  seq: number;
  started_at: Timestamp;
  /** Client clock when this snapshot was sent. Advisory only. */
  sent_at: Timestamp;
  onboarding: OnboardingIdentity;
  studio?: StudioLinks;
  context: RunContext;
  manifest: Manifest;
  properties?: Properties;
  /**
   * Present once the tracker has stopped recording (no new entries, answers or
   * property changes) because recording more would break the 500-entry or
   * 256 KiB limit. What was recorded is kept.
   */
  truncated?: true;
  /** Every entry so far, in the order they happened. 1 to 500 entries. */
  steps: StepEntry[];
}

export interface InProgressRunSnapshot extends RunSnapshotBase {
  status: "in_progress";
  completed_at: null;
}

export interface CompletedRunSnapshot extends RunSnapshotBase {
  status: "completed";
  completed_at: Timestamp;
}

/** One send. Each send replaces the run's previous snapshot. */
export type OnboardingRunSnapshot = InProgressRunSnapshot | CompletedRunSnapshot;
