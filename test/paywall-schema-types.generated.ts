// Generated from docs/paywall-presentation.schema.json by test/paywall-schema-types.test.ts.
// Do not edit. Regenerate with `npm run gen:schema-types`.
export type PresentationFromSchema = {
  schema_version: 1;
  presentation_id: string;
  seq: number;
  status: "in_progress" | "ended";
  started_at: string;
  shown_at: string | null;
  ended_at: string | null;
  sent_at: string;
  paywall: {
    moment_key?: string;
    paywall_id?: string;
    audience_id: string | null;
    render_mode: "elements" | "custom" | "external";
    billing: "store" | "stripe";
    variant_key?: string;
    deployment_id?: string;
    placement?: string;
    external_paywall_id?: string;
    provider_name?: string;
  };
  surface: "present" | "paywall_step" | "placement";
  provider?: "studio" | "external" | "native";
  onboarding_run?: {
    run_id: string;
    step_key: string;
  };
  outcome: null | ({
    status: "purchased" | "dismissed" | "cancelled" | "error";
    reason?: string;
    transaction?: {
      original_transaction_identifier?: string;
      purchase_token?: string;
      product_id?: string;
      restored?: boolean;
    };
  });
  context: {
    app_version: string;
    build: string | null;
    platform: "ios" | "android" | "web";
    os_version: string | null;
    locale: string;
    timezone: string;
    library_version?: string;
  };
};
