// The service worker's routing decision, split out so it can be tested without
// a ServiceWorkerGlobalScope. Vite inlines it into dist/sw.js at build time.

/**
 * What the fetch handler does with a request.
 *
 *   passthrough    — not intercepted at all; the browser fetches it normally
 *   network-first  — network, falling back to cache when it fails (offline)
 *   cache-first    — cache, falling back to network and filling the cache
 *   table          — cache-first with a weekly background revalidation
 */
export type Strategy = "passthrough" | "network-first" | "cache-first" | "table";

/**
 * Pick the strategy for one GET request.
 *
 * `mode` is `request.mode`; `origin` is the worker's own origin. HTML is
 * network-first because the shell must follow a new deploy immediately, while
 * everything under `assets/` carries a content hash and can never go stale.
 */
export function strategyFor(url: URL, mode: string, origin: string): Strategy {
  // transport.opendata.ch and anything else cross-origin: the app layer owns it.
  if (url.origin !== origin) return "passthrough";
  // The worker script itself is never served from the worker's own cache, or a
  // new sw.js could never be seen.
  if (url.pathname.endsWith("/sw.js")) return "passthrough";
  // Tables ship gzipped; .bin is the fallback build_tables.py --also-plain emits.
  if (
    url.pathname.includes("/data/tables/") &&
    (url.pathname.endsWith(".bin") || url.pathname.endsWith(".bin.gz"))
  ) {
    return "table";
  }
  if (mode === "navigate" || url.pathname.endsWith(".html")) return "network-first";
  // Hashed bundles: the name changes when the content does, so a hit is correct
  // forever. Everything else same-origin (data/, icons) is keyed by cache name,
  // which carries the app build id and so is empty again after every deploy.
  return "cache-first";
}
