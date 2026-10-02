import type { SinkResult, Sink } from "../core/sink";
import type { Answer, OnboardingRunSnapshot } from "../onboarding/contract";
import type { RocalyticsClient } from "./client";
import type { OnboardingMetadata, OnboardingResponsePayload, OnboardingStepAnswers } from "./types";

/**
 * A v1 onboarding run snapshot in the pre-v1 `/onboarding-response` shape,
 * which is the only onboarding payload the Rocalytics ingest reads.
 *
 * - Each entry is a response: `step_key` becomes `step_id`, timestamps are kept.
 * - Answers become `{ [question_key]: value }`. A numeric answer's `unit` has
 *   no place in that shape and is dropped.
 * - `onboarding_metadata` carries the Studio links under the keys the pre-v1
 *   payload used (`onboarding_id`, `deployment_id`, `audience_id`), plus the
 *   run's identity: `onboarding_key`, `onboarding_version`, `variant_key`,
 *   `run_id`, `seq`, `status`, `schema_version`, `started_at`,
 *   `completed_at`, `truncated` and `properties`, each only when present.
 * - `sent_at` is the snapshot's. A retry resends the same body, so the
 *   ingest, which ignores a snapshot older than the one it holds, drops it.
 */
export function toOnboardingResponsePayload(snapshot: OnboardingRunSnapshot): OnboardingResponsePayload {
  const metadata: OnboardingMetadata = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) metadata[key] = value;
  };
  set("onboarding_id", snapshot.studio?.onboarding_id);
  set("deployment_id", snapshot.studio?.deployment_id);
  set("audience_id", snapshot.studio?.audience_id);
  set("onboarding_key", snapshot.onboarding.key);
  set("onboarding_version", snapshot.onboarding.version);
  set("variant_key", snapshot.onboarding.variant_key);
  set("run_id", snapshot.run_id);
  set("seq", snapshot.seq);
  set("status", snapshot.status);
  set("schema_version", snapshot.schema_version);
  set("started_at", snapshot.started_at);
  set("completed_at", snapshot.completed_at);
  set("truncated", snapshot.truncated);
  if (snapshot.properties) set("properties", { ...snapshot.properties });
  return {
    onboarding_metadata: metadata,
    sent_at: snapshot.sent_at,
    responses: snapshot.steps.map((entry) => ({
      step_id: entry.step_key,
      entered_at: entry.entered_at,
      exited_at: entry.exited_at,
      answers: toAnswers(entry.answers),
    })),
  };
}

function toAnswers(answers: Answer[]): OnboardingStepAnswers {
  const out: OnboardingStepAnswers = {};
  for (const answer of answers) out[answer.question_key] = Array.isArray(answer.value) ? [...answer.value] : answer.value;
  return out;
}

/**
 * Reads `/onboarding-response`'s status as a sink outcome. That endpoint
 * answers with a status and no outcome body, so unlike `createHttpSink` this
 * reads the status:
 *
 * - 2xx: accepted (the ingest stores it, or drops it as a stale retry);
 * - 400 and 405: rejected, since resending the same body cannot succeed;
 * - anything else, 404 included: transient. A 404 means the identity does
 *   not exist yet because `/identify` has not landed, which a retry fixes.
 */
export function rocalyticsOutcome(status: number): SinkResult {
  if (status >= 200 && status < 300) return { outcome: "accepted" };
  if (status === 400 || status === 405) return { outcome: "rejected", reason: `status ${status}` };
  return { outcome: "transient", reason: `status ${status}` };
}

/**
 * A sink for the onboarding run tracker (`@rocapine/studio-sdk/onboarding`)
 * that delivers each snapshot to Rocalytics through `client`, as the pre-v1
 * onboarding payload (see `toOnboardingResponsePayload`).
 *
 * The ingest keeps one onboarding snapshot per roca id, so a new run replaces
 * the previous one there, and an app should report a flow through this sink
 * or through `client.trackOnboarding`, not both.
 *
 * While the client is inert every send is transient: the tracker keeps the
 * snapshot, persisted when it has storage, for a launch where the client works.
 */
export function createRocalyticsOnboardingSink(client: RocalyticsClient): Sink<OnboardingRunSnapshot> {
  return { send: (snapshot) => client.sendOnboardingRun(snapshot) };
}
