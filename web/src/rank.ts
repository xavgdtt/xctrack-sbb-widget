// Picking the three stops the widget shows: SAFEST, BEST, NEAREST, with a
// diversity rule so the pilot is not offered the same field three times.
// In home-by mode the ranking works backwards from a target arrival time.

import type { Candidate, Journey, Mode, Pick, Role } from "./types";
import { angleDiffDeg } from "./geo";

/** Bearing spread below which two candidates count as the same direction. */
export const DIVERSITY_ANGLE_DEG = 45;
/** Distance below which two candidates in the same direction count as the same spot. */
export const DIVERSITY_DIST_M = 3000;
/** A home-by budget below this many minutes is shown as critical. */
export const BUDGET_CRITICAL_MIN = 15;

export interface RankInput {
  candidates: readonly Candidate[];
  mode: Mode;
  /** Safe glide-ratio threshold (`lsafe`). */
  lsafe: number;
  /** Packing + walking minutes, subtracted from the latest departure in home-by mode. */
  groundMin: number;
  /** Target arrival at home, epoch ms. Required for home-by mode. */
  homeByMs?: number | null;
  /** Live journeys per stop id, when routing has run. */
  journeys?: ReadonlyMap<number, Journey> | null;
  /** Evaluation time, epoch ms. */
  now?: number;
}

export interface RankResult {
  picks: Pick[];
  /** The mode actually used — 'earliest' when home-by had no feasible stop. */
  mode: Mode;
  /** True when home-by was requested but nothing could make the target. */
  missedHomeBy: boolean;
}

/**
 * Rank candidates and return up to three picks.
 *
 * Earliest mode: SAFEST is the earliest arrival among stops within `lsafe` (or the
 * lowest required glide overall if none qualifies), BEST the earliest arrival of
 * what is left, NEAREST the closest of what is left.
 *
 * Home-by mode: each stop gets a land-by deadline and a time budget from the latest
 * connection arriving by the target; stops with a negative budget drop out and BEST
 * becomes the stop with the most flying time left. If no stop can make the target
 * the ranking silently falls back to earliest mode and reports `missedHomeBy`.
 */
export function rank(input: RankInput): RankResult {
  const now = input.now ?? Date.now();
  if (input.mode === "homeBy" && input.homeByMs != null) {
    const feasible = input.candidates.filter(
      (c) => budgetOf(c, input, now) !== null && budgetOf(c, input, now)! >= 0,
    );
    if (feasible.length > 0) {
      return { picks: pickHomeBy(feasible, input, now), mode: "homeBy", missedHomeBy: false };
    }
    return {
      picks: pickEarliest(input.candidates, input),
      mode: "earliest",
      missedHomeBy: true,
    };
  }
  return { picks: pickEarliest(input.candidates, input), mode: "earliest", missedHomeBy: false };
}

function pickEarliest(candidates: readonly Candidate[], input: RankInput): Pick[] {
  if (candidates.length === 0) return [];
  const remaining = [...candidates];
  const picks: Pick[] = [];

  const safe = remaining.filter((c) => c.lreq <= input.lsafe);
  const safest =
    safe.length > 0
      ? minBy(safe, arrivalKey)
      : minBy(remaining, (c) => c.lreq);
  take(picks, remaining, safest, "safest", input, null);

  const best = choose(remaining, picks, arrivalKey);
  take(picks, remaining, best, "best", input, null);

  const nearest = choose(remaining, picks, (c) => c.distM);
  take(picks, remaining, nearest, "nearest", input, null);

  return picks;
}

function pickHomeBy(candidates: readonly Candidate[], input: RankInput, now: number): Pick[] {
  const remaining = [...candidates];
  const picks: Pick[] = [];
  const budgets = new Map<Candidate, number>();
  for (const c of remaining) budgets.set(c, budgetOf(c, input, now) ?? 0);

  const safe = remaining.filter((c) => c.lreq <= input.lsafe);
  const safest =
    safe.length > 0 ? minBy(safe, arrivalKey) : minBy(remaining, (c) => c.lreq);
  take(picks, remaining, safest, "safest", input, now);

  // Best in home-by mode is the latest deadline, i.e. the most flying time left.
  const best = choose(remaining, picks, (c) => -(budgets.get(c) ?? 0));
  take(picks, remaining, best, "best", input, now);

  const nearest = choose(remaining, picks, (c) => c.distM);
  take(picks, remaining, nearest, "nearest", input, now);

  return picks;
}

/**
 * Lowest-scoring candidate that is not already picked and is not a near-duplicate
 * of one (same direction within 45 degrees and within 3 km).
 */
function choose(
  remaining: readonly Candidate[],
  picks: readonly Pick[],
  score: (c: Candidate) => number,
): Candidate | null {
  const ordered = [...remaining].sort((a, b) => score(a) - score(b));
  for (const cand of ordered) {
    if (!picks.some((p) => isDuplicate(cand, p.cand))) return cand;
  }
  return null;
}

/** Two candidates are duplicates when they lie in the same direction and close together. */
export function isDuplicate(a: Candidate, b: Candidate): boolean {
  if (angleDiffDeg(a.bearing, b.bearing) > DIVERSITY_ANGLE_DEG) return false;
  return distanceBetween(a, b) < DIVERSITY_DIST_M;
}

/** Planar distance between two candidate stops, in metres (they are always close). */
function distanceBetween(a: Candidate, b: Candidate): number {
  const dLat = (a.stop.lat - b.stop.lat) * 111_320;
  const dLon =
    (a.stop.lon - b.stop.lon) * 111_320 * Math.cos(((a.stop.lat + b.stop.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function take(
  picks: Pick[],
  remaining: Candidate[],
  cand: Candidate | null,
  role: Role,
  input: RankInput,
  now: number | null,
): void {
  if (!cand) return;
  const idx = remaining.indexOf(cand);
  if (idx >= 0) remaining.splice(idx, 1);
  const journey = input.journeys?.get(cand.stop.id) ?? null;
  const landBy = now === null ? null : landByOf(cand, input);
  picks.push({
    role,
    cand,
    journey,
    landBy,
    budgetMin: now === null ? null : budgetOf(cand, input, now),
  });
}

/**
 * Latest moment the pilot can be on the ground and still catch a connection home
 * by the target: the latest departure minus packing and walking. Null when there is
 * no such connection.
 */
export function landByOf(cand: Candidate, input: RankInput): number | null {
  const dep = latestDepartureOf(cand, input);
  return dep === null ? null : dep - input.groundMin * 60_000;
}

/** Minutes of flying left before the pilot must land for this stop. */
export function budgetOf(cand: Candidate, input: RankInput, now: number): number | null {
  const landBy = landByOf(cand, input);
  if (landBy === null) return null;
  return (landBy - now) / 60_000 - cand.tFlyMin;
}

/**
 * The departure this stop is ranked on in home-by mode: the live journey's when
 * routing has run, otherwise the estimated one derived from the target arrival and
 * the estimated travel time.
 */
function latestDepartureOf(cand: Candidate, input: RankInput): number | null {
  const journey = input.journeys?.get(cand.stop.id);
  if (journey && input.homeByMs != null && journey.arr <= input.homeByMs) return journey.dep;
  if (input.homeByMs == null || cand.travelEstMin === null) return null;
  return input.homeByMs - cand.travelEstMin * 60_000;
}

function arrivalKey(c: Candidate): number {
  return c.arrivalEst ?? Number.POSITIVE_INFINITY;
}

function minBy<T>(items: readonly T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const s = score(item);
    if (s < bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return best;
}

