// The wire format of an event batch. Normative schema: docs/event-batch.schema.json.
// Ingest: Rocapine/rocalytics-warehouse services/event-ingest (POST /v1/batch).

export type AnalyticsPlatform = "ios" | "android" | "web";

export interface WireEvent {
  /** Unique per event; the warehouse deduplicates on it, so a retry reuses it. */
  event_id: string;
  name: string;
  /** Device time of the event, ms since the epoch. The ingest corrects it with `sent_at`. */
  time: number;
  roca_id: string | null;
  /** The app's own account id (Amplitude `setUserId`). */
  user_id: string | null;
  /** Start of the session, ms since the epoch (the Amplitude convention). */
  session_id: number;
  app_version: string | null;
  os_version: string | null;
  locale: string | null;
  properties: Record<string, unknown>;
  /** Only on `$identify` events. */
  user_properties?: Record<string, unknown>;
}

export interface EventBatch {
  /** Bundle id / package name; the ingest only accepts allowlisted ones. */
  app_id: string;
  platform: AnalyticsPlatform;
  /** Device time at send, ms since the epoch: the ingest measures clock skew from it. */
  sent_at: number;
  /** `rocalytics-sdk/<version>`. */
  sdk: string;
  /** 1 to 500 events. */
  events: WireEvent[];
}
