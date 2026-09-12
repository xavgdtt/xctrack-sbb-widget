import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// GitHub Pages project sites are served from /<repo>/, so the deploy workflow
// passes BASE_PATH=/xctrack-sbb-widget/. Local dev and user sites use "/".
const base = process.env["BASE_PATH"] ?? "/";

/**
 * Dataset build id: changes when the ETL republishes stops.json, and so must
 * invalidate every cached copy of it.
 */
function dataBuildId(): string {
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

/**
 * App build id: changes on every deploy, which the dataset id does not. Without
 * it sw.js stays byte-identical across deploys, the browser detects no update,
 * and a widget in the field serves the old shell from cache forever.
 */
function appBuildId(): string {
  const fromCi = process.env["GITHUB_SHA"];
  if (fromCi) return fromCi.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // No git (tarball export, shallow container): the clock at least changes.
    return `t${Date.now()}`;
  }
}

export default defineConfig({
  base,
  define: {
    __DATA_BUILD_ID__: JSON.stringify(dataBuildId()),
    __APP_BUILD_ID__: JSON.stringify(appBuildId()),
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
