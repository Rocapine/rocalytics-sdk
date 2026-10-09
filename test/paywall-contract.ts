// Test-side view of the paywall presentation contract: the schema, the rules
// JSON Schema cannot express (section 4 of docs/paywall-presentation-contract.md)
// and the ingest's acceptance rules (section 5).
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { validate } from "./miniJsonSchema";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const DOCS = path.join(__dirname, "..", "docs");
export const presentationSchema = JSON.parse(fs.readFileSync(path.join(DOCS, "paywall-presentation.schema.json"), "utf8"));

/** 16 KiB: a presentation is small; anything bigger is a bug. */
export const PRESENTATION_SIZE_LIMIT = 16_384;
const sizeOf = (p: unknown) => Buffer.byteLength(JSON.stringify(p), "utf8");

export function presentationSemanticErrors(p: Json): string[] {
  const errors: string[] = [];
  const ended = p.status === "ended";
  if (ended !== (p.ended_at !== null)) errors.push("ended_at must be set exactly when status is ended");
  if (ended !== (p.outcome !== null)) errors.push("outcome must be set exactly when status is ended");
  if (p.shown_at !== null && p.shown_at < p.started_at) errors.push("shown_at before started_at");
  if (p.ended_at !== null && p.ended_at < (p.shown_at ?? p.started_at)) errors.push("ended_at before shown_at/started_at");
  if (p.sent_at < p.started_at) errors.push("sent_at before started_at");
  const o = p.outcome;
  if (o) {
    if (o.reason !== undefined && o.status !== "error") errors.push("reason only with status error");
    if (o.transaction !== undefined && o.status !== "purchased") errors.push("transaction only with status purchased");
    if (o.transaction !== undefined && Object.keys(o.transaction).length === 0) errors.push("transaction must not be empty");
    if (o.status === "purchased" && p.shown_at === null) errors.push("purchased requires shown_at");
  }
  if ((p.surface === "paywall_step") !== (p.onboarding_run !== undefined) && p.onboarding_run !== undefined) {
    errors.push("onboarding_run only with surface paywall_step");
  }
  return errors;
}

export function assertPresentationConformant(p: unknown): void {
  expect(sizeOf(p), "snapshot size").toBeLessThanOrEqual(PRESENTATION_SIZE_LIMIT);
  expect(validate(presentationSchema, p), `schema errors for ${JSON.stringify(p).slice(0, 200)}`).toEqual([]);
  expect(presentationSemanticErrors(p as Json), "section 4 rules").toEqual([]);
}

export type Outcome = "accepted" | "ignored" | "rejected";
const IMMUTABLE = ["presentation_id", "started_at", "paywall", "surface", "onboarding_run", "context"] as const;

/** Section 5: what the ingest answers, given the stored snapshot for this (roca_id, presentation_id). */
export function acceptPresentation(stored: Json | null, incoming: Json): Outcome {
  if (stored?.status === "ended") return "ignored";
  if (sizeOf(incoming) > PRESENTATION_SIZE_LIMIT) return "rejected";
  if (validate(presentationSchema, incoming).length > 0 || presentationSemanticErrors(incoming).length > 0) return "rejected";
  if (stored === null) return "accepted";
  for (const f of IMMUTABLE) if (JSON.stringify(stored[f]) !== JSON.stringify(incoming[f])) return "rejected";
  return incoming.seq > stored.seq ? "accepted" : "ignored";
}
