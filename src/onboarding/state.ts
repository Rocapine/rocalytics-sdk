// The run as the tracker records it, and the pure operations on it. Every
// function returns a new state (or the same one when nothing changed); none
// reads the clock or does I/O, so each rule of the contract is testable here.
import { utf8ByteLength } from "../core/text";
import { toTimestamp } from "../core/time";
import type { WireRunContext } from "../core/context";
import type {
  Answer,
  Manifest,
  OnboardingIdentity,
  OnboardingRunSnapshot,
  Properties,
  StepEntry,
  StudioLinks,
} from "./contract";
import { MAX_ANSWERS } from "./input";

/** 256 KiB minus 1 KiB of headroom for what lands after the measure (D26). */
export const RECORDING_BUDGET = 261_120;
/** The most entries a snapshot holds (D8). */
export const MAX_ENTRIES = 500;

export interface RunState {
  runId: string;
  /** The last `seq` assigned to a send. 0 before the first. */
  lastSeq: number;
  onboarding: OnboardingIdentity;
  studio?: StudioLinks;
  context: WireRunContext;
  manifest: Manifest;
  properties?: Properties;
  /** Entries as recorded. The last one's exit may be provisional, see below. */
  steps: StepEntry[];
  /**
   * The last entry's `exited_at` was set by exitStep while the run goes on.
   * An in-progress snapshot of an untruncated run still sends it as null
   * (rule 6: only the current screen is open), until the next entry closes it
   * for good or completion replaces it with `completed_at` (rule 7).
   */
  provisionalExit: boolean;
  truncated: boolean;
  status: "in_progress" | "completed";
  completedAt: string | null;
  /** Last moment the app was known to be in the foreground on the current screen (3.2). Epoch ms. */
  lastActiveAt: number;
  /** A recorded change has not gone into a send yet (it is waiting on the debounce). */
  dirty?: boolean;
}

/** What an operation did, for the tracker to report. */
export type Note = "truncated" | "too-many-answers";
export interface Result {
  state: RunState;
  changed: boolean;
  notes: Note[];
}

const unchanged = (state: RunState, notes: Note[] = []): Result => ({ state, changed: false, notes });

/** The snapshot `state` sends with `seq` at `nowMs`, in the key order of the contract's examples. */
export function toSnapshot(state: RunState, seq: number, nowMs: number): OnboardingRunSnapshot {
  const steps = state.steps.map((e) => ({ ...e, answers: e.answers.slice() }));
  if (state.status === "in_progress" && !state.truncated && state.provisionalExit && steps.length) {
    steps[steps.length - 1].exited_at = null;
  }
  const head = {
    schema_version: 1 as const,
    run_id: state.runId,
    seq,
  };
  const tail = {
    sent_at: toTimestamp(nowMs),
    onboarding: state.onboarding,
    ...(state.studio ? { studio: state.studio } : {}),
    context: state.context,
    manifest: state.manifest,
    ...(state.properties ? { properties: state.properties } : {}),
    ...(state.truncated ? { truncated: true as const } : {}),
    steps,
  };
  const started_at = steps[0]?.entered_at ?? toTimestamp(nowMs);
  return state.status === "completed"
    ? { ...head, status: "completed", started_at, completed_at: state.completedAt as string, ...tail }
    : { ...head, status: "in_progress", started_at, completed_at: null, ...tail };
}

/** Completion as the contract defines it: every open exit closed at `completed_at`, a truncated run's closed exit kept. */
export function completeState(state: RunState, nowMs: number): RunState {
  const completedAt = toTimestamp(nowMs);
  const steps = state.steps.slice();
  const lastIndex = steps.length - 1;
  if (lastIndex >= 0) {
    const last = steps[lastIndex];
    const keepExit = state.truncated && last.exited_at !== null;
    if (!keepExit) steps[lastIndex] = { ...last, exited_at: completedAt };
  }
  return { ...state, steps, provisionalExit: false, status: "completed", completedAt };
}

/** Whether `state` stays within the recording budget, measured on its completion form with the next seq (D26). */
export function fits(state: RunState, nowMs: number): boolean {
  const form = toSnapshot(completeState(state, nowMs), state.lastSeq + 1, nowMs);
  return utf8ByteLength(JSON.stringify(form)) <= RECORDING_BUDGET;
}

const lastOf = (s: RunState) => s.steps[s.steps.length - 1] as StepEntry | undefined;

/** Closes the current entry for good: at its provisional exit if exitStep gave one, else at `at`. */
function closeCurrent(state: RunState, at: string): RunState {
  const last = lastOf(state);
  if (!last) return state;
  if (last.exited_at !== null && !state.provisionalExit) return state;
  const steps = state.steps.slice();
  steps[steps.length - 1] = { ...last, exited_at: last.exited_at ?? at };
  return { ...state, steps, provisionalExit: false };
}

function stopRecording(state: RunState): RunState {
  return { ...state, truncated: true };
}

/** A new screen is shown. */
export function enter(state: RunState, stepKey: string, nowMs: number): Result {
  const at = toTimestamp(nowMs);
  const closed = { ...closeCurrent(state, at), lastActiveAt: nowMs };
  if (state.truncated) return { state: closed, changed: closed.steps !== state.steps, notes: ["truncated"] };
  if (state.steps.length >= MAX_ENTRIES) return { state: stopRecording(closed), changed: true, notes: ["truncated"] };
  const next: RunState = {
    ...closed,
    steps: [...closed.steps, { step_key: stepKey, entered_at: at, exited_at: null, answers: [] }],
  };
  if (!fits(next, nowMs)) return { state: stopRecording(closed), changed: true, notes: ["truncated"] };
  return { state: next, changed: true, notes: [] };
}

/**
 * The user leaves the screen at `index` (the current entry, or the one just
 * before it when the next screen was entered first), with what they answered.
 */
export function exit(state: RunState, index: number, answers: Answer[], nowMs: number): Result {
  const notes: Note[] = [];
  let current = state;
  let changed = false;
  const isLast = index === state.steps.length - 1;

  if (current.truncated) {
    if (answers.length) notes.push("truncated");
  } else {
    for (const answer of answers) {
      const entry = current.steps[index];
      const at = entry.answers.findIndex((a) => a.question_key === answer.question_key);
      if (at < 0 && entry.answers.length >= MAX_ANSWERS) {
        notes.push("too-many-answers");
        continue;
      }
      const list = entry.answers.slice();
      if (at < 0) list.push(answer);
      else list[at] = answer;
      const steps = current.steps.slice();
      steps[index] = { ...entry, answers: list };
      const next = { ...current, steps };
      if (!fits(next, nowMs)) {
        current = stopRecording(current);
        notes.push("truncated");
        changed = true;
        break;
      }
      current = next;
      changed = true;
    }
  }

  // Record when the user left. In a truncated run that exit is final at once.
  const entry = current.steps[index];
  if (isLast && entry.exited_at === null) {
    const steps = current.steps.slice();
    steps[index] = { ...entry, exited_at: toTimestamp(nowMs) };
    current = { ...current, steps, provisionalExit: !current.truncated };
    changed = true;
  } else if (isLast && current.truncated && current.provisionalExit) {
    current = { ...current, provisionalExit: false };
    changed = true;
  }
  return changed ? { state: current, changed, notes } : unchanged(state, notes);
}

/** A new or changed property set: `merged` is the whole map after the change. */
export function setProperties(state: RunState, merged: Properties, nowMs: number): Result {
  if (JSON.stringify(merged) === JSON.stringify(state.properties ?? {})) return unchanged(state);
  if (state.truncated) return unchanged(state, ["truncated"]);
  const next = { ...state, properties: Object.keys(merged).length ? merged : undefined };
  if (!fits(next, nowMs)) return { state: stopRecording(state), changed: true, notes: ["truncated"] };
  return { state: next, changed: true, notes: [] };
}

/**
 * Restore after relaunch (3.2): close a still-open pre-kill entry at
 * last_active_at (never rewriting an exit already final), then append a new
 * entry for the restored screen at `nowMs`, unless the run is truncated or the
 * entry would break a limit, in which case recording stops instead.
 */
export function restore(state: RunState, nowMs: number): Result {
  const last = lastOf(state);
  if (!last) return unchanged(state);
  let current = state;
  if (last.exited_at === null || (state.provisionalExit && !state.truncated)) {
    const steps = state.steps.slice();
    steps[steps.length - 1] = { ...last, exited_at: toTimestamp(state.lastActiveAt) };
    current = { ...state, steps, provisionalExit: false };
  }
  current = { ...current, lastActiveAt: nowMs };
  if (current.truncated) return { state: current, changed: true, notes: [] };
  if (current.steps.length >= MAX_ENTRIES) return { state: stopRecording(current), changed: true, notes: ["truncated"] };
  const next: RunState = {
    ...current,
    steps: [...current.steps, { step_key: last.step_key, entered_at: toTimestamp(nowMs), exited_at: null, answers: [] }],
  };
  if (!fits(next, nowMs)) return { state: stopRecording(current), changed: true, notes: ["truncated"] };
  return { state: next, changed: true, notes: [] };
}

/** The latest moment recorded in the run, so a clock set backwards cannot make timestamps go back. */
export function floorMs(state: RunState): number {
  const last = lastOf(state);
  let floor = 0;
  if (last) {
    floor = Date.parse(last.entered_at);
    if (last.exited_at) floor = Math.max(floor, Date.parse(last.exited_at));
  }
  return floor;
}
