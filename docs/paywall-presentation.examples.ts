import type { PaywallPresentationSnapshot } from "./paywall-presentation.types";

const context = {
  app_version: "2.4.0", build: "412", platform: "android", os_version: "15",
  locale: "en-US", timezone: "America/New_York", library_version: "0.1.0",
} as const;
const paywall = {
  moment_key: "settings_upgrade", paywall_id: "4b1f0e7c-2d1a-4c55-9a0e-6f2d3c1b7a90",
  audience_id: "a9e1c3d2-7b6f-4e21-8c0d-5f4a3b2c1d0e", render_mode: "custom", billing: "store",
} as const;
const id = "0192f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b";

/** The three sends of one purchased presentation on Android. */
export const PURCHASED_ANDROID: PaywallPresentationSnapshot[] = [
  { schema_version: 1, presentation_id: id, seq: 1, status: "in_progress", started_at: "2026-01-10T09:00:00.000Z",
    shown_at: null, ended_at: null, sent_at: "2026-01-10T09:00:00.000Z", paywall, surface: "present", outcome: null, context },
  { schema_version: 1, presentation_id: id, seq: 2, status: "in_progress", started_at: "2026-01-10T09:00:00.000Z",
    shown_at: "2026-01-10T09:00:00.350Z", ended_at: null, sent_at: "2026-01-10T09:00:00.350Z", paywall, surface: "present", outcome: null, context },
  { schema_version: 1, presentation_id: id, seq: 3, status: "ended", started_at: "2026-01-10T09:00:00.000Z",
    shown_at: "2026-01-10T09:00:00.350Z", ended_at: "2026-01-10T09:00:41.120Z", sent_at: "2026-01-10T09:00:41.120Z",
    paywall, surface: "present", context,
    outcome: { status: "purchased", transaction: {
      original_transaction_identifier: "GPA.3311-4849-7511-34728",
      purchase_token: "mboecpopplapdphlhgegnpol.AO-J1OxExampleToken", product_id: "pro_annual" } } },
];

export const DISMISSED_STEP: PaywallPresentationSnapshot = {
  schema_version: 1, presentation_id: "0192f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1c", seq: 3, status: "ended",
  started_at: "2026-01-10T09:00:00.000Z", shown_at: "2026-01-10T09:00:00.200Z", ended_at: "2026-01-10T09:00:05.000Z",
  sent_at: "2026-01-10T09:00:05.000Z", paywall: { ...paywall, moment_key: "onboarding_end" }, surface: "paywall_step",
  onboarding_run: { run_id: "0192f1a2-0000-7000-8000-000000000001", step_key: "paywall" },
  outcome: { status: "dismissed" }, context: { ...context, platform: "ios", os_version: "18.1" },
};

export const RENDER_ERROR: PaywallPresentationSnapshot = {
  schema_version: 1, presentation_id: "0192f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1d", seq: 2, status: "ended",
  started_at: "2026-01-10T09:00:00.000Z", shown_at: null, ended_at: "2026-01-10T09:00:00.010Z",
  sent_at: "2026-01-10T09:00:00.010Z", paywall, surface: "present",
  outcome: { status: "error", reason: "unknown-custom-screen" }, context,
};

export const ALL_EXAMPLES: PaywallPresentationSnapshot[] = [...PURCHASED_ANDROID, DISMISSED_STEP, RENDER_ERROR];
