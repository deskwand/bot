import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } }),
  ],
  test: {
    // Node-only tests use Node APIs (fs, child processes, signing keys) and
    // must never be collected by the workerd pool.
    include: ["tests/**/*.test.ts"],
    // Shared CI runners are slow enough that a healthy test can take longer
    // than 5s. Keep the tight bound locally, where a hang should surface fast.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 5_000,
  },
});
