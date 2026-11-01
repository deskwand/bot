import { defineConfig } from "vitest/config";

// Node-only tests (filesystem, subprocesses, signing keys) live in tests-node/.
// The default workerd pool cannot provide those APIs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests-node/**/*.test.ts"],
  },
});
