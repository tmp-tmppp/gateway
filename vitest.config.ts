import { defineConfig } from "vitest/config";

// The drift tests need Helm and no Docker: they compare the chart's rendered routes, middlewares and oauth2-proxy
// settings with the local proof (local/). The tests against the running stack are in tests/e2e ("npm run test:e2e").
export default defineConfig({
  test: {
    include: ["tests/drift/**/*.test.ts"],
    testTimeout: 60_000,
    reporters: ["default", "junit"],
    outputFile: { junit: "reports/junit.xml" },
  },
});
