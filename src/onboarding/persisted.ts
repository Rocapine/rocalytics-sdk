// What the tracker keeps in storage, and the check every stored value goes
// through before use. Storage outlives app versions and can be corrupted, so
// nothing read from it is trusted: an invalid part is dropped and reported,
// and the stored value is then rewritten without it.
import type { Outbound } from "../core/delivery";
import type { OnboardingRunSnapshot } from "./contract";
import type { RunState } from "./state";

export interface Persisted {
  format: 1;
  /** The destination of the sink of the tracker that wrote it; absent when that sink had none. */
  destination?: string;
  current: RunState | null;
  outboxes: Record<string, Outbound<OnboardingRunSnapshot>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isTimestamp = (v: unknown) => typeof v === "string" && TIMESTAMP.test(v);
const isSeq = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1;

const isEntry = (e: unknown) =>
  isObj(e) &&
  typeof e.step_key === "string" &&
  isTimestamp(e.entered_at) &&
  (e.exited_at === null || isTimestamp(e.exited_at)) &&
  Array.isArray(e.answers) &&
  e.answers.every(isObj);

export function isRunState(v: unknown): v is RunState {
  if (!isObj(v)) return false;
  const { onboarding, context, manifest } = v;
  return (
    typeof v.runId === "string" && UUID.test(v.runId) &&
    typeof v.lastSeq === "number" && Number.isInteger(v.lastSeq) && v.lastSeq >= 0 &&
    isObj(onboarding) && typeof onboarding.key === "string" && typeof onboarding.version === "string" &&
    isObj(context) &&
    isObj(manifest) && Array.isArray(manifest.steps) && manifest.steps.length > 0 &&
    manifest.steps.every((s) => isObj(s) && typeof s.step_key === "string") &&
    Array.isArray(v.steps) && v.steps.every(isEntry) &&
    (v.studio === undefined || isObj(v.studio)) &&
    (v.properties === undefined || isObj(v.properties)) &&
    typeof v.provisionalExit === "boolean" &&
    typeof v.truncated === "boolean" &&
    (v.status === "in_progress" || v.status === "completed") &&
    (v.completedAt === null || isTimestamp(v.completedAt)) &&
    typeof v.lastActiveAt === "number" && Number.isFinite(v.lastActiveAt) &&
    (v.dirty === undefined || typeof v.dirty === "boolean")
  );
}

/** An unsent snapshot of run `runId`: a positive seq and a body that is that run's snapshot at that seq. */
export function isOutbound(runId: string, v: unknown): v is Outbound<OnboardingRunSnapshot> {
  if (!isObj(v) || !isSeq(v.seq) || !isObj(v.body)) return false;
  const b = v.body;
  return (
    b.run_id === runId &&
    b.seq === v.seq &&
    (b.status === "in_progress" || b.status === "completed") &&
    Array.isArray(b.steps) && b.steps.length > 0 &&
    isObj(b.manifest) && isObj(b.onboarding) && isObj(b.context)
  );
}

/** The usable parts of a stored value, and what was dropped. */
export function parsePersisted(raw: unknown): {
  current: RunState | null;
  outboxes: [string, Outbound<OnboardingRunSnapshot>][];
  problems: string[];
} {
  const problems: string[] = [];
  if (!isObj(raw) || raw.format !== 1) {
    return { current: null, outboxes: [], problems: ["unrecognised stored state"] };
  }
  let current: RunState | null = null;
  if (raw.current !== null && raw.current !== undefined) {
    if (isRunState(raw.current)) current = raw.current;
    else problems.push("the stored run is malformed");
  }
  const outboxes: [string, Outbound<OnboardingRunSnapshot>][] = [];
  if (isObj(raw.outboxes)) {
    for (const [runId, item] of Object.entries(raw.outboxes)) {
      if (isOutbound(runId, item)) outboxes.push([runId, item]);
      else problems.push(`the stored snapshot of run "${runId}" is malformed`);
    }
  } else if (raw.outboxes !== undefined) {
    problems.push("the stored snapshots are malformed");
  }
  return { current, outboxes, problems };
}
