import type { SinkResult, Sink } from "../core/sink";
import type { Answer, OnboardingRunSnapshot } from "../onboarding/contract";
import type { RocalyticsClient } from "./client";
import type { OnboardingMetadata, OnboardingResponsePayload, OnboardingStepAnswers } from "./types";

/**
 * A v1 onboarding run snapshot in the pre-v1 `/onboarding-response` shape,
 * which is the only onboarding payload the Rocalytics ingest reads. The keys
 * follow docs/onboarding-run-contract.md, section 9, which is how the ingest
 * reads such a payload back into a run.
 *
 * - Each entry is a response: `step_key` becomes `step_id`, timestamps are kept.
 * - Answers become `{ [question_key]: value }`. A numeric answer's `unit` has
 *   no place in that shape and is dropped.
 * - `onboarding_metadata` carries the keys section 9 reads: `onboardingId`
 *   (the Studio onboarding) or, with none, `onboarding_id` (the onboarding
 *   key, as a hand-coded sender sets it), `audienceId`, `deployment_id`,
 *   `locale` (from the run's context) and `draft: true` for a draft. It also
 *   carries `onboarding_key`, `onboarding_version`, `variant_key`, `run_id`
 *   and `seq`, which section 9 does not read.
 * - `sent_at` is NOT the device's send time. The ingest keeps one snapshot
 *   per sender and replaces it only when the incoming `sent_at` is strictly
 *   later, answering 2xx either way, so two sends in one millisecond, or a
 *   device clock stepping back, would drop a snapshot (the completion
 *   included) while it reads as delivered. So `sent_at` is the run's latest
 *   recorded timestamp plus `seq` milliseconds. A snapshot only ever adds
 *   timestamps to the one before it and `seq` rises with every send, so this
 *   strictly increases across a run's sends whatever the device clock does.
 *   Only within a run: the ingest keeps one row per sender, so after the
 *   clock steps back between runs, a later run's snapshots can still be
 *   dropped while answered 2xx, as pre-v1 reporting already could.
 *   It depends on the snapshot alone, so a retry, even after a relaunch,
 *   resends the identical body.
 */
export function toOnboardingResponsePayload(snapshot: OnboardingRunSnapshot): OnboardingResponsePayload {
  const metadata: OnboardingMetadata = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) metadata[key] = value;
  };
  const studioOnboardingId = snapshot.studio?.onboarding_id;
  if (studioOnboardingId != null) set("onboardingId", studioOnboardingId);
  else set("onboarding_id", snapshot.onboarding.key);
  set("audienceId", snapshot.studio?.audience_id);
  set("deployment_id", snapshot.studio?.deployment_id);
  set("locale", snapshot.context.locale);
  if (snapshot.onboarding.version === "draft") set("draft", true);
  set("onboarding_key", snapshot.onboarding.key);
  set("onboarding_version", snapshot.onboarding.version);
  set("variant_key", snapshot.onboarding.variant_key);
  set("run_id", snapshot.run_id);
  set("seq", snapshot.seq);
  return {
    onboarding_metadata: metadata,
    sent_at: new Date(latestRecorded(snapshot) + snapshot.seq).toISOString(),
    responses: snapshot.steps.map((entry) => ({
      step_id: entry.step_key,
      entered_at: entry.entered_at,
      exited_at: entry.exited_at,
      answers: toAnswers(entry.answers),
    })),
  };
}

/** The latest timestamp the run has recorded: its start, entries, exits and completion. Not `sent_at`. */
function latestRecorded(snapshot: OnboardingRunSnapshot): number {
  let latest = Date.parse(snapshot.started_at);
  const consider = (ts: string | null) => {
    if (ts !== null) latest = Math.max(latest, Date.parse(ts));
  };
  for (const entry of snapshot.steps) {
    consider(entry.entered_at);
    consider(entry.exited_at);
  }
  consider(snapshot.completed_at);
  return latest;
}

function toAnswers(answers: Answer[]): OnboardingStepAnswers {
  const out: OnboardingStepAnswers = {};
  for (const answer of answers) out[answer.question_key] = Array.isArray(answer.value) ? [...answer.value] : answer.value;
  return out;
}

/**
 * Reads an `/onboarding-response` answer as a sink outcome. The endpoint
 * answers success with a 2xx and no body, so a 2xx is accepted. Otherwise,
 * as the contract's section 5 requires, only a body that says
 * `{"outcome": "rejected"}` is permanent: every other status, whatever its
 * body, is transient and the snapshot is retried.
 */
export function rocalyticsOutcome(status: number, body?: unknown): SinkResult {
  if (status >= 200 && status < 300) return { outcome: "accepted" };
  if (body && typeof body === "object" && (body as { outcome?: unknown }).outcome === "rejected") {
    const reason = (body as { reason?: unknown }).reason;
    return typeof reason === "string" ? { outcome: "rejected", reason } : { outcome: "rejected" };
  }
  return { outcome: "transient", reason: `status ${status}` };
}

/**
 * A sink for the onboarding run tracker (`@rocapine/rocalytics-sdk/onboarding`)
 * that delivers each snapshot to Rocalytics through `client`, as the pre-v1
 * onboarding payload (see `toOnboardingResponsePayload`).
 *
 * Once a completed snapshot is accepted, the sink also sends the
 * `onboarding_completed` event, which is where consumers of the pre-v1 data
 * read completion from. It is deduplicated per device, like any `track`
 * event; if it fails, the send is transient, so the tracker's retry sends it.
 *
 * The ingest keeps one onboarding snapshot per roca id, so a new run replaces
 * the previous one there, and an app should report a flow through this sink
 * or through `client.trackOnboarding`, not both.
 *
 * While the client is inert every send is transient: the tracker keeps the
 * snapshot, persisted when it has storage, for a launch where the client works.
 *
 * Its `destination` is the client's `onboardingRunDestination`.
 */
export function createRocalyticsOnboardingSink(client: RocalyticsClient): Sink<OnboardingRunSnapshot> {
  return { destination: client.onboardingRunDestination, send: (snapshot) => client.sendOnboardingRun(snapshot) };
}
