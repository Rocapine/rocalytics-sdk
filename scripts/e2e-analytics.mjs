// End-to-end: the BUILT /analytics subpath, from plain Node, against the deployed warehouse ingest,
// checked in BigQuery (raw_events.events) through the `bq` CLI on your gcloud login.
//
//   npm run build && INGEST_URL=https://<event-ingest>/v1/batch node scripts/e2e-analytics.mjs
//
// Rows use app id com.rocapine.e2e (allowlisted for tests only) and carry a per-run `e2e_run` property.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { createAnalytics } = require("../dist/analytics/index.js");
const { memoryStorage } = require("../dist/core/index.js");

const url = process.env.INGEST_URL;
if (!url) throw new Error("set INGEST_URL (…/v1/batch)");
const project = process.env.GCP_PROJECT ?? "rocalytics-513516";
const run = randomUUID().slice(0, 12);
const diagnostics = [];

const storage = memoryStorage();
const make = (rocaId) =>
  createAnalytics({
    appId: "com.rocapine.e2e",
    platform: "ios",
    endpoint: url,
    rocaId: () => rocaId,
    context: { appVersion: "0.0.0-e2e", osVersion: "node", locale: "en-US" },
    storage,
    flushAt: 50,
    flushIntervalMs: 60_000,
    onDiagnostic: (d) => diagnostics.push(d),
  });

// 1. roca_id unknown at track time, known at send; 120 events → 3 batches (50, 50, 20)
let roca = null;
const a = createAnalytics({
  appId: "com.rocapine.e2e", platform: "ios", endpoint: url, rocaId: () => roca,
  context: { appVersion: "0.0.0-e2e" }, storage, flushAt: 500, onDiagnostic: (d) => diagnostics.push(d),
});
a.setUserId(`user-${run}`);
for (let i = 0; i < 120; i++) a.track("e2e_sdk_event", { e2e_run: run, i });
a.identify({ e2e_run: run, plan: "pro" });
roca = `roca-${run}`;
await a.flush();
await a.idle();
a.dispose();

// 2. a restart: a new instance on the same storage sends with the persisted user id
const b = make(`roca-${run}`);
b.track("e2e_sdk_after_restart", { e2e_run: run });
await b.flush();
b.dispose();

const sql = `SELECT name, COUNT(*) n, COUNT(DISTINCT event_id) ids, COUNTIF(roca_id = 'roca-${run}') with_roca,
  COUNTIF(user_id = 'user-${run}') with_user, COUNT(DISTINCT session_id) sessions,
  ANY_VALUE(TO_JSON_STRING(user_properties)) up
  FROM \`${project}.raw_events.events\`
  WHERE event_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) AND app_id = 'com.rocapine.e2e'
    AND (JSON_VALUE(properties, '$.e2e_run') = '${run}' OR JSON_VALUE(user_properties, '$.e2e_run') = '${run}')
  GROUP BY name`;
const expected = { e2e_sdk_event: 120, $identify: 1, e2e_sdk_after_restart: 1 };
let rows = [];
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  rows = JSON.parse(execFileSync("bq", ["query", `--project_id=${project}`, "--use_legacy_sql=false", "--format=json", "--quiet", sql], { encoding: "utf8" }) || "[]");
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  if (total >= 122) break;
  await sleep(10_000);
}

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };
const by = Object.fromEntries(rows.map((r) => [r.name, r]));
for (const [name, n] of Object.entries(expected)) {
  check(Number(by[name]?.n) === n && Number(by[name]?.ids) === n, `${name}: ${n} rows, ${n} distinct event_ids (got ${by[name]?.n ?? 0})`);
}
check(Number(by.e2e_sdk_event?.with_roca) === 120, "roca_id resolved after track() is attached at send");
check(Number(by.e2e_sdk_event?.with_user) === 120, "user_id attached");
check(Number(by.e2e_sdk_event?.sessions) === 1, "one session");
check(JSON.parse(by.$identify?.up ?? "{}").plan === "pro", "$identify carries user_properties");
check(Number(by.e2e_sdk_after_restart?.with_user) === 1, "persisted user id survives a restart");
check(!diagnostics.some((d) => d.code === "rejected"), `no rejected batches (${diagnostics.map((d) => d.code).join(",") || "no diagnostics"})`);
console.log(`run ${run}`);
if (failures.length) process.exit(1);
