import { describe, expect, it } from "vitest";
import { ALT_MIN_BEARING_DIFF_DEG, rank } from "../src/rank";
import type { Candidate, Journey } from "../src/types";

const NOW = new Date(2026, 4, 16, 15, 0, 0).getTime();
const ORIGIN = { lat: 46.7, lon: 7.9 };

interface Spec {
  id: number;
  bearing: number;
  distM: number;
  lreq: number;
  /** Minutes from now to the estimated arrival at home. */
  arrivalMin?: number;
  /** Estimated door-to-home travel time; set it directly when the deadline is what matters. */
  travelMin?: number;
}

function cand(spec: Spec): Candidate {
  const rad = (spec.bearing * Math.PI) / 180;
  const lat = ORIGIN.lat + (spec.distM * Math.cos(rad)) / 111_320;
  const lon =
    ORIGIN.lon +
    (spec.distM * Math.sin(rad)) / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
  const tFlyMin = spec.distM / 1000 / 34 * 60;
  const earliestDep = NOW + (tFlyMin + 15) * 60_000;
  const arrivalEst =
    spec.travelMin !== undefined
      ? earliestDep + spec.travelMin * 60_000
      : NOW + (spec.arrivalMin ?? 0) * 60_000;
  return {
    stop: { id: spec.id, n: `stop ${spec.id}`, lat, lon, e: 600, m: 1 },
    distM: spec.distM,
    bearing: spec.bearing,
    lreq: spec.lreq,
    tFlyMin,
    earliestDep,
    travelEstMin: (arrivalEst - earliestDep) / 60_000,
    arrivalEst,
  };
}

function journey(over: Partial<Journey> = {}): Journey {
  return {
    dep: NOW + 30 * 60_000,
    arr: NOW + 90 * 60_000,
    transfers: 1,
    categories: ["B", "IC"],
    fetchedAt: NOW,
    stale: false,
    ...over,
  };
}

const base = { lsafe: 6, groundMin: 15, now: NOW } as const;

const roles = (res: { picks: { role: string; cand: Candidate }[] }) =>
  res.picks.map((p) => [p.role, p.cand.stop.id]);

describe("rank in earliest mode", () => {
  it("returns safest, best and alt in that order", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 90 }), // gentlest glide
      cand({ id: 2, bearing: 120, distM: 12_000, lreq: 11, arrivalMin: 60 }), // earliest home
      cand({ id: 3, bearing: 240, distM: 9000, lreq: 9, arrivalMin: 75 }), // other direction
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(res.mode).toBe("earliest");
    expect(res.missedHomeBy).toBe(false);
    expect(roles(res)).toEqual([
      ["safest", 1],
      ["best", 2],
      ["alt", 3],
    ]);
    expect(res.picks.every((p) => p.landBy === null && p.budgetMin === null)).toBe(true);
  });

  it("ranks best on the live journey's arrival rather than the estimate", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 4000, lreq: 8, arrivalMin: 60 }),
      cand({ id: 2, bearing: 180, distM: 9000, lreq: 9, arrivalMin: 100 }),
    ];
    // Stop 1's live connection is much worse than its estimate; stop 2's is better.
    const journeys = new Map([
      [1, journey({ arr: NOW + 140 * 60_000 })],
      [2, journey({ arr: NOW + 80 * 60_000 })],
    ]);
    const res = rank({ candidates, mode: "earliest", journeys, ...base });
    const best = res.picks.find((p) => p.role === "best")!;
    expect(best.cand.stop.id).toBe(2);
    expect(best.journey).toBe(journeys.get(2));
  });

  it("breaks an arrival tie on the gentler glide", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 9000, lreq: 9, arrivalMin: 90 }),
      cand({ id: 2, bearing: 10, distM: 8000, lreq: 7, arrivalMin: 90 }),
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(res.picks.find((p) => p.role === "best")!.cand.stop.id).toBe(2);
  });

  it("drops safest when it is the same stop as best", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 60 }), // both roles
      cand({ id: 2, bearing: 180, distM: 9000, lreq: 9, arrivalMin: 120 }),
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(roles(res)).toEqual([
      ["best", 1],
      ["alt", 2],
    ]);
  });

  it("drops safest when its glide is not strictly gentler than best's", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 8000, lreq: 7, arrivalMin: 60 }), // best
      cand({ id: 2, bearing: 180, distM: 9000, lreq: 7, arrivalMin: 120 }), // same lreq
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(roles(res)).toEqual([
      ["best", 1],
      ["alt", 2],
    ]);
  });

  it("skips an alt candidate less than 60 degrees from best", () => {
    const candidates = [
      cand({ id: 1, bearing: 90, distM: 8000, lreq: 8, arrivalMin: 60 }), // best
      cand({ id: 2, bearing: 130, distM: 8000, lreq: 8.5, arrivalMin: 70 }), // only 40 deg away
      cand({ id: 3, bearing: 200, distM: 9000, lreq: 9, arrivalMin: 80 }), // 110 deg away
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(res.picks.find((p) => p.role === "alt")!.cand.stop.id).toBe(3);
  });

  it("measures the alt bearing spread across 0/360", () => {
    const candidates = [
      cand({ id: 1, bearing: 350, distM: 8000, lreq: 8, arrivalMin: 60 }), // best
      cand({ id: 2, bearing: 20, distM: 8000, lreq: 8.5, arrivalMin: 70 }), // 30 deg away
      cand({ id: 3, bearing: 290, distM: 9000, lreq: 9, arrivalMin: 80 }), // 60 deg away
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(ALT_MIN_BEARING_DIFF_DEG).toBe(60);
    expect(res.picks.find((p) => p.role === "alt")!.cand.stop.id).toBe(3);
  });

  it("shows no alt when every other stop lies in best's direction", () => {
    const candidates = [
      cand({ id: 1, bearing: 90, distM: 8000, lreq: 8, arrivalMin: 60 }),
      cand({ id: 2, bearing: 110, distM: 4000, lreq: 4, arrivalMin: 120 }),
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(roles(res)).toEqual([
      ["safest", 2],
      ["best", 1],
    ]);
  });

  it("keeps safest rather than repeating it as alt", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 9000, lreq: 9, arrivalMin: 60 }), // best
      cand({ id: 2, bearing: 180, distM: 4000, lreq: 4, arrivalMin: 90 }), // safest and the alt candidate
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(roles(res)).toEqual([
      ["safest", 2],
      ["best", 1],
    ]);
  });

  it("excludes a stop the live API reported no service for", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 8000, lreq: 8, arrivalMin: 60 }), // no service
      cand({ id: 2, bearing: 180, distM: 9000, lreq: 9, arrivalMin: 100 }),
    ];
    const res = rank({
      candidates,
      mode: "earliest",
      noService: new Set([1]),
      ...base,
    });
    expect(roles(res)).toEqual([["best", 2]]);
  });

  it("shows one cell rather than repeating a stop", () => {
    const res = rank({
      candidates: [cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 90 })],
      mode: "earliest",
      ...base,
    });
    expect(roles(res)).toEqual([["best", 1]]);
  });

  it("returns nothing when no stop is reachable", () => {
    const res = rank({ candidates: [], mode: "earliest", ...base });
    expect(res.picks).toEqual([]);
    expect(res.missedHomeBy).toBe(false);
  });
});

describe("rank in home-by mode", () => {
  const homeByMs = NOW + 180 * 60_000; // three hours from now

  it("reports a land-by deadline and the remaining flying budget", () => {
    const candidates = [cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 90 })];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    expect(res.mode).toBe("homeBy");
    expect(res.missedHomeBy).toBe(false);
    const pick = res.picks[0]!;
    // travelEst is ~75 min, so the latest departure is ~105 min from now and the
    // land-by deadline 15 min (pack + walk) earlier.
    const travel = pick.cand.travelEstMin!;
    expect(pick.landBy).toBe(homeByMs - travel * 60_000 - 15 * 60_000);
    expect(pick.budgetMin).toBeCloseTo((pick.landBy! - NOW) / 60_000 - pick.cand.tFlyMin, 6);
  });

  it("ranks best by the latest deadline, not the earliest arrival", () => {
    const candidates = [
      // Stop 1 is a short glide away and so arrives home first, but its slower
      // journey means the pilot must land for it sooner.
      cand({ id: 1, bearing: 0, distM: 1000, lreq: 4, travelMin: 50 }),
      cand({ id: 2, bearing: 180, distM: 12_000, lreq: 9, travelMin: 40 }), // latest deadline
    ];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    expect(roles(res)).toEqual([
      ["safest", 1],
      ["best", 2],
    ]);
  });

  it("drops safest when its glide is not gentler than best's", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 8000, lreq: 7, travelMin: 40 }), // best, latest deadline
      cand({ id: 2, bearing: 180, distM: 6000, lreq: 7, travelMin: 60 }),
    ];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    expect(roles(res)).toEqual([
      ["best", 1],
      ["alt", 2],
    ]);
  });

  it("takes alt from the next-latest deadline at least 60 degrees off best", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 8000, lreq: 8, travelMin: 40 }), // best
      cand({ id: 2, bearing: 30, distM: 8000, lreq: 8.5, travelMin: 45 }), // too close in bearing
      cand({ id: 3, bearing: 180, distM: 8000, lreq: 9, travelMin: 50 }), // alt
    ];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    expect(res.picks.find((p) => p.role === "alt")!.cand.stop.id).toBe(3);
  });

  it("drops stops whose deadline has already passed", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 90 }),
      cand({ id: 2, bearing: 180, distM: 9000, lreq: 9, arrivalMin: 400 }), // cannot make it
    ];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    expect(res.mode).toBe("homeBy");
    expect(roles(res)).toEqual([["best", 1]]);
  });

  it("excludes a no-service stop from the feasible set", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 3000, lreq: 4, travelMin: 60 }),
      cand({ id: 2, bearing: 180, distM: 8000, lreq: 9, travelMin: 40 }), // latest deadline
    ];
    const res = rank({
      candidates,
      mode: "homeBy",
      homeByMs,
      noService: new Set([2]),
      ...base,
    });
    expect(roles(res)).toEqual([["best", 1]]);
  });

  it("falls back to earliest mode when no stop can make the target", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 300 }),
      cand({ id: 2, bearing: 180, distM: 9000, lreq: 9, arrivalMin: 260 }),
    ];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    expect(res.mode).toBe("earliest");
    expect(res.missedHomeBy).toBe(true);
    expect(roles(res)).toEqual([
      ["safest", 1],
      ["best", 2],
    ]);
    expect(res.picks[0]!.budgetMin).toBeNull();
  });

  it("uses the live journey's departure when one arrives in time", () => {
    const c = cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 90 });
    const live = journey({ dep: NOW + 130 * 60_000, arr: homeByMs - 5 * 60_000 });
    const res = rank({
      candidates: [c],
      mode: "homeBy",
      homeByMs,
      journeys: new Map([[1, live]]),
      ...base,
    });
    expect(res.picks[0]!.landBy).toBe(live.dep - 15 * 60_000);
  });
});
