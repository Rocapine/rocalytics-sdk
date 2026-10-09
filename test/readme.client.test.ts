import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The README's Rocalytics section: its example is a real file that tsc checks
// and this test runs, and its peer table is the manifest's.

const ROOT = path.join(__dirname, "..");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const example = fs.readFileSync(path.join(ROOT, "examples/client.ts"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

describe("the README's Rocalytics section", () => {
  it("shows examples/client.ts verbatim", () => {
    expect(readme).toContain("```ts\n" + example + "```");
  });

  it("the example imports only the public entry points", () => {
    const imports = [...example.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@rocapine/rocalytics-sdk/client", "@rocapine/rocalytics-sdk/onboarding"]);
  });

  it("lists every optional peer with the manifest's range (pipes escaped, as a table cell needs)", () => {
    for (const [name, range] of Object.entries(pkg.peerDependencies as Record<string, string>)) {
      expect(readme).toContain(`| \`${name}\` | \`${range.replace(/\|/g, "\\|")}\` |`);
    }
  });

  it("no longer says the package has no peer dependency at all", () => {
    expect(readme).not.toMatch(/no peer dependency at all/);
  });

  it("the example runs under plain Node: the client it creates is inert and nothing throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rocalytics, onSignedIn, onPurchase } = await import("../examples/client");
    await rocalytics.ready;
    expect(rocalytics.rocaId).toBeNull();
    await onSignedIn("user-42", "$RCAnonymousID:abc");
    const eventId = await onPurchase({ productIdentifier: "pro_yearly" }, { originalTransactionIdentifier: "2000000841136630" }, 0, "EUR", true);
    expect(eventId).toBe("purchase-2000000841136630");
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^\[rocalytics-sdk\] native-modules-unavailable: /)]);
    warn.mockRestore();
  });
});
