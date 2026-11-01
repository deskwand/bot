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
  },
});
