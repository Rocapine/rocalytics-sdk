// The tracker's public input types (camelCase, as an app writes them) and their
// validation against the contract. Anything that would make the ingest reject a
// snapshot is caught here, so the tracker never sends it.
import { codePointLength } from "../core/text";
import type { Answer, Manifest, OnboardingIdentity, Properties, PropertyValue, StudioLinks } from "./contract";

export interface OnboardingInput {
  /** A stable key for this flow. Never reused for a different flow. */
  key: string;
  /** The flow's revision. Must change whenever the manifest or a question's keys change. */
  version: string;
  /** An in-flow variant, for an app running one flow under one key with its own variants. */
  variantKey?: string | null;
}

export interface ManifestInput {
  /** Every step the flow can show, in flow order. Steps sharing a `slot` are alternatives at one position. */
  steps: { stepKey: string; slot?: string }[];
}

/**
 * Studio ids are strings. A number passed at run time (from untyped JSON, for
 * example) is sent in decimal when it is a safe non-negative integer; any
 * other number makes the start invalid.
 */
export interface StudioInput {
  /** Null and undefined both mean absent. */
  onboardingId?: string | null;
  /** Null and undefined both mean absent; a Studio-served run with none is a draft. */
  deploymentId?: string | null;
  audienceId?: string | null;
  /** A Studio draft or preview: always sent as version `draft`. */
  draft?: boolean;
}

interface StartBase {
  manifest: ManifestInput;
  /** Run-level scalar properties for slicing runs. No personal data. */
  properties?: Properties;
}

/**
 * Starts a run. Either the app declares `onboarding`, or a Studio-served flow
 * passes `studio.onboardingId` and the identity defaults to the Studio
 * onboarding id (key) and deployment id (version, `draft` without one).
 */
export type StartOptions =
  | (StartBase & { onboarding: OnboardingInput; studio?: StudioInput })
  | (StartBase & { onboarding?: undefined; studio: StudioInput & { onboardingId: string } });

export type AnswerInput =
  | { questionKey: string; kind: "single"; value: string }
  | { questionKey: string; kind: "multi"; value: string[] }
  | { questionKey: string; kind: "numeric"; value: number; unit?: string }
  | { questionKey: string; kind: "text"; value: string };

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,63}$/;
const PROPERTY_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const MAX_MANIFEST_STEPS = 200;
export const MAX_ANSWERS = 50;
export const MAX_PROPERTIES = 20;

export const isKey = (v: unknown): v is string => typeof v === "string" && KEY.test(v);
const isLink = (v: unknown): v is string => typeof v === "string" && codePointLength(v) >= 1 && codePointLength(v) <= 128;

export interface ValidStart {
  onboarding: OnboardingIdentity;
  studio?: StudioLinks;
  manifest: Manifest;
  properties?: Properties;
  /** Problems that were corrected rather than fatal: [code, message]. */
  warnings: [string, string][];
}

/** A Studio id that is a safe non-negative integer, in decimal (contract 3.1); anything else as it is. */
const decimalId = (v: unknown): unknown => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : v);

export function validateStart(options: StartOptions): { ok: true; value: ValidStart } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: [string, string][] = [];
  if (!options || typeof options !== "object") return { ok: false, errors: ["start options are not an object"] };

  // Studio links. Read once, with numeric ids converted, by both the links and the identity below.
  const studioIn: StudioInput | undefined =
    options.studio && typeof options.studio === "object"
      ? {
          ...options.studio,
          onboardingId: decimalId(options.studio.onboardingId) as string | null | undefined,
          deploymentId: decimalId(options.studio.deploymentId) as string | null | undefined,
          audienceId: decimalId(options.studio.audienceId) as string | null | undefined,
        }
      : options.studio;
  let studio: StudioLinks | undefined;
  if (studioIn !== undefined) {
    if (!studioIn || typeof studioIn !== "object") errors.push("studio is not an object");
    else {
      studio = {};
      const links: [keyof StudioLinks, unknown][] = [
        ["onboarding_id", studioIn.onboardingId],
        ["deployment_id", studioIn.deploymentId],
        ["audience_id", studioIn.audienceId],
      ];
      for (const [field, value] of links) {
        if (value === undefined || value === null) continue;
        if (!isLink(value)) errors.push(`studio.${field} must be 1 to 128 characters`);
        else studio[field] = value;
      }
      if (Object.keys(studio).length === 0) studio = undefined;
    }
  }
  const draft = !!studioIn?.draft;

  // Identity.
  let onboarding: OnboardingIdentity | undefined;
  if (options.onboarding) {
    const { key, version, variantKey } = options.onboarding;
    if (!isKey(key)) errors.push("onboarding.key must be 1 to 128 characters from A-Z a-z 0-9 _ . : -");
    if (!draft && (typeof version !== "string" || !VERSION.test(version))) {
      errors.push("onboarding.version must be 1 to 64 characters from A-Z a-z 0-9 _ . : + -");
    }
    if (draft && version !== "draft") warnings.push(["draft-version", `a Studio draft sends version "draft", not "${version}"`]);
    onboarding = { key, version: draft ? "draft" : version };
    if (variantKey !== undefined && variantKey !== null) {
      // Studio-served means it carries a Studio link (or is a Studio draft), not that a `studio` object was passed.
      if (studio || draft) {
        warnings.push(["studio-variant-dropped", "a Studio-served run does not carry variant_key: each Studio arm is its own onboarding key"]);
      } else if (!isKey(variantKey)) errors.push("onboarding.variantKey must be a key");
      else onboarding.variant_key = variantKey;
    }
  } else if (studioIn && isKey(studioIn.onboardingId)) {
    // A null deployment id is absent, as it is for the links above: a Studio-served run with none is a draft (3.1).
    const deployment: unknown = studioIn.deploymentId;
    const version = draft || deployment === undefined || deployment === null ? "draft" : deployment;
    if (typeof version !== "string" || !VERSION.test(version)) {
      errors.push("studio.deploymentId cannot be used as onboarding.version");
    } else {
      onboarding = { key: studioIn.onboardingId, version };
    }
  } else {
    errors.push("either onboarding { key, version } or studio.onboardingId is required");
  }

  // Manifest.
  const manifest: Manifest = { steps: [] };
  const stepsIn = options.manifest?.steps;
  if (!Array.isArray(stepsIn) || stepsIn.length < 1 || stepsIn.length > MAX_MANIFEST_STEPS) {
    errors.push(`manifest.steps must hold 1 to ${MAX_MANIFEST_STEPS} steps`);
  } else {
    const seen = new Set<string>();
    const closedSlots = new Set<string>();
    stepsIn.forEach((s, i) => {
      const stepKey = s?.stepKey;
      if (!isKey(stepKey)) return void errors.push(`manifest.steps[${i}].stepKey is not a valid key`);
      if (seen.has(stepKey)) errors.push(`manifest step "${stepKey}" is declared twice`);
      seen.add(stepKey);
      const slot = s.slot;
      if (slot !== undefined) {
        if (!isKey(slot)) errors.push(`manifest.steps[${i}].slot is not a valid key`);
        if (closedSlots.has(slot)) errors.push(`slot "${slot}" is not contiguous`);
        if (stepsIn[i + 1]?.slot !== slot) closedSlots.add(slot);
        manifest.steps.push({ step_key: stepKey, slot });
      } else {
        manifest.steps.push({ step_key: stepKey });
      }
    });
  }

  // Properties: invalid ones are dropped, not fatal.
  let properties: Properties | undefined;
  if (options.properties !== undefined) {
    const { value, problems } = mergeProperties({}, options.properties);
    problems.forEach((p) => warnings.push(p));
    if (Object.keys(value).length) properties = value;
  }

  if (errors.length || !onboarding) return { ok: false, errors };
  return { ok: true, value: { onboarding, studio, manifest, properties, warnings } };
}

export function propertyProblem(key: string, value: unknown): string | null {
  if (!PROPERTY_KEY.test(key)) return `property key "${key}" must match ^[a-z][a-z0-9_]{0,39}$`;
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : `property "${key}" is not a finite number`;
  if (typeof value === "string") return codePointLength(value) <= 256 ? null : `property "${key}" is longer than 256 characters`;
  return `property "${key}" must be a string, number, boolean or null`;
}

/** `base` with `patch` applied, keeping only valid entries and at most 20 keys. */
export function mergeProperties(base: Properties, patch: unknown): { value: Properties; problems: [string, string][] } {
  const value: Properties = { ...base };
  const problems: [string, string][] = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { value, problems: [["invalid-property", "properties must be an object"]] };
  }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const problem = propertyProblem(k, v);
    if (problem) {
      problems.push(["invalid-property", problem]);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(value, k) && Object.keys(value).length >= MAX_PROPERTIES) {
      problems.push(["too-many-properties", `property "${k}" dropped: at most ${MAX_PROPERTIES}`]);
      continue;
    }
    value[k] = v as PropertyValue;
  }
  return { value, problems };
}

/** One answer in wire form, or the reason it cannot be sent. */
export function toAnswer(input: unknown): { ok: true; answer: Answer } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "an answer must be an object" };
  const a = input as Record<string, unknown>;
  const q = a.questionKey;
  if (!isKey(q)) return { ok: false, error: "questionKey is not a valid key" };
  switch (a.kind) {
    case "single":
      return isKey(a.value)
        ? { ok: true, answer: { question_key: q, kind: "single", value: a.value } }
        : { ok: false, error: `${q}: a single answer's value must be an option key` };
    case "multi": {
      if (!Array.isArray(a.value) || !a.value.every(isKey)) return { ok: false, error: `${q}: a multi answer's value must be option keys` };
      const unique = [...new Set(a.value as string[])];
      if (unique.length > MAX_ANSWERS) return { ok: false, error: `${q}: at most ${MAX_ANSWERS} options` };
      return { ok: true, answer: { question_key: q, kind: "multi", value: unique } };
    }
    case "numeric": {
      if (typeof a.value !== "number" || !Number.isFinite(a.value)) return { ok: false, error: `${q}: a numeric answer must be a finite number` };
      if (a.unit !== undefined && !isKey(a.unit)) return { ok: false, error: `${q}: unit must be a key` };
      return {
        ok: true,
        answer: a.unit === undefined
          ? { question_key: q, kind: "numeric", value: a.value }
          : { question_key: q, kind: "numeric", value: a.value, unit: a.unit as string },
      };
    }
    case "text":
      return typeof a.value === "string" && codePointLength(a.value) <= 1000
        ? { ok: true, answer: { question_key: q, kind: "text", value: a.value } }
        : { ok: false, error: `${q}: a text answer is at most 1,000 characters` };
    default:
      return { ok: false, error: `${q}: unknown answer kind ${JSON.stringify(a.kind)}` };
  }
}
