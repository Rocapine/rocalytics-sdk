import { codePointLength } from "./text";

/**
 * Device and app facts for a run, supplied by the host (the core reads no
 * platform API). Captured once when a run starts.
 */
export interface RunContextInput {
  /** Marketing version, e.g. `2.4.0`. */
  appVersion: string;
  /** Build number, or null on a platform with none. */
  build: string | null;
  platform: "ios" | "android" | "web";
  /** OS version, or null when the platform cannot report one. */
  osVersion: string | null;
  /** BCP 47 tag of the language the flow is shown in, e.g. `fr-FR`. */
  locale: string;
  /** IANA time zone, e.g. `Europe/Paris`. */
  timezone: string;
}

/** The context in its wire form. Country is deliberately absent: the server derives it. */
export interface WireRunContext {
  app_version: string;
  build: string | null;
  platform: "ios" | "android" | "web";
  os_version: string | null;
  locale: string;
  timezone: string;
  library_version?: string;
}

const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const shortText = (v: unknown) => typeof v === "string" && codePointLength(v) >= 1 && codePointLength(v) <= 32;

/**
 * Maps the host's context to its wire form, copying only the known fields.
 * Returns the list of problems instead when a field would fail the schema.
 */
export function captureRunContext(
  input: RunContextInput,
  libraryVersion: string,
): { ok: true; context: WireRunContext } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["context is not an object"] };
  if (!shortText(input.appVersion)) errors.push("appVersion must be 1 to 32 characters");
  if (input.build !== null && !shortText(input.build)) errors.push("build must be null or 1 to 32 characters");
  if (input.platform !== "ios" && input.platform !== "android" && input.platform !== "web") {
    errors.push("platform must be ios, android or web");
  }
  if (input.osVersion !== null && !shortText(input.osVersion)) errors.push("osVersion must be null or 1 to 32 characters");
  if (typeof input.locale !== "string" || !LOCALE.test(input.locale)) errors.push("locale must be a BCP 47 tag");
  if (typeof input.timezone !== "string" || input.timezone.length > 64 || !TIMEZONE.test(input.timezone)) {
    errors.push("timezone must be an IANA name of at most 64 characters");
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    context: {
      app_version: input.appVersion,
      build: input.build,
      platform: input.platform,
      os_version: input.osVersion,
      locale: input.locale,
      timezone: input.timezone,
      library_version: libraryVersion,
    },
  };
}
