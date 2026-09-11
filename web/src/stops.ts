// The stop dataset: fetch and decompress stops.json.gz, then index it on a coarse
// lat/lon grid so the ranking loop can pull a bounding box out of 34k records
// without scanning them all.

import type { IndexedStop, Stop } from "./types";
import { bboxAround, type BBox } from "./geo";

/** Grid cell size in degrees. At Swiss latitudes a cell is ~11 x 7.6 km. */
export const CELL_DEG = 0.1;

export interface StopIndex {
  /** Every stop, in file order — `stopIdx` is the index the per-home table uses. */
  readonly all: readonly IndexedStop[];
  /** Stops whose coordinates fall inside the box. Unsorted. */
  queryBBox(box: BBox): IndexedStop[];
  /** Stops within `radiusM` of a point, by bounding box only (no exact distance). */
  queryRadius(lat: number, lon: number, radiusM: number): IndexedStop[];
  byId(id: number): IndexedStop | undefined;
}

/** Index an already-decoded stop array. */
export function buildIndex(stops: readonly Stop[]): StopIndex {
  const all: IndexedStop[] = stops.map((s, stopIdx) => ({ ...s, stopIdx }));
  const cells = new Map<number, IndexedStop[]>();
  const byId = new Map<number, IndexedStop>();
  for (const stop of all) {
    byId.set(stop.id, stop);
    const key = cellKey(cellOf(stop.lat), cellOf(stop.lon));
    const bucket = cells.get(key);
    if (bucket) bucket.push(stop);
    else cells.set(key, [stop]);
  }
  return {
    all,
    queryBBox(box: BBox): IndexedStop[] {
      const out: IndexedStop[] = [];
      const latFrom = cellOf(box.minLat);
      const latTo = cellOf(box.maxLat);
      const lonFrom = cellOf(box.minLon);
      const lonTo = cellOf(box.maxLon);
      for (let la = latFrom; la <= latTo; la += 1) {
        for (let lo = lonFrom; lo <= lonTo; lo += 1) {
          const bucket = cells.get(cellKey(la, lo));
          if (!bucket) continue;
          for (const stop of bucket) {
            if (
              stop.lat >= box.minLat &&
              stop.lat <= box.maxLat &&
              stop.lon >= box.minLon &&
              stop.lon <= box.maxLon
            ) {
              out.push(stop);
            }
          }
        }
      }
      return out;
    },
    queryRadius(lat: number, lon: number, radiusM: number): IndexedStop[] {
      return this.queryBBox(bboxAround(lat, lon, radiusM));
    },
    byId: (id: number) => byId.get(id),
  };
}

/**
 * Load `data/stops.json.gz`, decompressing in the browser because GitHub Pages
 * serves `.gz` without a `Content-Encoding` header. Falls back to the plain
 * `data/stops.json` when `DecompressionStream` is missing (the build must emit
 * both files — see the README).
 */
export async function loadStops(baseUrl: string = defaultBase()): Promise<StopIndex> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const stops = await fetchStops(`${base}data/stops.json.gz`, `${base}data/stops.json`);
  return buildIndex(stops);
}

async function fetchStops(gzUrl: string, plainUrl: string): Promise<Stop[]> {
  if (typeof DecompressionStream !== "undefined") {
    try {
      const res = await fetch(gzUrl);
      if (!res.ok || !res.body) throw new Error(`stops.json.gz: HTTP ${res.status}`);
      const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
      return asStops(await new Response(stream).json());
    } catch {
      // Fall through to the uncompressed copy.
    }
  }
  const res = await fetch(plainUrl);
  if (!res.ok) throw new Error(`stops.json: HTTP ${res.status}`);
  return asStops(await res.json());
}

function asStops(raw: unknown): Stop[] {
  if (!Array.isArray(raw)) throw new Error("stops: expected an array");
  const out: Stop[] = [];
  for (const item of raw as readonly Record<string, unknown>[]) {
    if (
      typeof item?.["id"] === "number" &&
      typeof item["n"] === "string" &&
      typeof item["lat"] === "number" &&
      typeof item["lon"] === "number"
    ) {
      out.push({
        id: item["id"],
        n: item["n"],
        lat: item["lat"],
        lon: item["lon"],
        e: typeof item["e"] === "number" ? item["e"] : 0,
        m: typeof item["m"] === "number" ? item["m"] : 0,
      });
    }
  }
  return out;
}

function cellOf(deg: number): number {
  return Math.floor(deg / CELL_DEG);
}

function cellKey(latCell: number, lonCell: number): number {
  // Both cell indices fit well inside +-2000 for Switzerland; the offset keeps the
  // key positive and collision-free for anything on Earth.
  return (latCell + 1800) * 4000 + (lonCell + 1800);
}

function defaultBase(): string {
  return import.meta.env?.BASE_URL ?? "/";
}
