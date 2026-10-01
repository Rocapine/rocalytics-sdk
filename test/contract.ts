// Test-side view of the contract: the schema, the rules JSON Schema cannot
// express (section 4 of docs/onboarding-run-contract.md), and the ingest's
// acceptance rules (section 5). Every payload a test captures goes through
// `assertConformant`, so a tracker that emits something the ingest would
// reject fails here rather than in production.
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { validate } from "./miniJsonSchema";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const DOCS = path.join(__dirname, "..", "docs");
export const schema = JSON.parse(fs.readFileSync(path.join(DOCS, "onboarding-run.schema.json"), "utf8"));

/** 256 KiB: the ingest's hard limit (D8). */
export const SIZE_LIMIT = 262_144;
export const sizeOf = (p: unknown) => Buffer.byteLength(JSON.stringify(p), "utf8");

/** Section 4: the rules beyond the schema. */
export function semanticErrors(p: Json): string[] {
  const errors: string[] = [];
  const manifestKeys: string[] = p.manifest.steps.map((s: Json) => s.step_key);
  if (new Set(manifestKeys).size !== manifestKeys.length) errors.push("manifest step_key repeated");
  const slots: (string | undefined)[] = p.manifest.steps.map((s: Json) => s.slot);
  const closed = new Set<string>();
  slots.forEach((slot, i) => {
    if (slot === undefined) return;
    if (closed.has(slot)) errors.push(`slot ${slot} is not contiguous`);
    if (slots[i + 1] !== slot) closed.add(slot);
  });
  const entries: Json[] = p.steps;
  for (const e of entries) {
    if (!manifestKeys.includes(e.step_key)) errors.push(`step ${e.step_key} is not in the manifest`);
  }
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].entered_at < entries[i - 1].entered_at) errors.push("entries out of order");
  }
  if (entries[0]?.entered_at !== p.started_at) errors.push("started_at must equal the first entry's entered_at");
  entries.forEach((e, i) => {
    const isLast = i === entries.length - 1;
    if (e.exited_at !== null && e.exited_at < e.entered_at) errors.push(`${e.step_key} exits before it enters`);
    if (!isLast && e.exited_at === null) errors.push(`${e.step_key}: only the last entry may have a null exited_at`);
    if (p.truncated) {
      if (isLast && p.status === "completed" && (e.exited_at === null || e.exited_at > p.completed_at)) {
        errors.push("a truncated run's last kept entry must exit at or before completed_at");
      }
    } else {
      if (isLast && p.status === "in_progress" && e.exited_at !== null) {
        errors.push("the last entry of an in_progress run must have a null exited_at");
      }
      if (isLast && p.status === "completed" && e.exited_at !== p.completed_at) {
        errors.push("a completed run's last entry must exit at completed_at");
      }
    }
    const questions = e.answers.map((a: Json) => a.question_key);
    if (new Set(questions).size !== questions.length) errors.push(`${e.step_key}: question_key repeated`);
  });
  return errors;
}

/** Fails the test unless `p` passes the size limit, the schema and section 4. */
export function assertConformant(p: unknown): void {
  expect(sizeOf(p), "snapshot size").toBeLessThanOrEqual(SIZE_LIMIT);
  expect(validate(schema, p), `schema errors for ${JSON.stringify(p).slice(0, 200)}`).toEqual([]);
  expect(semanticErrors(p as Json), "section 4 rules").toEqual([]);
}

// Section 5, acceptance rules, as a reference function the mock collector uses.
export type Outcome = "accepted" | "ignored" | "rejected";

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v).filter((k) => (v as Json)[k] !== null).sort().map((k) => [k, canonical((v as Json)[k])]),
    );
  }
  return v;
}
const sameValue = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function accept(stored: Json | null, incoming: Json): Outcome {
  if (stored?.status === "completed") return "ignored";
  if (sizeOf(incoming) > SIZE_LIMIT) return "rejected";
  if (validate(schema, incoming).length > 0 || semanticErrors(incoming).length > 0) return "rejected";
  if (stored === null) return "accepted";
  for (const field of ["onboarding", "manifest"]) {
    if (!sameValue(stored[field], incoming[field])) return "rejected";
  }
  if (incoming.seq > stored.seq) return "accepted";
  return "ignored";
}
