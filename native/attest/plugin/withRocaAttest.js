// Config plugin for @rocapine/rocalytics-attest.
//
// iOS: sets the App Attest environment entitlement. "production" (the default) is what
// TestFlight and App Store builds need; "development" is for builds signed with a development
// profile that should talk to Apple's development App Attest environment.
// Android: nothing to configure (Play Integrity needs no manifest entry).

const ENTITLEMENT = "com.apple.developer.devicecheck.appattest-environment";
const ENVIRONMENTS = ["production", "development"];

function setAppAttestEnvironment(entitlements, props) {
  const value = props == null ? undefined : props.appAttestEnvironment;
  // Only a missing option defaults; "", false and the like are mistakes, not "use the default".
  const environment = value == null ? "production" : value;
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(
      `@rocapine/rocalytics-attest: appAttestEnvironment must be "production" or "development", got ${JSON.stringify(environment)}`,
    );
  }
  entitlements[ENTITLEMENT] = environment;
  return entitlements;
}

// `withEntitlementsPlist` is injectable so the plugin can be tested without an Expo install.
function createWithRocaAttest(withEntitlementsPlist) {
  return function withRocaAttest(config, props) {
    const withPlist = withEntitlementsPlist || require("expo/config-plugins").withEntitlementsPlist;
    return withPlist(config, (cfg) => {
      cfg.modResults = setAppAttestEnvironment(cfg.modResults, props);
      return cfg;
    });
  };
}

module.exports = createWithRocaAttest();
module.exports.ENTITLEMENT = ENTITLEMENT;
module.exports.setAppAttestEnvironment = setAppAttestEnvironment;
module.exports.createWithRocaAttest = createWithRocaAttest;
