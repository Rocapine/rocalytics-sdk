// Captures the wire fixtures that test/rocalytics.reference.test.ts replays
// against the packaged client. The requests come from running the REFERENCE
// client itself, not from this package, so "the port sends what the reference
// sends" is checked against something the port did not produce.
//
//   node scripts/capture-rocalytics-fixtures.mjs \
//     --reference <path to the reference rocalytics.client.ts> --reference-rev <git sha> \
//     --demand-score <path to a copy that has getDemandScore> \
//     --dedup-suffix <path to a copy whose trackCustomEvent takes a dedupSuffix>
//
// The reference has no demand score and no dedup suffix, so those two
// behaviours are captured from the copies that have them, and only their
// request to that one endpoint is kept.
//
// Each source file runs unmodified under Node's TypeScript type stripping,
// with the Expo modules and react-native replaced by fakes driven by the
// scenario's `device` and `store`, a frozen clock and a recording fetch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "test/fixtures/rocalytics-reference.json");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith("--") ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), []),
);
for (const k of ["reference", "reference-rev", "demand-score", "dedup-suffix"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const ID = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
const IOS = {
  platform: "ios",
  platformVersion: "18.1",
  applicationId: "com.example.app",
  applicationName: "Example",
  nativeApplicationVersion: "2.4.0",
  nativeBuildVersion: "412",
  idfv: "0A1B2C3D-4E5F-4061-8273-94A5B6C7D8E9",
  androidId: null,
  installTime: "2026-01-10T07:59:00.000Z",
  brand: "Apple",
  modelName: "iPhone 15 Pro",
  manufacturer: "Apple",
  osName: "iOS",
  osVersion: "18.1",
  ip: "203.0.113.7",
  screen: { width: 393, height: 852, scale: 3 },
  uuid: ID,
  locale: "en-US",
  timeZone: "Europe/Paris",
};
const ANDROID = {
  ...IOS,
  platform: "android",
  platformVersion: 34,
  idfv: null,
  androidId: "9774d56d682e549c",
  brand: "google",
  modelName: null, // the user agent falls back to "Unknown"
  manufacturer: "Google",
  osName: "Android",
  osVersion: null, // the user agent falls back to Platform.Version
  ip: "0.0.0.0", // reported as no ip
  screen: { width: 411.4, height: 914.3, scale: 2.625 },
  locale: "fr-FR",
  timeZone: "Europe/Paris",
};
const RETURNING = { "rocalytics-roca-id": ID, "rocadata-install-tracked": "true" };
// The copies read the misspelled id key and, in one copy, a different install key.
const RETURNING_COPY = {
  "rocalitics-roca-id": ID,
  "rocadata-install-tracked": "true",
  "rocadata-install-tracked-4": "true",
};
const T0 = "2026-01-10T08:00:00.000Z";

const SCENARIOS = [
  { name: "a fresh iOS device: init sends identify, then install", source: "reference", device: IOS, store: {}, steps: [{ call: "ready", now: T0 }] },
  { name: "a fresh Android device with no ip and missing device fields", source: "reference", device: ANDROID, store: {}, steps: [{ call: "ready", now: T0 }] },
  { name: "a returning device: init only identifies", source: "reference", device: IOS, store: RETURNING, steps: [{ call: "ready", now: T0 }] },
  {
    name: "track sends a named event with the default deduplication id",
    source: "reference",
    device: IOS,
    store: RETURNING,
    steps: [
      { call: "track", now: T0, args: ["onboarding_completed", { flow: "main", steps_seen: 6 }] },
      { call: "track", now: T0, args: ["onboarding_completed"] },
    ],
  },
  {
    name: "trackPurchase sends the purchase properties and a per-transaction deduplication id",
    source: "reference",
    device: IOS,
    store: RETURNING,
    steps: [
      {
        call: "trackPurchase",
        now: T0,
        args: [
          {
            isTrial: true,
            value: 0,
            currency: "EUR",
            originalTransactionIdentifier: "2000000841136630",
            product: { productIdentifier: "pro_yearly_7d", localizedPrice: "44,99 €", subscriptionPeriod: "P1Y" },
            transaction: { originalTransactionIdentifier: "2000000841136630", transactionDate: "2026-01-10T08:00:00Z" },
          },
        ],
      },
    ],
  },
  {
    name: "trackCustomEvent flags the event as custom",
    source: "reference",
    device: IOS,
    store: RETURNING,
    steps: [{ call: "trackCustomEvent", now: T0, args: ["cart_abandoned", { item_count: 2 }] }, { call: "trackCustomEvent", now: T0, args: ["streak_lost"] }],
  },
  {
    name: "trackOnboarding resends the whole snapshot on every call",
    source: "reference",
    device: IOS,
    store: RETURNING,
    steps: [
      { call: "trackOnboarding", now: "2026-01-10T08:00:01.000Z", args: ["welcome", undefined, { onboarding_id: "onb_123", deployment_id: "dep_789" }] },
      { call: "trackOnboarding", now: "2026-01-10T08:00:05.250Z", args: ["goal"] },
      { call: "trackOnboarding", now: "2026-01-10T08:00:09.000Z", args: ["goal", { goal: "lose_weight" }, { audience_id: "aud_456" }] },
      { call: "trackOnboarding", now: "2026-01-10T08:00:11.000Z", args: ["goal", { level: "beginner" }] },
      { call: "trackOnboarding", now: "2026-01-10T08:00:15.000Z", args: ["welcome"] },
    ],
  },
  {
    name: "identify drops null and undefined identifiers",
    source: "reference",
    device: IOS,
    store: RETURNING,
    steps: [
      { call: "ready", now: T0 },
      {
        call: "identify",
        now: T0,
        args: [{ user_id: "user-42", email: null, revenue_cat_id: "$RCAnonymousID:abc", idfa: undefined, adjust_attribution: { network: "Organic", trackerToken: null } }],
      },
    ],
  },
  {
    name: "a failed request rejects with the endpoint and status",
    source: "reference",
    device: IOS,
    store: RETURNING,
    respond: { "/functions/v1/track": { status: 500 } },
    steps: [{ call: "track", now: T0, args: ["install", { install_time: "2026-01-10T07:59:00.000Z" }] }],
  },
  {
    name: "trackCustomEvent with a dedup suffix scopes the deduplication id",
    source: "dedup-suffix",
    only: ["/functions/v1/track"],
    device: IOS,
    store: RETURNING_COPY,
    steps: [{ call: "trackCustomEvent", now: T0, args: ["daily_checkin", { streak: 3 }, "2026-01-10"] }],
  },
  {
    name: "getDemandScore posts the signals and returns the response",
    source: "demand-score",
    only: ["/functions/v1/demand-score"],
    device: IOS,
    store: RETURNING_COPY,
    respond: {
      "/functions/v1/demand-score": {
        status: 200,
        json: {
          demandScore: 73,
          selectedVersion: "v1",
          coldStart: false,
          versions: { v1: { score: 73, coldStart: false, signals: [{ signal: "paywallViews", value: 0.5, weight: 14, weighted: 7 }] } },
        },
      },
    },
    steps: [
      { call: "getDemandScore", now: T0, args: [{ device_model: "iPhone16,1", connection_type: "wifi", app_open_count: 37 }] },
      { call: "getDemandScore", now: T0, args: [{}] },
      { call: "getDemandScore", now: T0, args: [] },
    ],
  },
];

// --- fakes -----------------------------------------------------------------

const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocalytics-capture-"));
const mod = (name, source) => {
  const dir = path.join(fakeDir, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(dir, "index.js"), source);
};
const s = "globalThis.__capture";
mod(
  "expo-application",
  `export let applicationId, applicationName, nativeApplicationVersion, nativeBuildVersion;
${s}.configure.push((d) => { applicationId = d.applicationId; applicationName = d.applicationName; nativeApplicationVersion = d.nativeApplicationVersion; nativeBuildVersion = d.nativeBuildVersion; });
export const getIosIdForVendorAsync = async () => ${s}.device.idfv;
export const getAndroidId = () => ${s}.device.androidId;
export const getInstallationTimeAsync = async () => new Date(${s}.device.installTime);`,
);
mod("expo-crypto", `export const randomUUID = () => ${s}.device.uuid;`);
mod(
  "expo-device",
  `export let brand, modelName, manufacturer, osName, osVersion;
${s}.configure.push((d) => { brand = d.brand; modelName = d.modelName; manufacturer = d.manufacturer; osName = d.osName; osVersion = d.osVersion; });`,
);
mod("expo-network", `export const getIpAddressAsync = async () => ${s}.device.ip;`);
mod(
  "expo-secure-store",
  `export const getItemAsync = async (k) => ${s}.store.get(k) ?? null;
export const setItemAsync = async (k, v) => void ${s}.store.set(k, v);`,
);
mod(
  "react-native",
  `export const Platform = { get OS() { return ${s}.device.platform; }, get Version() { return ${s}.device.platformVersion; } };
export const Dimensions = { get: () => ({ ...${s}.device.screen, fontScale: 1 }) };`,
);
fs.writeFileSync(path.join(fakeDir, "package.json"), JSON.stringify({ type: "module" }));

const RealDate = Date;
const capture = { configure: [], device: null, store: new Map(), now: 0, requests: [], respond: {} };
globalThis.__capture = capture;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [capture.now]));
  }
  static now() {
    return capture.now;
  }
};
const RealIntl = Intl.DateTimeFormat;
Intl.DateTimeFormat = function (...a) {
  if (a.length) return new RealIntl(...a);
  return { resolvedOptions: () => ({ ...new RealIntl().resolvedOptions(), locale: capture.device.locale, timeZone: capture.device.timeZone }) };
};
globalThis.fetch = async (url, init) => {
  const endpoint = new URL(url).pathname;
  capture.requests.push({
    url,
    method: init.method,
    headers: init.headers,
    body: init.body === undefined ? null : JSON.parse(init.body),
  });
  const r = capture.respond[endpoint] ?? { status: endpoint === "/functions/v1/identify" ? 200 : 204 };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json ?? {}, text: async () => JSON.stringify(r.json ?? {}) };
};
const quiet = { error: console.error, info: console.info };

const sources = {};
for (const key of ["reference", "demand-score", "dedup-suffix"]) {
  const file = path.join(fakeDir, `${key}.ts`);
  fs.copyFileSync(path.resolve(args[key]), file);
  sources[key] = file;
}

// --- run -------------------------------------------------------------------

const results = [];
for (const scenario of SCENARIOS) {
  capture.device = scenario.device;
  capture.store = new Map(Object.entries(scenario.store));
  capture.requests = [];
  capture.respond = scenario.respond ?? {};
  capture.now = RealDate.parse(scenario.steps[0].now);
  // A fresh module instance per scenario, so no state leaks between them.
  const { RocalyticsClient } = await import(`${pathToFileURL(sources[scenario.source]).href}?scenario=${results.length}`);
  // After the import: the fakes register their configure hooks when first loaded.
  if (capture.configure.length !== 2) throw new Error("the fake modules did not register");
  for (const f of capture.configure) f(scenario.device);
  console.error = console.info = () => {};
  const client = new RocalyticsClient();
  const returned = [];
  for (const step of scenario.steps) {
    capture.now = RealDate.parse(step.now);
    try {
      const value = step.call === "ready" ? await client.ready : await client[step.call](...(step.args ?? []));
      returned.push(value === undefined ? null : { value });
    } catch (error) {
      returned.push({ error: error.message });
    }
  }
  await client.ready;
  Object.assign(console, quiet);
  const requests = capture.requests.filter((r) => !scenario.only || scenario.only.includes(new URL(r.url).pathname));
  results.push({ ...scenario, returned, requests });
}

const fixture = {
  $comment:
    "Generated by scripts/capture-rocalytics-fixtures.mjs from the reference Rocalytics client (and, for the two behaviours it lacks, from the copies that have them). Do not edit by hand.",
  reference: { repository: "Rocapine/rocalytics", path: "plugins/rocalytics-setup/skills/rocalytics-setup/references/rocalytics.client.ts", rev: args["reference-rev"] },
  scenarios: JSON.parse(JSON.stringify(results)),
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
fs.rmSync(fakeDir, { recursive: true, force: true });
console.log(`wrote ${results.length} scenarios, ${results.reduce((n, r) => n + r.requests.length, 0)} requests to ${path.relative(root, out)}`);
