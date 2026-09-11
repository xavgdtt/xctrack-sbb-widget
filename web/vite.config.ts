import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// GitHub Pages project sites are served from /<repo>/, so the deploy workflow
// passes BASE_PATH=/xctrack-sbb-widget/. Local dev and user sites use "/".
const base = process.env["BASE_PATH"] ?? "/";

export default defineConfig({
  base,
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        setup: resolve(import.meta.dirname, "setup.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
