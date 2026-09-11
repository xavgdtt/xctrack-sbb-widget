// transport.opendata.ch client: live connections from a candidate stop to the home
// station, with a short cache, a polite throttle, and last-good results so a lost
// network downgrades to stale data instead of blank cells.
//
// No custom request headers anywhere: they would trigger a CORS preflight the API
// does not answer.

import type { Journey } from "./types";
import { formatDate, formatHHMM } from "./time";

export const API_BASE = "https://transport.opendata.ch/v1";
/** Cache keys round the departure time to this many minutes. */
export const CACHE_ROUND_MIN = 5;
/** How long a cached connection stays usable. */
export const CACHE_TTL_MS = 10 * 60_000;
/** Requests in flight at once. */
export const MAX_CONCURRENT = 2;
/** Minimum spacing between request starts. */
export const MIN_SPACING_MS = 400;
/** Pause after a 429 before trying the API again. */
export const BACKOFF_MS = 30_000;

export interface RouteRequest {
  stopId: number;
  /** Departure time, or the target arrival time in arrival mode. Epoch ms. */
  when: number;
}

export interface RouteOutcome {
  /** Best journey found, or the last good one when the fetch failed. */
  journey: Journey | null;
  /** The API answered with an empty connection list: no service from this stop. */
  noService: boolean;
  /** The fetch failed or was skipped because of backoff. */
  error: boolean;
}

export interface TransportOptions {
  homeId: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Sleep hook; exists so tests can run the throttle without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TransportClient {
  /** Route a batch of stops. Arrival mode looks for the latest arrival by `when`. */
  route(
    requests: readonly RouteRequest[],
    opts?: { arrival?: boolean },
  ): Promise<Map<number, RouteOutcome>>;
  /** Last successful journey for a stop, possibly stale. */
  lastGood(stopId: number): Journey | null;
  /** Last successful journey per stop, for rendering while offline. */
  allLastGood(): Map<number, Journey>;
  /** True when the most recent cycle could not reach the API. */
  isStale(): boolean;
  /** Epoch ms until which requests are suppressed after a 429. */
  backoffUntil(): number;
}

/** Round a timestamp up to the next 5-minute boundary (the cache-key granularity). */
export function roundUpTo5Min(ms: number): number {
  const step = CACHE_ROUND_MIN * 60_000;
  return Math.ceil(ms / step) * step;
}

/** Cache key for one (stop, home, time bucket, direction) lookup. */
export function cacheKey(
  stopId: number,
  homeId: number,
  whenMs: number,
  arrival = false,
): string {
  return `${stopId}|${homeId}|${roundUpTo5Min(whenMs)}|${arrival ? "a" : "d"}`;
}

export function createTransportClient(opts: TransportOptions): TransportClient {
  const base = opts.baseUrl ?? API_BASE;
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const cache = new Map<string, { journey: Journey | null; at: number }>();
  const lastGood = new Map<number, Journey>();
  let backoffUntil = 0;
  let stale = false;
  let lastStart = 0;
  let inFlight = 0;
  const waiters: (() => void)[] = [];

  async function acquire(): Promise<void> {
    while (inFlight >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    inFlight += 1;
    const wait = lastStart + MIN_SPACING_MS - now();
    if (wait > 0) await sleep(wait);
    lastStart = now();
  }

  function release(): void {
    inFlight -= 1;
    waiters.shift()?.();
  }

  async function one(req: RouteRequest, arrival: boolean): Promise<RouteOutcome> {
    const key = cacheKey(req.stopId, opts.homeId, req.when, arrival);
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) {
      return { journey: hit.journey, noService: hit.journey === null, error: false };
    }
    if (now() < backoffUntil) {
      return { journey: staleCopy(lastGood.get(req.stopId)), noService: false, error: true };
    }
    await acquire();
    try {
      const url = connectionsUrl(base, req.stopId, opts.homeId, req.when, arrival);
      const res = await doFetch(url);
      if (res.status === 429) {
        backoffUntil = now() + BACKOFF_MS;
        stale = true;
        return { journey: staleCopy(lastGood.get(req.stopId)), noService: false, error: true };
      }
      if (!res.ok) throw new Error(`connections: HTTP ${res.status}`);
      const body: unknown = await res.json();
      const journey = pickJourney(body, req.when, arrival, now());
      cache.set(key, { journey, at: now() });
      if (journey) lastGood.set(req.stopId, journey);
      return { journey, noService: journey === null, error: false };
    } catch {
      stale = true;
      return { journey: staleCopy(lastGood.get(req.stopId)), noService: false, error: true };
    } finally {
      release();
    }
  }

  return {
    async route(requests, routeOpts) {
      const arrival = routeOpts?.arrival ?? false;
      stale = false;
      const out = new Map<number, RouteOutcome>();
      const results = await Promise.all(requests.map((req) => one(req, arrival)));
      requests.forEach((req, i) => out.set(req.stopId, results[i]!));
      return out;
    },
    lastGood: (stopId) => lastGood.get(stopId) ?? null,
    allLastGood: () => new Map(lastGood),
    isStale: () => stale,
    backoffUntil: () => backoffUntil,
  };
}

/** Build a /v1/connections URL. Arrival mode asks for connections arriving by `when`. */
export function connectionsUrl(
  base: string,
  stopId: number,
  homeId: number,
  whenMs: number,
  arrival: boolean,
): string {
  const params = new URLSearchParams();
  params.set("from", String(stopId));
  params.set("to", String(homeId));
  params.set("date", formatDate(whenMs));
  params.set("time", formatHHMM(whenMs));
  params.set("limit", arrival ? "4" : "2");
  if (arrival) params.set("isArrivalTime", "1");
  for (const field of [
    "connections/from/departure",
    "connections/to/arrival",
    "connections/transfers",
    "connections/sections/journey/category",
  ]) {
    params.append("fields[]", field);
  }
  return `${base}/connections?${params.toString()}`;
}

/**
 * Best journey from a /v1/connections body: the first departure at or after `when`
 * normally, or in arrival mode the latest departure that still arrives by `when`.
 * Returns null when the API reports no connections at all — that stop has no service.
 */
export function pickJourney(
  body: unknown,
  whenMs: number,
  arrival: boolean,
  fetchedAt: number,
): Journey | null {
  const raw = (body as { connections?: unknown })?.connections;
  if (!Array.isArray(raw)) return null;
  const journeys: Journey[] = [];
  for (const item of raw) {
    const j = toJourney(item, fetchedAt);
    if (j) journeys.push(j);
  }
  if (journeys.length === 0) return null;
  if (arrival) {
    const feasible = journeys.filter((j) => j.arr <= whenMs);
    if (feasible.length === 0) return null;
    return feasible.reduce((a, b) => (b.dep > a.dep ? b : a));
  }
  const usable = journeys.filter((j) => j.dep >= whenMs);
  return (usable[0] ?? journeys[0])!;
}

function toJourney(item: unknown, fetchedAt: number): Journey | null {
  const c = item as {
    from?: { departure?: string };
    to?: { arrival?: string };
    transfers?: number;
    sections?: readonly { journey?: { category?: string } | null }[];
  } | null;
  const dep = Date.parse(c?.from?.departure ?? "");
  const arr = Date.parse(c?.to?.arrival ?? "");
  if (!Number.isFinite(dep) || !Number.isFinite(arr)) return null;
  const categories: string[] = [];
  for (const section of c?.sections ?? []) {
    const cat = section?.journey?.category;
    if (typeof cat === "string" && cat !== "" && !categories.includes(cat)) {
      categories.push(cat);
    }
  }
  return {
    dep,
    arr,
    transfers: typeof c?.transfers === "number" ? c.transfers : 0,
    categories,
    fetchedAt,
    stale: false,
  };
}

function staleCopy(journey: Journey | undefined): Journey | null {
  return journey ? { ...journey, stale: true } : null;
}

export interface StationHit {
  id: number;
  name: string;
  lat: number | null;
  lon: number | null;
}

/**
 * Station search for the setup page. `/v1/locations` mixes station hits with fuzzy
 * address matches that have a null id; those cannot be routed, so they are dropped.
 */
export async function searchStations(
  query: string,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<StationHit[]> {
  const base = opts.baseUrl ?? API_BASE;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const url = `${base}/locations?query=${encodeURIComponent(query)}&type=station`;
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`locations: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const stations = (body as { stations?: unknown })?.stations;
  if (!Array.isArray(stations)) return [];
  const out: StationHit[] = [];
  for (const item of stations as readonly {
    id?: string | number | null;
    name?: string | null;
    coordinate?: { x?: number | null; y?: number | null } | null;
  }[]) {
    const id = Number(item?.id);
    if (item?.id == null || !Number.isFinite(id) || id <= 0) continue;
    if (typeof item.name !== "string" || item.name === "") continue;
    out.push({
      id,
      name: item.name,
      lat: typeof item.coordinate?.x === "number" ? item.coordinate.x : null,
      lon: typeof item.coordinate?.y === "number" ? item.coordinate.y : null,
    });
  }
  return out;
}
