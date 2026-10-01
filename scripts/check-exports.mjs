// Smoke check of the BUILT package (run after `npm run build`):
//  1. the subpaths resolve by package name through the `exports` map, as an app would import them;
//  2. they also resolve through the legacy `onboarding/` and `core/` stub folders, for resolvers without `exports`;
//  3. the built JavaScript requires nothing but its own relative files.
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

check(require(path.join(root, "onboarding")).onboardingRun === onboarding.onboardingRun, "onboarding/ stub folder resolves to the same module");
check(typeof require(path.join(root, "core")).uuidv7 === "function", "core/ stub folder resolves");

for (const sub of ["onboarding", "core"]) {
  check(fs.existsSync(path.join(root, "dist", sub, "index.d.ts")), `dist/${sub}/index.d.ts exists`);
}

const listJs = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listJs(path.join(dir, d.name)) : d.name.endsWith(".js") ? [path.join(dir, d.name)] : [],
  );
const external = [];
for (const file of listJs(path.join(root, "dist"))) {
  for (const m of fs.readFileSync(file, "utf8").matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!m[1].startsWith("./") && !m[1].startsWith("../")) external.push(`${path.relative(root, file)} -> ${m[1]}`);
  }
}
check(external.length === 0, `built output requires no package${external.length ? `: ${external.join(", ")}` : ""}`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
