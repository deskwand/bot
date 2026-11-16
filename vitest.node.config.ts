import { defineConfig } from "vitest/config";

// Node-only tests (filesystem, subprocesses, signing keys) live in tests-node/.
// The default workerd pool cannot provide those APIs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests-node/**/*.test.ts"],
    // Same CI headroom as vitest.config.ts: these spawn subprocesses, which a
    // shared runner can stretch past 5s.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 5_000,
  },
});
