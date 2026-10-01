// Generated from docs/onboarding-run.schema.json by test/schema-types.test.ts.
// Do not edit. Regenerate with `npm run gen:schema-types`.
export type SnapshotFromSchema = ({
  schema_version: 1;
  run_id: string;
  seq: number;
  status: ("in_progress" | "completed") & "completed";
  started_at: string;
  completed_at: (string | null) & (string);
  sent_at: string;
  onboarding: {
    key: string;
    version: string;
    variant_key?: string | null;
  };
  studio?: {
    onboarding_id?: string | null;
    deployment_id?: string | null;
    audience_id?: string | null;
  };
  context: {
    app_version: string;
    build: string | null;
    platform: "ios" | "android" | "web";
    os_version: string | null;
    locale: string;
    timezone: string;
    library_version?: string;
  };
  manifest: {
    steps: Array<{
      step_key: string;
      slot?: string;
    }>;
  };
  properties?: {
    [key: string]: string | number | boolean | null;
  };
  truncated?: true;
  steps: Array<{
    step_key: string;
    entered_at: string;
    exited_at: string | null;
    answers: Array<({
      question_key: string;
      kind: "single";
      value: string;
    }) | ({
      question_key: string;
      kind: "multi";
      value: Array<string>;
    }) | ({
      question_key: string;
      kind: "numeric";
      value: number;
      unit?: string;
    }) | ({
      question_key: string;
      kind: "text";
      value: string;
    })>;
  }>;
}) | ({
  schema_version: 1;
  run_id: string;
  seq: number;
  status: Exclude<"in_progress" | "completed", "completed">;
  started_at: string;
  completed_at: (string | null) & (null);
  sent_at: string;
  onboarding: {
    key: string;
    version: string;
    variant_key?: string | null;
  };
  studio?: {
    onboarding_id?: string | null;
    deployment_id?: string | null;
    audience_id?: string | null;
  };
  context: {
    app_version: string;
    build: string | null;
    platform: "ios" | "android" | "web";
    os_version: string | null;
    locale: string;
    timezone: string;
    library_version?: string;
  };
  manifest: {
    steps: Array<{
      step_key: string;
      slot?: string;
    }>;
  };
  properties?: {
    [key: string]: string | number | boolean | null;
  };
  truncated?: true;
  steps: Array<{
    step_key: string;
    entered_at: string;
    exited_at: string | null;
    answers: Array<({
      question_key: string;
      kind: "single";
      value: string;
    }) | ({
      question_key: string;
      kind: "multi";
      value: Array<string>;
    }) | ({
      question_key: string;
      kind: "numeric";
      value: number;
      unit?: string;
    }) | ({
      question_key: string;
      kind: "text";
      value: string;
    })>;
  }>;
});
