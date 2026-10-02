// Smoke check of the BUILT package (run after `npm run build`):
//  1. the subpaths resolve by package name through the `exports` map, as an app would import them;
//  2. they also resolve through the legacy `onboarding/`, `core/` and `rocalytics/` stub folders, for resolvers without `exports`;
//  3. everything /onboarding and /core load, transitively, is the package's own files, with no package
//     required and no /rocalytics file reached: an app that only tracks onboarding bundles no native module;
//  4. the only packages the built output requires are /rocalytics's optional peers, all from one file;
//  5. under plain Node, where none of those peers exist, the built client starts inert and does not throw.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

const onboarding = require("@rocapine/studio-sdk/onboarding");
check(typeof onboarding.onboardingRun?.start === "function", "@rocapine/studio-sdk/onboarding exports onboardingRun.start");
check(typeof onboarding.createOnboardingRunTracker === "function", "@rocapine/studio-sdk/onboarding exports createOnboardingRunTracker");
check(typeof onboarding.createHttpSink === "function", "@rocapine/studio-sdk/onboarding exports createHttpSink");
const core = require("@rocapine/studio-sdk/core");
check(typeof core.createDelivery === "function", "@rocapine/studio-sdk/core exports createDelivery");
const rocalytics = require("@rocapine/studio-sdk/rocalytics");
check(typeof rocalytics.RocalyticsClient === "function", "@rocapine/studio-sdk/rocalytics exports RocalyticsClient");

check(require(path.join(root, "onboarding")).onboardingRun === onboarding.onboardingRun, "onboarding/ stub folder resolves to the same module");
check(typeof require(path.join(root, "core")).uuidv7 === "function", "core/ stub folder resolves");
check(require(path.join(root, "rocalytics")).RocalyticsClient === rocalytics.RocalyticsClient, "rocalytics/ stub folder resolves to the same module");

for (const sub of ["onboarding", "core", "rocalytics"]) {
  check(fs.existsSync(path.join(root, "dist", sub, "index.d.ts")), `dist/${sub}/index.d.ts exists`);
}

const REQUIRE = /require\(\s*["']([^"']+)["']\s*\)/g;
const isRelative = (s) => s.startsWith("./") || s.startsWith("../");
const requiresOf = (file) => [...fs.readFileSync(file, "utf8").matchAll(REQUIRE)].map((m) => m[1]);
const resolveJs = (from, spec) => {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${path.relative(root, from)}: cannot resolve ${spec}`);
};

for (const sub of ["onboarding", "core"]) {
  const seen = new Set();
  const external = [];
  const stack = [path.join(root, "dist", sub, "index.js")];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of requiresOf(file)) {
      if (isRelative(spec)) stack.push(resolveJs(file, spec));
      else external.push(`${path.relative(root, file)} -> ${spec}`);
    }
  }
  const reached = [...seen].map((f) => path.relative(path.join(root, "dist"), f));
  check(external.length === 0, `/${sub} transitively requires no package${external.length ? `: ${external.join(", ")}` : ""} (${reached.length} files)`);
  check(!reached.some((f) => f.startsWith(`rocalytics${path.sep}`)), `/${sub} never reaches a dist/rocalytics file`);
}

const PEERS = Object.keys(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).peerDependencies ?? {}).sort();
const listJs = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listJs(path.join(dir, d.name)) : d.name.endsWith(".js") ? [path.join(dir, d.name)] : [],
  );
const external = new Map();
for (const file of listJs(path.join(root, "dist"))) {
  for (const spec of requiresOf(file).filter((s) => !isRelative(s))) {
    const rel = path.relative(root, file);
    external.set(rel, [...(external.get(rel) ?? []), spec]);
  }
}
const files = [...external.keys()];
const required = [...new Set([...external.values()].flat())].sort();
check(files.length === 1 && files[0] === path.join("dist", "rocalytics", "native.js"), `only dist/rocalytics/native.js requires a package (found: ${files.join(", ") || "none"})`);
check(JSON.stringify(required) === JSON.stringify(PEERS), `it requires exactly the optional peers (${required.join(", ")})`);

const diagnostics = [];
let threw = null;
try {
  const client = new rocalytics.RocalyticsClient({ onDiagnostic: (d) => diagnostics.push(d) });
  await client.ready;
  await client.track("install");
  check(client.rocaId === null, "under plain Node the built client is inert (no roca id)");
} catch (error) {
  threw = error;
}
check(threw === null, `the built client does not throw without its peers${threw ? `: ${threw}` : ""}`);
check(
  diagnostics.length === 1 && diagnostics[0].code === "native-modules-unavailable" && /expo-modules-core/.test(diagnostics[0].message),
  `and reports why: ${diagnostics.map((d) => `${d.code}: ${d.message.split("\n")[0]}`).join("; ")}`,
);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
