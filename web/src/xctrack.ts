// Location sources, in priority order: XCTrack's JS bridge, an IGC replay, the
// browser's geolocation, and finally the static ?lat=&lng= the XCTrack widget URL
// can substitute. Only one source is ever active.
//
// Inside XCTrack the bridge is the ONLY source: many pilots feed XCTrack from an
// external vario, and XCTrack's own track replay also comes through
// `XCTrack.getLocation()`. So as soon as `window.XCTrack` exists the widget waits
// for that bridge to produce a valid fix rather than reaching for the phone's own
// geolocation, which would report the wrong position or none at all.

import type { Config, Fix } from "./types";
import { bearingDeg, haversineM } from "./geo";

export type LocationSourceName = "xctrack" | "replay" | "geolocation" | "static" | "none";

/** Speed below which a GPS course is meaningless and the compass heading is used. */
export const TRACK_SPEED_THRESHOLD_KMH = 8;

/** Assumed altitude for the ?lat=&lng= fallback, which reports no altitude. */
export const STATIC_FALLBACK_ALT_M = 2000;

/** How much of a raw payload the ?debug=1 corner shows. */
export const RAW_DEBUG_CHARS = 120;

/** Epoch timestamps below this are seconds, not milliseconds (year 5138 in ms). */
const EPOCH_MS_FLOOR = 1e11;

interface XCTrackBridge {
  getLocation?: () => string | null;
}

interface XCTrackLocation {
  lat?: number;
  lon?: number;
  latitude?: number;
  longitude?: number;
  time?: number;
  altGps?: number | null;
  isValid?: boolean;
  stdBaroAlt?: number | null;
  pressure?: number | null;
  speedGps?: number | null;
  speedComputed?: number | null;
  bearingGps?: number | null;
  heading?: number | null;
  airspeed?: number | null;
}

export interface IgcFix {
  t: number;
  lat: number;
  lon: number;
  gpsAlt: number;
  baroAlt: number;
}

/** What `?debug=1` shows, so a pilot can diagnose the source on the phone. */
export interface LocationDebug {
  source: LocationSourceName;
  /** Last raw payload, truncated to RAW_DEBUG_CHARS. */
  raw: string | null;
  /** Valid fixes delivered so far. */
  fixes: number;
  /** Timestamp the payload itself reported, if any. Never used for staleness. */
  reportedT: number | null;
}

export interface LocationHooks {
  /** Which source won ('none' if the chosen one could produce nothing). */
  onSource?: (name: LocationSourceName) => void;
  /** Called on every poll, valid or not, when the caller wants diagnostics. */
  onDebug?: (info: LocationDebug) => void;
}

/**
 * Start feeding fixes to `onFix` at roughly 1 Hz from the single applicable
 * source. Returns a function that stops it.
 */
export function startLocationSource(
  cfg: Config,
  onFix: (fix: Fix) => void,
  hooks?: LocationHooks,
): () => void {
  if (hasXCTrack()) {
    hooks?.onSource?.("xctrack");
    return startXCTrack(onFix, hooks);
  }
  if (cfg.replay) {
    hooks?.onSource?.("replay");
    return startReplay(cfg, onFix, hooks);
  }
  if (typeof navigator !== "undefined" && navigator.geolocation) {
    hooks?.onSource?.("geolocation");
    return startGeolocation(cfg, onFix, () => hooks?.onSource?.("static"));
  }
  hooks?.onSource?.(startStatic(cfg, onFix) ? "static" : "none");
  return () => {};
}

/**
 * True whenever XCTrack injected its bridge, even if `getLocation` is missing or
 * still answering "null": inside XCTrack no other source is admissible.
 */
export function hasXCTrack(): boolean {
  const bridge = (globalThis as { XCTrack?: XCTrackBridge }).XCTrack;
  return typeof bridge === "object" && bridge !== null;
}

function startXCTrack(onFix: (fix: Fix) => void, hooks?: LocationHooks): () => void {
  let fixes = 0;
  let loggedFirst = false;
  const poll = (): void => {
    const bridge = (globalThis as { XCTrack?: XCTrackBridge }).XCTrack;
    let raw: unknown = null;
    try {
      raw = bridge?.getLocation?.() ?? null;
    } catch {
      raw = null;
    }
    const text = typeof raw === "string" ? raw : raw === null ? "null" : JSON.stringify(raw);
    if (!loggedFirst && raw !== null) {
      loggedFirst = true;
      console.log("[xsbt] first XCTrack.getLocation():", text);
    }
    const fix = parseXCTrackLocation(raw);
    if (fix) {
      fixes += 1;
      onFix(fix);
    }
    hooks?.onDebug?.({
      source: "xctrack",
      raw: text.slice(0, RAW_DEBUG_CHARS),
      fixes,
      reportedT: fix?.reportedT ?? null,
    });
  };
  poll();
  const timer = setInterval(poll, 1000);
  return () => clearInterval(timer);
}

/**
 * Turn one `XCTrack.getLocation()` payload into a Fix. The bridge hands back a
 * JSON string, an already-parsed object, the literal string "null", or null; an
 * invalid or incomplete fix yields null. Speeds are km/h per XCTrack's docs,
 * angles degrees true.
 *
 * The Fix is timestamped `receivedAt`, not with the payload's own `time`: under
 * XCTrack's track replay the payload reports the historical time of the recorded
 * fix, and using that would make every fix look 30 s stale on arrival. The
 * reported time is kept in `reportedT` for display only.
 */
export function parseXCTrackLocation(raw: unknown, receivedAt: number = Date.now()): Fix | null {
  const loc = asLocation(raw);
  if (!loc) return null;
  if (loc.isValid === false) return null; // a missing isValid counts as valid

  const lat = firstNumber(loc.lat, loc.latitude);
  const lon = firstNumber(loc.lon, loc.longitude);
  if (lat === null || lon === null) return null;

  // GPS altitude only; the barometer stands in when the GPS reports none.
  const alt = firstNumber(loc.altGps, loc.stdBaroAlt);
  if (alt === null) return null;

  const speedKmh = firstNumber(loc.speedGps, loc.speedComputed) ?? 0;
  const bearing = firstNumber(loc.bearingGps);
  const heading = firstNumber(loc.heading);
  const track = speedKmh > TRACK_SPEED_THRESHOLD_KMH ? (bearing ?? heading) : (heading ?? bearing);

  return {
    lat,
    lon,
    alt,
    speedKmh,
    track,
    t: receivedAt,
    reportedT: reportedTime(loc.time),
  };
}

function asLocation(raw: unknown): XCTrackLocation | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw as XCTrackLocation;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "" || text === "null") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as XCTrackLocation) : null;
  } catch {
    return null;
  }
}

/** The payload's own timestamp in epoch ms, accepting epoch seconds too. */
function reportedTime(time: unknown): number | null {
  const t = firstNumber(time as number | null | undefined);
  if (t === null || t <= 0) return null;
  return t < EPOCH_MS_FLOOR ? t * 1000 : t;
}

function startReplay(cfg: Config, onFix: (fix: Fix) => void, hooks?: LocationHooks): () => void {
  const url = cfg.replay;
  const speed = cfg.speed > 0 ? cfg.speed : 1;
  let timer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;
  let count = 0;

  if (url) {
    void fetch(url)
      .then((r) => r.text())
      .then((text) => {
        if (cancelled) return;
        const fixes = parseIGC(text);
        if (fixes.length === 0) return;
        const first = fixes[0]!;
        const last = fixes[fixes.length - 1]!;
        const span = Math.max(1000, last.t - first.t);
        const startedAt = Date.now();
        let idx = 0;
        const tick = (): void => {
          const elapsed = ((Date.now() - startedAt) * speed) % span;
          const virtual = first.t + elapsed;
          if (virtual < fixes[idx]!.t) idx = 0; // wrapped around, start the loop again
          while (idx + 1 < fixes.length && fixes[idx + 1]!.t <= virtual) idx += 1;
          const fix = igcToFix(fixes, idx);
          count += 1;
          onFix(fix);
          hooks?.onDebug?.({
            source: "replay",
            raw: `${url} fix ${idx + 1}/${fixes.length}`.slice(0, RAW_DEBUG_CHARS),
            fixes: count,
            reportedT: fix.reportedT ?? null,
          });
        };
        tick();
        timer = setInterval(tick, 1000);
      })
      .catch(() => {
        // Unreachable fixture: the caller keeps showing "waiting for GPS".
      });
  }

  return () => {
    cancelled = true;
    if (timer !== null) clearInterval(timer);
  };
}

/** Build a Fix from an IGC fix, taking speed and track from the preceding fix. */
export function igcToFix(fixes: readonly IgcFix[], idx: number): Fix {
  const cur = fixes[idx]!;
  const prev = idx > 0 ? fixes[idx - 1]! : null;
  let speedKmh = 0;
  let track: number | null = null;
  if (prev) {
    const dt = (cur.t - prev.t) / 1000;
    const d = haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
    if (dt > 0) speedKmh = (d / dt) * 3.6;
    if (d > 1) track = bearingDeg(prev.lat, prev.lon, cur.lat, cur.lon);
  }
  return {
    lat: cur.lat,
    lon: cur.lon,
    alt: cur.gpsAlt > 0 ? cur.gpsAlt : cur.baroAlt,
    speedKmh,
    track,
    t: Date.now(),
    reportedT: cur.t,
  };
}

/**
 * Parse the B records of an IGC file. Only valid ('A') fixes are kept.
 * Timestamps use the HFDTE date when present, otherwise today, and roll over at
 * midnight UTC.
 */
export function parseIGC(text: string): IgcFix[] {
  const lines = text.split(/\r?\n/);
  let base = startOfTodayUTC();
  for (const line of lines) {
    const m = /^HFDTE(?:DATE:)?(\d{2})(\d{2})(\d{2})/.exec(line);
    if (m) {
      base = Date.UTC(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      break;
    }
  }
  const out: IgcFix[] = [];
  let dayOffset = 0;
  let prevSecs = -1;
  for (const line of lines) {
    if (line.length < 35 || line[0] !== "B") continue;
    const hh = Number(line.slice(1, 3));
    const mm = Number(line.slice(3, 5));
    const ss = Number(line.slice(5, 7));
    if (!Number.isFinite(hh + mm + ss)) continue;
    const lat = dmToDeg(line.slice(7, 9), line.slice(9, 14), line[14]!, "N", "S");
    const lon = dmToDeg(line.slice(15, 18), line.slice(18, 23), line[23]!, "E", "W");
    if (lat === null || lon === null) continue;
    if (line[24] !== "A" && line[24] !== "V") continue;
    if (line[24] === "V") continue;
    const baroAlt = Number(line.slice(25, 30));
    const gpsAlt = Number(line.slice(30, 35));
    const secs = hh * 3600 + mm * 60 + ss;
    if (prevSecs >= 0 && secs < prevSecs) dayOffset += 86400;
    prevSecs = secs;
    out.push({
      t: base + (secs + dayOffset) * 1000,
      lat,
      lon,
      gpsAlt: Number.isFinite(gpsAlt) ? gpsAlt : 0,
      baroAlt: Number.isFinite(baroAlt) ? baroAlt : 0,
    });
  }
  return out;
}

function dmToDeg(
  degPart: string,
  minPart: string,
  hemi: string,
  positive: string,
  negative: string,
): number | null {
  const deg = Number(degPart);
  const min = Number(minPart);
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  if (hemi !== positive && hemi !== negative) return null;
  const value = deg + min / 1000 / 60; // IGC minutes carry three implied decimals
  return hemi === negative ? -value : value;
}

function startOfTodayUTC(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function startGeolocation(
  cfg: Config,
  onFix: (fix: Fix) => void,
  onFallback: () => void,
): () => void {
  let fellBack = false;
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      onFix({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        alt: pos.coords.altitude ?? 0,
        speedKmh: (pos.coords.speed ?? 0) * 3.6,
        track: pos.coords.heading ?? null,
        t: pos.timestamp,
      });
    },
    () => {
      // Permission denied or no signal: the URL may still carry a position.
      if (fellBack) return;
      fellBack = true;
      if (startStatic(cfg, onFix)) onFallback();
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10_000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/**
 * The ?lat=&lng= XCTrack can substitute into the widget URL. It carries no
 * altitude, so the fix claims a nominal one — without it every stop would come out
 * unreachable and the fallback would show nothing at all. Treat its glide numbers
 * as indicative only.
 */
function startStatic(_cfg: Config, onFix: (fix: Fix) => void): boolean {
  const pos = staticPosition();
  if (!pos) return false;
  onFix({
    lat: pos.lat,
    lon: pos.lon,
    alt: STATIC_FALLBACK_ALT_M,
    speedKmh: 0,
    track: null,
    t: Date.now(),
  });
  return true;
}

function staticPosition(): { lat: number; lon: number } | null {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.search);
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lng") ?? params.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    return null;
  }
  return { lat, lon };
}

function firstNumber(...values: readonly (number | null | undefined)[]): number | null {
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
