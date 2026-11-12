import { defineConfig } from "vitest/config";

// Tests against the local stack (local/compose.yaml: Traefik, oauth2-proxy, a stub identity provider and one echo
// backend per service), started by the global setup and removed by its teardown. Needs a running Docker daemon.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    globalSetup: ["tests/support/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    reporters: ["default", "junit"],
    outputFile: { junit: "reports/junit-e2e.xml" },
  },
});
