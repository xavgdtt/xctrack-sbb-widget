// Location sources, in priority order: XCTrack's JS bridge, an IGC replay, the
// browser's geolocation, and finally the static ?lat=&lng= the XCTrack widget URL
// can substitute. Only one source is ever active.

import type { Config, Fix } from "./types";
import { bearingDeg, haversineM } from "./geo";

export type LocationSourceName = "xctrack" | "replay" | "geolocation" | "static" | "none";

/** Speed below which a GPS course is meaningless and the compass heading is used. */
export const TRACK_SPEED_THRESHOLD_KMH = 8;

/** Assumed altitude for the ?lat=&lng= fallback, which reports no altitude. */
export const STATIC_FALLBACK_ALT_M = 2000;

interface XCTrackBridge {
  getLocation?: () => string | null;
}

interface XCTrackLocation {
  lat?: number;
  lon?: number;
  time?: number;
  altGps?: number;
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

/**
 * Start feeding fixes to `onFix` at roughly 1 Hz from the best available source.
 * `onSource` reports which source won (and 'none' if the chosen one produced
 * nothing). Returns a function that stops the source.
 */
export function startLocationSource(
  cfg: Config,
  onFix: (fix: Fix) => void,
  onSource?: (name: LocationSourceName) => void,
): () => void {
  if (hasXCTrack()) {
    onSource?.("xctrack");
    return startXCTrack(cfg, onFix);
  }
  if (cfg.replay) {
    onSource?.("replay");
    return startReplay(cfg, onFix);
  }
  if (typeof navigator !== "undefined" && navigator.geolocation) {
    onSource?.("geolocation");
    return startGeolocation(cfg, onFix, () => onSource?.("static"));
  }
  onSource?.(startStatic(cfg, onFix) ? "static" : "none");
  return () => {};
}

function hasXCTrack(): boolean {
  const bridge = (globalThis as { XCTrack?: XCTrackBridge }).XCTrack;
  return typeof bridge?.getLocation === "function";
}

function startXCTrack(cfg: Config, onFix: (fix: Fix) => void): () => void {
  const poll = (): void => {
    const bridge = (globalThis as { XCTrack?: XCTrackBridge }).XCTrack;
    let raw: string | null = null;
    try {
      raw = bridge?.getLocation?.() ?? null;
    } catch {
      return;
    }
    const fix = parseXCTrackLocation(raw, cfg);
    if (fix) onFix(fix);
  };
  poll();
  const timer = setInterval(poll, 1000);
  return () => clearInterval(timer);
}

/**
 * Turn one `XCTrack.getLocation()` payload into a Fix. The bridge hands back a
 * JSON string, the literal string "null", or null; an invalid or incomplete fix
 * yields null. Speeds are km/h, angles degrees true.
 */
export function parseXCTrackLocation(raw: string | null, cfg: Config): Fix | null {
  if (!raw || raw === "null") return null;
  let loc: XCTrackLocation;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    loc = parsed as XCTrackLocation;
  } catch {
    return null;
  }
  if (loc.isValid === false) return null;
  if (typeof loc.lat !== "number" || typeof loc.lon !== "number") return null;

  const baro = typeof loc.stdBaroAlt === "number" ? loc.stdBaroAlt : null;
  const gps = typeof loc.altGps === "number" ? loc.altGps : null;
  const useBaro = cfg.alt === "baro" && baro !== null;
  const alt = useBaro ? baro : (gps ?? baro);
  if (alt === null) return null;

  const speedKmh = firstNumber(loc.speedGps, loc.speedComputed) ?? 0;
  const bearing = typeof loc.bearingGps === "number" ? loc.bearingGps : null;
  const heading = typeof loc.heading === "number" ? loc.heading : null;
  const track = speedKmh > TRACK_SPEED_THRESHOLD_KMH ? (bearing ?? heading) : (heading ?? bearing);

  return {
    lat: loc.lat,
    lon: loc.lon,
    alt,
    altSource: useBaro ? "baro" : "gps",
    speedKmh,
    track,
    t: typeof loc.time === "number" && loc.time > 0 ? loc.time : Date.now(),
  };
}

function startReplay(cfg: Config, onFix: (fix: Fix) => void): () => void {
  const url = cfg.replay;
  const speed = cfg.speed > 0 ? cfg.speed : 1;
  let timer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

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
          onFix(igcToFix(fixes, idx, cfg));
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
export function igcToFix(fixes: readonly IgcFix[], idx: number, cfg: Config): Fix {
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
  const useBaro = cfg.alt === "baro" && cur.baroAlt > 0;
  return {
    lat: cur.lat,
    lon: cur.lon,
    alt: useBaro ? cur.baroAlt : cur.gpsAlt,
    altSource: useBaro ? "baro" : "gps",
    speedKmh,
    track,
    t: Date.now(),
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
        altSource: "gps",
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
    altSource: "gps",
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
