// Service worker. Built by Vite as a separate entry emitted at the site root as
// `sw.js` (see vite.config.ts), with `__BUILD_ID__` replaced at build time so a
// new dataset build invalidates the whole cache.
//
// Strategy:
//   same-origin app shell + data  -> cache-first, filled on install and on use
//   data/tables/*.bin[.gz]        -> cache-first, revalidated once a week
//   transport.opendata.ch         -> not intercepted; the app layer owns offline

export {};

declare const __BUILD_ID__: string;

const CACHE = `xsbt-${__BUILD_ID__}`;
const TABLE_MAX_AGE_MS = 7 * 24 * 3600_000;
const CACHED_AT = "x-xsbt-cached-at";

/* Minimal service-worker typings. The project's tsconfig loads lib.dom, and
   pulling in lib.webworker alongside it collides, so declare just what is used. */
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
  clients: { claim(): Promise<void> };
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
        if (name.startsWith("xsbt-") && name !== CACHE) await caches.delete(name);
      }
      await sw.clients.claim();
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
  // transport.opendata.ch and anything else cross-origin: network only.
  if (url.origin !== sw.location.origin) return;
  // Tables ship gzipped; .bin is the fallback build_tables.py --also-plain emits.
  if (
    url.pathname.includes("/data/tables/") &&
    (url.pathname.endsWith(".bin") || url.pathname.endsWith(".bin.gz"))
  ) {
    event.respondWith(tableFirst(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

/** Cache-first with a background fill; navigations fall back to the cached shell. */
async function cacheFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") await cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (req.mode === "navigate") {
      const shell = await cache.match(scoped("index.html"));
      if (shell) return shell;
    }
    throw err;
  }
}

/** Per-home table: serve from cache, refetch in the background once a week. */
async function tableFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
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
