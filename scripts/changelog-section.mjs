// Prints the body of CHANGELOG.md's `## [<version>]` section, up to the next
// `## [` heading, trimmed: the GitHub Release body (.github/workflows/release.yml).
// Exits 1 when the version has no section.
//   node scripts/changelog-section.mjs <version> [--file <CHANGELOG.md>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const version = args[0];
const fileAt = args.indexOf("--file");
const file =
  fileAt === -1 ? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md") : args[fileAt + 1];

if (!version) {
  console.error("usage: node scripts/changelog-section.mjs <version> [--file <CHANGELOG.md>]");
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf8").split("\n");
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`no "## [${version}]" section in ${file}`);
  process.exit(1);
}
const next = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
const body = lines.slice(start + 1, next === -1 ? undefined : next).join("\n").trim();
process.stdout.write(`${body}\n`);
