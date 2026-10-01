import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The example imports the package by name, as an app would.
    alias: {
      "@rocapine/studio-sdk/onboarding": path.resolve(__dirname, "src/onboarding/index.ts"),
      "@rocapine/studio-sdk/core": path.resolve(__dirname, "src/core/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
