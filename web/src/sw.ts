// Service worker. Built by Vite as a separate entry emitted at the site root as
// `sw.js` (see vite.config.ts), with `__APP_BUILD_ID__` and `__DATA_BUILD_ID__`
// replaced at build time. The app id is the git commit SHA, so every deploy
// produces a different sw.js and a different cache name; the dataset id is in
// the name too, so a republished stops.json invalidates the cache on its own.
//
// Strategy (see strategyFor in sw-route.ts):
//   navigations and *.html          -> network-first, cached copy as fallback
//   assets/<hashed>                 -> cache-first (immutable)
//   data/stops.json[.gz], meta.json -> cache-first, precached per build id
//   data/tables/*.bin[.gz]          -> cache-first, revalidated once a week
//   sw.js, transport.opendata.ch    -> not intercepted

import { strategyFor } from "./sw-route";

declare const __APP_BUILD_ID__: string;
declare const __DATA_BUILD_ID__: string;

const BUILD_ID = `${__APP_BUILD_ID__}-${__DATA_BUILD_ID__}`;
const CACHE = `xsbt-${BUILD_ID}`;
// Per-home tables are large and versioned by their own weekly revalidation, so
// they live outside the per-build cache and survive a deploy.
const TABLE_CACHE = "xsbt-tables";
const TABLE_MAX_AGE_MS = 7 * 24 * 3600_000;
const CACHED_AT = "x-xsbt-cached-at";

/* Minimal service-worker typings. The project's tsconfig loads lib.dom, and
   pulling in lib.webworker alongside it collides, so declare just what is used. */
interface SwClient {
  postMessage(message: unknown): void;
}
interface SwExtendableEvent {
  waitUntil(p: Promise<unknown>): void;
}
interface SwFetchEvent extends SwExtendableEvent {
  request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface SwGlobal {
  addEventListener(type: "install" | "activate", cb: (e: SwExtendableEvent) => void): void;
  addEventListener(type: "fetch", cb: (e: SwFetchEvent) => void): void;
  addEventListener(type: "message", cb: (e: { data: unknown }) => void): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<SwClient[]>;
  };
  registration: { scope: string };
  location: { origin: string };
}

const sw = self as unknown as SwGlobal;

/** App shell, relative to the registration scope (`/` locally, `/<repo>/` on Pages). */
const SHELL = ["", "index.html", "setup.html", "data/stops.json.gz", "data/meta.json"];

function scoped(path: string): string {
  return new URL(path, sw.registration.scope).toString();
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One miss (no table, no .gz on a dev server) must not fail the install.
      await Promise.all(
        SHELL.map(async (path) => {
          try {
            await cache.add(new Request(scoped(path), { cache: "reload" }));
          } catch {
            /* optional */
          }
        }),
      );
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("xsbt-") && name !== CACHE && name !== TABLE_CACHE) {
          await caches.delete(name);
        }
      }
      await sw.clients.claim();
      // XCTrack keeps the widget open for hours, so nothing would otherwise make
      // the running page pick up the new shell. main.ts reloads once on this.
      const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: "xsbt-updated", buildId: BUILD_ID });
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  switch (strategyFor(url, req.mode, sw.location.origin)) {
    case "passthrough":
      return;
    case "network-first":
      event.respondWith(networkFirst(req));
      return;
    case "table":
      event.respondWith(tableFirst(req));
      return;
    case "cache-first":
      event.respondWith(cacheFirst(req));
      return;
  }
});

/** Documents: always try the network, so a deploy is picked up on the next load. */
async function networkFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const shell = await cache.match(scoped("index.html"));
    if (shell) return shell;
    throw err;
  }
}

/** Cache-first with a background fill; navigations fall back to the cached shell. */
async function cacheFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") await cache.put(req, res.clone());
  return res;
}

/** Per-home table: serve from cache, refetch in the background once a week. */
async function tableFirst(req: Request): Promise<Response> {
  const cache = await caches.open(TABLE_CACHE);
  const hit = await cache.match(req);
  if (hit) {
    const at = Number(hit.headers.get(CACHED_AT) ?? 0);
    if (Date.now() - at > TABLE_MAX_AGE_MS) void revalidate(cache, req);
    return hit;
  }
  return revalidate(cache, req);
}

async function revalidate(cache: Cache, req: Request): Promise<Response> {
  const res = await fetch(req);
  if (!res.ok) return res;
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.set(CACHED_AT, String(Date.now()));
  await cache.put(req, new Response(body, { status: res.status, headers }));
  return new Response(body, { status: res.status, headers });
}
