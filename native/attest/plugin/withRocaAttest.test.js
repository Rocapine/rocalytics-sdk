// Run with `node --test native/attest/plugin/withRocaAttest.test.js`.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createWithRocaAttest, ENTITLEMENT } = require("./withRocaAttest");

// Stands in for expo's withEntitlementsPlist: runs the mod on the given entitlements at once.
function stubWithEntitlementsPlist(config, mod) {
  const result = mod({ ...config, modResults: { ...config.entitlements } });
  return { ...config, entitlements: result.modResults };
}

const withRocaAttest = createWithRocaAttest(stubWithEntitlementsPlist);
const baseConfig = { name: "app", slug: "app", entitlements: { "aps-environment": "production" } };

test("defaults the App Attest environment to production", () => {
  assert.equal(withRocaAttest(baseConfig).entitlements[ENTITLEMENT], "production");
  assert.equal(withRocaAttest(baseConfig, {}).entitlements[ENTITLEMENT], "production");
  assert.equal(withRocaAttest(baseConfig, { appAttestEnvironment: undefined }).entitlements[ENTITLEMENT], "production");
  assert.equal(withRocaAttest(baseConfig, { appAttestEnvironment: null }).entitlements[ENTITLEMENT], "production");
});

test("sets production", () => {
  const out = withRocaAttest(baseConfig, { appAttestEnvironment: "production" });
  assert.equal(out.entitlements[ENTITLEMENT], "production");
});

test("sets development", () => {
  const out = withRocaAttest(baseConfig, { appAttestEnvironment: "development" });
  assert.equal(out.entitlements[ENTITLEMENT], "development");
});

test("keeps the other entitlements", () => {
  assert.equal(withRocaAttest(baseConfig).entitlements["aps-environment"], "production");
});

test("rejects an unknown environment", () => {
  assert.throws(() => withRocaAttest(baseConfig, { appAttestEnvironment: "staging" }), /appAttestEnvironment/);
});

test("rejects an empty or non-string environment instead of defaulting", () => {
  for (const appAttestEnvironment of ["", false, 0, "Production"]) {
    assert.throws(() => withRocaAttest(baseConfig, { appAttestEnvironment }), /appAttestEnvironment/);
  }
});

test("app.plugin.js exports the plugin", () => {
  const plugin = require("../app.plugin.js");
  assert.equal(typeof plugin, "function");
  assert.equal(plugin.ENTITLEMENT, ENTITLEMENT);
});
