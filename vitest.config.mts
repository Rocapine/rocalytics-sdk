import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The example imports the package by name, as an app would.
    alias: {
      "@rocapine/rocalytics-sdk/onboarding": path.resolve(__dirname, "src/onboarding/index.ts"),
      "@rocapine/rocalytics-sdk/core": path.resolve(__dirname, "src/core/index.ts"),
      "@rocapine/rocalytics-sdk/client": path.resolve(__dirname, "src/client/index.ts"),
      "@rocapine/rocalytics-sdk/paywall": path.resolve(__dirname, "src/paywall/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
