import { safeDiagnostics, type DiagnosticHandler } from "../core/diagnostics";
import type { SinkResult } from "../core/sink";
import { systemClock, type Clock } from "../core/time";
import type { OnboardingRunSnapshot } from "../onboarding/contract";
import { loadExpoModules, type RocalyticsModules } from "./native";
import { rocalyticsOutcome, toOnboardingResponsePayload } from "./onboardingSink";
import {
  buildDemandScoreRequest,
  buildIdentifyRequest,
  buildOnboardingResponseRequest,
  buildTrackRequest,
  sendRocalyticsRequest,
  type FetchLike,
  type RequestContext,
  type RocalyticsRequest,
} from "./requests";
import type {
  DemandScoreResult,
  DemandScoreSignals,
  DeviceContext,
  IdentifyParams,
  OnboardingMetadata,
  OnboardingStepAnswers,
  OnboardingStepResponse,
  TrackEventName,
  TrackPurchaseParams,
} from "./types";

/** SecureStore key of the device's roca id. */
export const ROCA_ID_KEY = "rocalytics-roca-id";
/**
 * The misspelled key the copied clients stored the id under. Read when the
 * corrected key is empty, copied to it, and never deleted.
 */
export const LEGACY_ROCA_ID_KEY = "rocalitics-roca-id";
/** SecureStore key that records the install event was sent. */
export const INSTALL_TRACKED_KEY = "rocadata-install-tracked";
/** A second install key one copied client used. Holding it also counts as "install already sent". */
export const LEGACY_INSTALL_TRACKED_KEYS = ["rocadata-install-tracked-4"];

export interface RocalyticsClientOptions {
  /**
   * The native modules. By default the Expo modules and react-native are
   * loaded lazily when the client starts; when one is missing the client is
   * inert. Pass `null` to run inert on purpose, or your own implementation
   * (tests, a non-Expo host).
   */
  modules?: RocalyticsModules | null;
  /** Defaults to the global `fetch`, read on each request. */
  fetch?: FetchLike;
  /** Defaults to `https://rocalytics-api.rocapine.io`. */
  baseUrl?: string;
  clock?: Clock;
  /** Receives why the client went inert, or why its start-up failed. Default: `console.warn`. */
  onDiagnostic?: DiagnosticHandler;
}

const intlOptions = () => Intl.DateTimeFormat().resolvedOptions();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The Rocalytics client. Create one per app, at startup: the constructor
 * starts it (reads or mints the device's roca id, identifies the device,
 * sends `install` once per device), and every method waits for that.
 *
 * Inert when it cannot run: a native module is missing from the binary, or
 * the stored id cannot be read. `ready` still resolves, `rocaId` stays null,
 * and every method resolves without sending anything, except
 * `getDemandScore`, which rejects because it has no value to return.
 *
 * A method whose request gets a non-2xx answer rejects with
 * `[ROCALYTICS] <endpoint> failed: <status>`. No request, response or
 * purchase property is ever logged; only start-up problems are reported, to
 * `onDiagnostic` (default `console.warn`).
 */
export class RocalyticsClient {
  /** The device's id, once `ready` resolves. Null while starting, and when inert. */
  rocaId: string | null = null;
  /** Resolves once the client has started, or has gone inert. Never rejects. */
  readonly ready: Promise<void>;

  private native: RocalyticsModules | null = null;
  private deviceContext: DeviceContext | null = null;
  private onboardingMetadata: OnboardingMetadata | null = null;
  private onboardingResponses: OnboardingStepResponse[] = [];
  /** Runs whose `onboarding_completed` event was sent this session. */
  private readonly completionSent = new Set<string>();
  private readonly clock: Clock;
  private readonly report: DiagnosticHandler;

  constructor(private readonly options: RocalyticsClientOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.report = safeDiagnostics(options.onDiagnostic);
    this.ready = this.init().catch(() => undefined);
  }

  /** Sends a named analytics event. */
  async track(name: TrackEventName, properties?: Record<string, unknown>): Promise<void> {
    await this.ready;
    if (!this.rocaId) return;
    await this.sendTrack(name, properties || {});
  }

  /** The same as `track`. */
  async trackEvent(name: TrackEventName, properties?: Record<string, unknown>): Promise<void> {
    await this.track(name, properties);
  }

  /**
   * Sends a custom event with any name. It is not stored as an analytics
   * event: the API passes it on to drive automations, with
   * `properties` as template variables. Deduplicated on `${rocaId}-${name}`,
   * so a once-ever event can be re-fired safely; pass `dedupSuffix` (a date,
   * say) to keep each occurrence of a recurring event distinct.
   */
  async trackCustomEvent(name: string, properties?: Record<string, unknown>, dedupSuffix?: string): Promise<void> {
    await this.ready;
    if (!this.rocaId) return;
    await this.sendTrack(name, properties || {}, `${this.rocaId}-${name}${dedupSuffix ? `-${dedupSuffix}` : ""}`, true);
  }

  /** Sends `purchase`, deduplicated per original transaction. */
  async trackPurchase(params: TrackPurchaseParams): Promise<void> {
    await this.ready;
    if (!this.rocaId) return;
    const { isTrial, value, currency, originalTransactionIdentifier, product, transaction, redemptionResult } = params;
    const productIdentifier = (product as { productIdentifier?: unknown } | undefined)?.productIdentifier;
    const experimental: Record<string, unknown> = {};
    if (product !== undefined) experimental.product = product;
    if (transaction !== undefined) experimental.transaction = transaction;
    if (redemptionResult !== undefined) experimental.redemption_result = redemptionResult;
    const properties: Record<string, unknown> = {
      is_trial: isTrial,
      original_transaction_identifier: originalTransactionIdentifier,
      product_id: params.productId ?? (typeof productIdentifier === "string" ? productIdentifier : undefined),
      price: value,
      currency_code: currency,
      // Omitted when empty: the raw purchase objects, forwarded as given.
      ...(Object.keys(experimental).length > 0 ? { experimental } : {}),
    };
    await this.sendTrack("purchase", properties, `${this.rocaId}-purchase-${originalTransactionIdentifier}`);
  }

  /** Attaches identifiers to the device's identity. Null and undefined values are dropped. */
  async identify(identifiers: IdentifyParams): Promise<void> {
    await this.ready;
    if (!this.rocaId) return;
    await this.sendIdentify(identifiers);
  }

  /**
   * Call on every onboarding navigation change: entering a step, answering on
   * it, or moving on. Sends every step seen so far; the API keeps the latest
   * snapshot per roca id, so calls need no batching or debouncing.
   *
   * The same `stepId` as the current step merges `answers` into it. A
   * different one closes the current step and opens a new one, so returning
   * to an earlier step appends it again. `metadata` is merged into what was
   * sent before.
   */
  async trackOnboarding(stepId: string, answers?: OnboardingStepAnswers, metadata?: OnboardingMetadata): Promise<void> {
    await this.ready;
    if (!this.rocaId) return;
    if (metadata) this.onboardingMetadata = { ...this.onboardingMetadata, ...metadata };
    const now = new Date(this.clock.now()).toISOString();
    const current = this.onboardingResponses[this.onboardingResponses.length - 1];
    if (current && current.step_id === stepId) {
      if (answers) current.answers = { ...current.answers, ...answers };
    } else {
      if (current && current.exited_at === null) current.exited_at = now;
      this.onboardingResponses.push({ step_id: stepId, entered_at: now, exited_at: null, answers: answers ?? {} });
    }
    await this.send(
      buildOnboardingResponseRequest(this.context(), {
        onboarding_metadata: this.onboardingMetadata ?? undefined,
        sent_at: now,
        responses: this.onboardingResponses,
      }),
      "onboarding-response",
    );
  }

  /**
   * The server-computed demand score (1 to 100) for this install. Waits for
   * `ready` on purpose: the endpoint answers 404 until `/identify` has created
   * the identity, and computes the score from it.
   */
  async getDemandScore(signals?: DemandScoreSignals): Promise<DemandScoreResult> {
    await this.ready;
    if (!this.rocaId) throw new Error("[ROCALYTICS] demand-score unavailable: client failed to initialize");
    const response = await this.send(buildDemandScoreRequest(this.context(), signals), "demand-score");
    return (await response.json()) as DemandScoreResult;
  }

  /**
   * Delivers one onboarding run snapshot as the pre-v1 onboarding payload,
   * then, for an accepted completed snapshot, sends `onboarding_completed`
   * once per run. Its deduplication id is run-scoped,
   * `${rocaId}-onboarding_completed-${run_id}` (the API only requires the
   * `${rocaId}-${name}` prefix), so each completed run on a device counts
   * once, and a resend of the same run's completion is deduplicated. A failed
   * completion event makes the send transient, so a retry sends it. This is
   * the send of `createRocalyticsOnboardingSink`; it never throws.
   */
  async sendOnboardingRun(snapshot: OnboardingRunSnapshot): Promise<SinkResult> {
    await this.ready;
    if (!this.rocaId) return { outcome: "transient", reason: "the Rocalytics client is inert" };
    const fetch = this.fetchFn();
    if (!fetch) return { outcome: "transient", reason: "no fetch available" };
    try {
      const request = buildOnboardingResponseRequest(this.context(), toOnboardingResponsePayload(snapshot));
      const response = await fetch(request.url, request.init);
      const body = response.ok ? undefined : await response.json().catch(() => undefined);
      const result = rocalyticsOutcome(response.status, body);
      if (result.outcome === "accepted" && snapshot.status === "completed" && !this.completionSent.has(snapshot.run_id)) {
        await this.sendTrack("onboarding_completed", {}, `${this.rocaId}-onboarding_completed-${snapshot.run_id}`);
        this.completionSent.add(snapshot.run_id);
      }
      return result;
    } catch (error) {
      return { outcome: "transient", reason: String(error) };
    }
  }

  // --- internals --------------------------------------------------------------

  private async init(): Promise<void> {
    const native = this.loadModules();
    if (!native) return;
    const store = native.secureStore;
    try {
      this.rocaId = await this.readOrMintRocaId(native);
    } catch (error) {
      this.report({ code: "identity-unavailable", message: `the stored roca id could not be read, so none is minted: ${message(error)}` });
      return;
    }
    this.native = native;
    try {
      const idfv = native.platform.OS === "ios" ? await native.application.getIosIdForVendorAsync() : null;
      const androidId = native.platform.OS === "android" ? native.application.getAndroidId() : null;
      await this.sendIdentify({ idfv, android_id: androidId, locale: intlOptions().locale });

      this.deviceContext = await this.readDeviceContext(native);

      let tracked = await store.getItemAsync(INSTALL_TRACKED_KEY);
      for (const key of LEGACY_INSTALL_TRACKED_KEYS) tracked = tracked || (await store.getItemAsync(key));
      if (!tracked) {
        const installTime = await native.application.getInstallationTimeAsync();
        await this.sendTrack("install", { install_time: installTime });
        await store.setItemAsync(INSTALL_TRACKED_KEY, "true");
      }
    } catch (error) {
      this.report({ code: "init-failed", message: message(error) });
    }
  }

  private loadModules(): RocalyticsModules | null {
    const injected = this.options.modules;
    if (injected) return injected;
    let reason = "no native modules were provided";
    if (injected === undefined) {
      const result = loadExpoModules();
      if (result.ok) return result.modules;
      reason = result.reason;
    }
    this.report({ code: "native-modules-unavailable", message: `Rocalytics is disabled for this session: ${reason}` });
    return null;
  }

  /**
   * The corrected key's id; else the legacy key's id, copied to the corrected
   * key; else a new id, written under both keys. A read that fails throws, so
   * no id is ever minted while a key may still hold one.
   */
  private async readOrMintRocaId(native: RocalyticsModules): Promise<string> {
    const store = native.secureStore;
    const current = await store.getItemAsync(ROCA_ID_KEY);
    if (current) return current;
    const legacy = await store.getItemAsync(LEGACY_ROCA_ID_KEY);
    if (legacy) {
      try {
        await store.setItemAsync(ROCA_ID_KEY, legacy);
      } catch (error) {
        this.report({ code: "identity-migration-failed", message: `the roca id was kept but not copied to ${ROCA_ID_KEY}: ${message(error)}` });
      }
      return legacy;
    }
    const id = native.crypto.randomUUID();
    await store.setItemAsync(ROCA_ID_KEY, id);
    // Also under the legacy key: if a later over-the-air rollback brings back
    // a bundle with a copied client, which reads only that key, it finds this
    // id instead of minting a second identity for the same device.
    try {
      await store.setItemAsync(LEGACY_ROCA_ID_KEY, id);
    } catch (error) {
      this.report({ code: "identity-legacy-write-failed", message: `the roca id was not also written to ${LEGACY_ROCA_ID_KEY}: ${message(error)}` });
    }
    return id;
  }

  private async readDeviceContext(native: RocalyticsModules): Promise<DeviceContext> {
    const { application: app, device, platform } = native;
    const { width, height, scale } = native.dimensions.get("screen");
    let ip: string | null = null;
    try {
      const result = await native.network.getIpAddressAsync();
      if (result && result !== "0.0.0.0") ip = result;
    } catch {
      // The ip is best-effort.
    }
    const { locale, timeZone } = intlOptions();
    const brand = device.brand ?? platform.OS;
    const model = device.modelName ?? "Unknown";
    const osName = device.osName ?? platform.OS;
    const osVersion = device.osVersion ?? String(platform.Version);
    return {
      ip,
      user_agent: `${app.applicationName ?? "App"}/${app.nativeApplicationVersion ?? "1.0"} (${brand} ${model}; ${osName} ${osVersion}; ${locale})`,
      device_model: device.modelName,
      device_brand: device.brand,
      device_manufacturer: device.manufacturer,
      os_name: device.osName,
      os_version: device.osVersion,
      screen_width: width,
      screen_height: height,
      screen_scale: scale,
      timezone: timeZone,
      locale,
      app_version: app.nativeApplicationVersion,
      app_build: app.nativeBuildVersion,
    };
  }

  /** Only called once `rocaId` and the modules are set. */
  private context(): RequestContext {
    return {
      rocaId: this.rocaId as string,
      applicationId: this.native?.application.applicationId ?? null,
      platform: this.native?.platform.OS ?? "unknown",
      baseUrl: this.options.baseUrl,
    };
  }

  private fetchFn(): FetchLike | undefined {
    return this.options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
  }

  private send(request: RocalyticsRequest, endpoint: string, detail?: string) {
    const fetch = this.fetchFn();
    if (!fetch) return Promise.reject(new Error(`[ROCALYTICS] ${endpoint} failed: no fetch available`));
    return sendRocalyticsRequest(fetch, request, endpoint, detail);
  }

  private async sendIdentify(identifiers: IdentifyParams): Promise<void> {
    const payload = Object.fromEntries(Object.entries(identifiers).filter(([, v]) => v != null));
    await this.send(buildIdentifyRequest(this.context(), payload), "identify");
  }

  private async sendTrack(name: string, properties: Record<string, unknown>, deduplicationId?: string, customEvent?: boolean): Promise<void> {
    const request = buildTrackRequest(this.context(), {
      name,
      properties,
      deviceContext: this.deviceContext,
      deduplicationId,
      customEvent,
    });
    await this.send(request, "track", name);
  }
}
