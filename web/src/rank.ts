// Picking the stops the widget shows: SAFEST, BEST, ALT. BEST is the stop that
// gets the pilot home earliest (or, in home-by mode, buys the most flying time),
// SAFEST the one needing the gentlest glide, ALT a genuinely different direction.
// In home-by mode the ranking works backwards from a target arrival time.

import type { Candidate, Journey, Mode, Pick, Role } from "./types";
import { angleDiffDeg } from "./geo";

/** Minimum bearing spread between BEST and ALT, in degrees. */
export const ALT_MIN_BEARING_DIFF_DEG = 60;
/** A home-by budget below this many minutes is shown as critical. */
export const BUDGET_CRITICAL_MIN = 15;

export interface RankInput {
  candidates: readonly Candidate[];
  mode: Mode;
  /** Safe glide-ratio threshold (`lsafe`). Kept for callers; roles rank on `lreq` directly. */
  lsafe: number;
  /** Packing + walking minutes, subtracted from the latest departure in home-by mode. */
  groundMin: number;
  /** Target arrival at home, epoch ms. Required for home-by mode. */
  homeByMs?: number | null;
  /** Live journeys per stop id, when routing has run. */
  journeys?: ReadonlyMap<number, Journey> | null;
  /** Stop ids the live API reported no service for; they cannot hold a role. */
  noService?: ReadonlySet<number> | null;
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
 * Rank candidates and return one to three picks, ordered SAFEST, BEST, ALT.
 *
 * BEST is the reachable stop arriving home earliest — from the live journey when
 * one has been fetched for it, otherwise from the estimate. SAFEST is the stop
 * with the lowest required glide ratio, and is dropped unless that ratio is
 * strictly lower than BEST's. ALT is the next-earliest arrival lying at least
 * 60 degrees away from BEST's bearing, and is dropped when it repeats SAFEST.
 *
 * Home-by mode ranks on the land-by deadline instead of the arrival: BEST is the
 * latest deadline (the most flying time left) among stops that can still make the
 * target. If no stop can, the ranking silently falls back to earliest mode and
 * reports `missedHomeBy`.
 */
export function rank(input: RankInput): RankResult {
  const now = input.now ?? Date.now();
  const eligible = input.candidates.filter((c) => !input.noService?.has(c.stop.id));

  if (input.mode === "homeBy" && input.homeByMs != null) {
    const feasible = eligible.filter((c) => {
      const budget = budgetOf(c, input, now);
      return budget !== null && budget >= 0;
    });
    if (feasible.length > 0) {
      const order = (c: Candidate) => -(landByOf(c, input) ?? Number.NEGATIVE_INFINITY);
      return {
        picks: pick(feasible, order, input, now),
        mode: "homeBy",
        missedHomeBy: false,
      };
    }
    return {
      picks: pick(eligible, arrivalKeyOf(input), input, null),
      mode: "earliest",
      missedHomeBy: true,
    };
  }
  return {
    picks: pick(eligible, arrivalKeyOf(input), input, null),
    mode: "earliest",
    missedHomeBy: false,
  };
}

/**
 * The three roles over one candidate set. `order` scores the mode's notion of a
 * good stop (lower is better): earliest arrival home, or latest land-by deadline.
 * `now` is null in earliest mode, where picks carry no deadline or budget.
 */
function pick(
  candidates: readonly Candidate[],
  order: (c: Candidate) => number,
  input: RankInput,
  now: number | null,
): Pick[] {
  if (candidates.length === 0) return [];

  // Lower score first, then the gentler glide.
  const byOrder = [...candidates].sort((a, b) => order(a) - order(b) || a.lreq - b.lreq);
  const best = byOrder[0]!;

  // Gentlest glide first, then the mode's own ordering.
  const safest = [...candidates].sort((a, b) => a.lreq - b.lreq || order(a) - order(b))[0]!;
  const keepSafest = safest.stop.id !== best.stop.id && safest.lreq < best.lreq;

  const alt =
    byOrder.find(
      (c) =>
        c.stop.id !== best.stop.id &&
        angleDiffDeg(c.bearing, best.bearing) >= ALT_MIN_BEARING_DIFF_DEG,
    ) ?? null;
  const keepAlt = alt !== null && !(keepSafest && alt.stop.id === safest.stop.id);

  const picks: Pick[] = [];
  if (keepSafest) picks.push(toPick(safest, "safest", input, now));
  picks.push(toPick(best, "best", input, now));
  if (keepAlt) picks.push(toPick(alt, "alt", input, now));
  return picks;
}

function toPick(cand: Candidate, role: Role, input: RankInput, now: number | null): Pick {
  return {
    role,
    cand,
    journey: input.journeys?.get(cand.stop.id) ?? null,
    landBy: now === null ? null : landByOf(cand, input),
    budgetMin: now === null ? null : budgetOf(cand, input, now),
  };
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

/** Arrival home: the live journey's when one has been fetched, else the estimate. */
function arrivalKeyOf(input: RankInput): (c: Candidate) => number {
  return (c) =>
    input.journeys?.get(c.stop.id)?.arr ?? c.arrivalEst ?? Number.POSITIVE_INFINITY;
}
