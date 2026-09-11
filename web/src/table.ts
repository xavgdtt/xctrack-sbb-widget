// Per-home travel-time table (phase 2): a small binary of median door-to-home
// travel times, indexed by day type, departure hour and stop index. It lets the
// widget rank stops with no network at all.
//
// The layout must stay in step with data/build_tables.py.

import { dayType } from "./time";

export const MAGIC = "XSBT";
export const VERSION = 1;
export const HEADER_BYTES = 32;
export const UNREACHABLE = 65535;
/** Width of the build-id field in the header; longer ids are compared truncated. */
export const BUILD_ID_BYTES = 16;

export interface TravelTable {
  homeId: number;
  buildId: string;
  stopCount: number;
  dayTypes: number;
  hourStart: number;
  hourCount: number;
  /** Median travel time in minutes, or null when the stop cannot reach home. */
  lookup(stopIdx: number, departureMs: number): number | null;
}

/**
 * Decode a table buffer. Returns null when the magic, version, or build id does not
 * match — a table built against a different stops.json would index the wrong stops,
 * so the caller must fall back to the heuristic instead.
 */
export function decodeTable(
  buffer: ArrayBuffer,
  expect: { buildId: string; homeId?: number },
): TravelTable | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== MAGIC) return null;
  if (view.getUint8(4) !== VERSION) return null;
  const dayTypes = view.getUint8(5);
  const hourStart = view.getUint8(6);
  const hourCount = view.getUint8(7);
  const stopCount = view.getUint32(8, true);
  const homeId = view.getUint32(12, true);
  // The header field holds only 16 bytes, so a longer meta.json build id is
  // compared on its first 16 characters. build_tables.py truncates the same way.
  const buildId = readAscii(new Uint8Array(buffer, 16, BUILD_ID_BYTES));
  if (buildId !== expect.buildId.slice(0, BUILD_ID_BYTES)) return null;
  if (expect.homeId !== undefined && homeId !== expect.homeId) return null;
  if (dayTypes < 1 || hourCount < 1 || stopCount < 1) return null;

  const cells = dayTypes * hourCount * stopCount;
  if (buffer.byteLength < HEADER_BYTES + cells * 2) return null;
  const minutes = new Uint16Array(buffer, HEADER_BYTES, cells);

  return {
    homeId,
    buildId,
    stopCount,
    dayTypes,
    hourStart,
    hourCount,
    lookup(stopIdx: number, departureMs: number): number | null {
      if (!Number.isInteger(stopIdx) || stopIdx < 0 || stopIdx >= stopCount) return null;
      const dt = Math.min(dayType(departureMs), dayTypes - 1);
      const hour = new Date(departureMs).getHours();
      const hourIdx = clamp(hour - hourStart, 0, hourCount - 1);
      const value = minutes[(dt * hourCount + hourIdx) * stopCount + stopIdx];
      return value === undefined || value === UNREACHABLE ? null : value;
    },
  };
}

/**
 * Fetch `tables/<homeId>.bin` and validate it against `meta.json`'s build id.
 * Returns null when the table is missing, stale, or malformed.
 */
export async function loadTable(
  homeId: number,
  baseUrl: string = defaultBase(),
): Promise<TravelTable | null> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  try {
    const buildId = await loadBuildId(base);
    if (!buildId) return null;
    const res = await fetch(`${base}data/tables/${homeId}.bin`);
    if (!res.ok) return null;
    return decodeTable(await res.arrayBuffer(), { buildId, homeId });
  } catch {
    return null;
  }
}

/** The dataset build id from meta.json, or null if it cannot be read. */
export async function loadBuildId(baseUrl: string = defaultBase()): Promise<string | null> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  try {
    const res = await fetch(`${base}data/meta.json`);
    if (!res.ok) return null;
    const meta: unknown = await res.json();
    const buildId = (meta as { buildId?: unknown })?.buildId;
    return typeof buildId === "string" && buildId !== "" ? buildId : null;
  } catch {
    return null;
  }
}

function readAscii(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function defaultBase(): string {
  return import.meta.env?.BASE_URL ?? "/";
}
