import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The production build includes only index.html (src/main.tsx). The mock-backed
// Playwright entry lives in test.html and is served only by the Vite dev server.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/.mygo/**", "**/build/**"] },
  },
});
