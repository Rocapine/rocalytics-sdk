// Prepares a release commit: the same four files as the 0.10.0 release (61efd05).
//  - package.json and package-lock.json (root and packages[""]): the version;
//  - src/version.ts: LIBRARY_VERSION;
//  - CHANGELOG.md: what is under `## [Unreleased]` moves to `## [<version>] - <date>`
//    right below it, leaving `## [Unreleased]` empty.
// Refuses (exit 1, nothing written) a version that is not semver or not above the
// current one, or an empty [Unreleased]. Merging a `chore(release): <version>`
// commit to main then tags and releases it (.github/workflows/release.yml).
//   node scripts/release.mjs <version> [--root <dir>] [--date YYYY-MM-DD]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

// Semver precedence: >0 when a is above b. Build metadata is not accepted.
const compare = (a, b) => {
  const [, ...pa] = SEMVER.exec(a);
  const [, ...pb] = SEMVER.exec(b);
  for (let i = 0; i < 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (!pa[3] || !pb[3]) return (pa[3] ? -1 : 0) - (pb[3] ? -1 : 0);
  const ia = pa[3].split(".");
  const ib = pb[3].split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    if (ia[i] === ib[i]) continue;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb) return Number(ia[i]) - Number(ib[i]);
    if (na !== nb) return na ? -1 : 1;
    return ia[i] < ib[i] ? -1 : 1;
  }
  return 0;
};

// Replaces exactly one match, or fails: a file whose shape changed is not guessed at.
const replaceOnce = (text, pattern, replacement, what) => {
  if ((text.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? []).length !== 1) fail(`cannot find ${what}`);
  return text.replace(pattern, replacement);
};

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const version = args[0];
const root = option("--root", path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const date = option("--date", new Date().toISOString().slice(0, 10));

if (!version || !SEMVER.test(version)) fail(`"${version ?? ""}" is not a semver version (x.y.z or x.y.z-pre)`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`date "${date}" is not YYYY-MM-DD`);

const file = (name) => path.join(root, name);
const read = (name) => fs.readFileSync(file(name), "utf8");

const pkg = read("package.json");
const current = JSON.parse(pkg).version;
if (compare(version, current) <= 0) fail(`${version} is not above the current version ${current}`);

const changelog = read("CHANGELOG.md");
const unreleased = /^## \[Unreleased\]\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(changelog);
if (!unreleased) fail("CHANGELOG.md has no ## [Unreleased] section");
if (unreleased[1].trim() === "") fail("CHANGELOG.md's ## [Unreleased] section is empty: nothing to release");

const v = JSON.stringify(version);
const out = {
  "package.json": replaceOnce(pkg, /^( {2}"version": )"[^"]*"/m, `$1${v}`, 'package.json "version"'),
  "package-lock.json": replaceOnce(
    replaceOnce(read("package-lock.json"), /^( {2}"version": )"[^"]*"/m, `$1${v}`, 'package-lock.json "version"'),
    /^( {4}"": \{\n {6}"name": "[^"]*",\n {6}"version": )"[^"]*"/m,
    `$1${v}`,
    'package-lock.json packages[""].version',
  ),
  "src/version.ts": replaceOnce(
    read("src/version.ts"),
    /^(export const LIBRARY_VERSION = )"[^"]*";$/m,
    `$1${v};`,
    "LIBRARY_VERSION in src/version.ts",
  ),
  "CHANGELOG.md":
    changelog.slice(0, unreleased.index) +
    `## [Unreleased]\n\n## [${version}] - ${date}\n${unreleased[1].replace(/^\n+/, "")}` +
    changelog.slice(unreleased.index + unreleased[0].length),
};

for (const [name, text] of Object.entries(out)) fs.writeFileSync(file(name), text);
console.log(`release: ${current} -> ${version} (${date}). Commit as "chore(release): ${version}".`);
