// Reachability and candidate construction: which stops the pilot can still glide
// to, and how early each one could get them home. Pure functions — no DOM, no
// network.

import type { Candidate, Config, Fix, IndexedStop, Stop } from "./types";
import { MODE_BUS, MODE_RAIL } from "./types";
import { bearingDeg, haversineM } from "./geo";
import { ceilToMinute } from "./time";
import type { StopIndex } from "./stops";

/** Minimum usable height above a stop, in metres. Below this it is not a glide. */
export const MIN_HEIGHT_M = 50;

/** Travel-time lookup backed by the per-home table; null means "no entry". */
export type TravelEstFn = (stopIdx: number, departureMs: number) => number | null;

export interface CandidateOptions {
  /** Home station, for the heuristic travel estimate. Null falls back to no estimate. */
  home?: Stop | null;
  /** Per-home table lookup; consulted before the heuristic. */
  travelEst?: TravelEstFn | null;
  /** Evaluation time, epoch ms. Defaults to Date.now(). */
  now?: number;
}

/** Required glide ratio to a stop `distM` away and `heightM` below. */
export function requiredGlide(distM: number, heightM: number): number {
  return heightM <= 0 ? Infinity : distM / heightM;
}

/** Usable height over a stop after the safety margin. */
export function heightOver(fix: Fix, stop: Stop, marginM: number): number {
  return fix.alt - stop.e - marginM;
}

/** True when the stop is within the configured maximum glide ratio. */
export function isReachable(fix: Fix, stop: Stop, cfg: Config): boolean {
  const h = heightOver(fix, stop, cfg.margin);
  if (h <= MIN_HEIGHT_M) return false;
  return requiredGlide(haversineM(fix.lat, fix.lon, stop.lat, stop.lon), h) <= cfg.lmax;
}

/**
 * Heuristic door-to-home travel time in minutes, used when no per-home table is
 * available: 50 km/h straight-line, a typical wait, and a penalty for stops that
 * are not on the rail network.
 */
export function heuristicTravelMin(stop: Stop, home: Stop): number {
  const km = haversineM(stop.lat, stop.lon, home.lat, home.lon) / 1000;
  const penalty = stop.m & MODE_RAIL ? 0 : stop.m & MODE_BUS ? 15 : 25;
  return km / 50 * 60 + 15 + penalty;
}

/**
 * Build a Candidate for one stop, or null if it is out of glide range.
 * `tFlyMin` is the glide time at trim speed; `earliestDep` adds packing and walking
 * and is rounded up to the next whole minute.
 */
export function buildCandidate(
  fix: Fix,
  stop: IndexedStop | Stop,
  cfg: Config,
  opts: CandidateOptions = {},
): Candidate | null {
  const h = heightOver(fix, stop, cfg.margin);
  if (h <= MIN_HEIGHT_M) return null;
  const distM = haversineM(fix.lat, fix.lon, stop.lat, stop.lon);
  const lreq = requiredGlide(distM, h);
  if (!(lreq <= cfg.lmax)) return null;

  const now = opts.now ?? Date.now();
  const tFlyMin = distM / 1000 / cfg.v * 60;
  const groundMs = (tFlyMin + cfg.pack + cfg.walk) * 60_000;
  const earliestDep = ceilToMinute(now + groundMs);

  // Candidate.stop keeps the indexed object as-is, so table lookups downstream can
  // still read its stopIdx.
  const stopIdx = "stopIdx" in stop ? stop.stopIdx : null;
  let travelEstMin: number | null = null;
  if (opts.travelEst && stopIdx !== null) {
    travelEstMin = opts.travelEst(stopIdx, earliestDep);
  }
  if (travelEstMin === null && opts.home) {
    travelEstMin = heuristicTravelMin(stop, opts.home);
  }

  return {
    stop,
    distM,
    bearing: bearingDeg(fix.lat, fix.lon, stop.lat, stop.lon),
    lreq,
    tFlyMin,
    earliestDep,
    travelEstMin,
    arrivalEst: travelEstMin === null ? null : earliestDep + travelEstMin * 60_000,
  };
}

/**
 * Every reachable stop around the fix, as candidates sorted by estimated arrival
 * (stops without an estimate go last, ordered by required glide).
 */
export function buildCandidates(
  fix: Fix,
  stops: StopIndex,
  cfg: Config,
  opts: CandidateOptions = {},
): Candidate[] {
  const reach = Math.max(0, fix.alt - cfg.margin) * cfg.lmax;
  const out: Candidate[] = [];
  if (reach <= 0) return out;
  for (const stop of stops.queryRadius(fix.lat, fix.lon, reach)) {
    const cand = buildCandidate(fix, stop, cfg, opts);
    if (cand) out.push(cand);
  }
  out.sort(compareByArrival);
  return out;
}

/** Earliest arrival first; candidates without an estimate sort last by glide ratio. */
export function compareByArrival(a: Candidate, b: Candidate): number {
  if (a.arrivalEst !== null && b.arrivalEst !== null) {
    return a.arrivalEst - b.arrivalEst || a.lreq - b.lreq;
  }
  if (a.arrivalEst !== null) return -1;
  if (b.arrivalEst !== null) return 1;
  return a.lreq - b.lreq;
}
