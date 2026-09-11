import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// GitHub Pages project sites are served from /<repo>/, so the deploy workflow
// passes BASE_PATH=/xctrack-sbb-widget/. Local dev and user sites use "/".
const base = process.env["BASE_PATH"] ?? "/";

/**
 * Cache-busting id for the service worker. The dataset's own build id is the
 * right thing to key on: a new stops.json must invalidate every cached copy.
 */
function buildId(): string {
  try {
    const meta = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "public/data/meta.json"), "utf8"),
    ) as { buildId?: unknown };
    if (typeof meta.buildId === "string" && meta.buildId) return meta.buildId;
  } catch {
    // No dataset yet (fresh clone, CI before the ETL): fall back to the clock.
  }
  return `dev-${Date.now()}`;
}

export default defineConfig({
  base,
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        setup: resolve(import.meta.dirname, "setup.html"),
        // The service worker must sit at the site root to claim the whole scope,
        // so it is emitted as `sw.js` rather than a hashed asset.
        sw: resolve(import.meta.dirname, "src/sw.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
      },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
