import { describe, expect, it } from "vitest";
import { rank, isDuplicate } from "../src/rank";
import type { Candidate, Journey } from "../src/types";

const NOW = new Date(2026, 4, 16, 15, 0, 0).getTime();
const ORIGIN = { lat: 46.7, lon: 7.9 };

interface Spec {
  id: number;
  bearing: number;
  distM: number;
  lreq: number;
  /** Minutes from now to the estimated arrival at home. */
  arrivalMin: number;
}

function cand(spec: Spec): Candidate {
  const rad = (spec.bearing * Math.PI) / 180;
  const lat = ORIGIN.lat + (spec.distM * Math.cos(rad)) / 111_320;
  const lon =
    ORIGIN.lon +
    (spec.distM * Math.sin(rad)) / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
  const tFlyMin = spec.distM / 1000 / 34 * 60;
  const earliestDep = NOW + (tFlyMin + 15) * 60_000;
  const arrivalEst = NOW + spec.arrivalMin * 60_000;
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

const base = { lsafe: 6, groundMin: 15, now: NOW } as const;

describe("rank in earliest mode", () => {
  it("picks the earliest safe stop, the earliest of the rest, then the nearest", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 4000, lreq: 5, arrivalMin: 90 }), // safest
      cand({ id: 2, bearing: 120, distM: 12_000, lreq: 11, arrivalMin: 60 }), // best
      cand({ id: 3, bearing: 240, distM: 1500, lreq: 9, arrivalMin: 150 }), // nearest
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(res.mode).toBe("earliest");
    expect(res.picks.map((p) => [p.role, p.cand.stop.id])).toEqual([
      ["safest", 1],
      ["best", 2],
      ["nearest", 3],
    ]);
    expect(res.picks.every((p) => p.landBy === null && p.budgetMin === null)).toBe(true);
  });

  it("falls back to the lowest required glide when nothing is inside lsafe", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 9000, lreq: 9, arrivalMin: 120 }),
      cand({ id: 2, bearing: 180, distM: 12_000, lreq: 7.5, arrivalMin: 200 }),
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(res.picks[0]!.cand.stop.id).toBe(2);
    expect(res.picks[0]!.role).toBe("safest");
  });

  it("skips a candidate in the same direction and within 3 km of one already picked", () => {
    const candidates = [
      cand({ id: 1, bearing: 90, distM: 4000, lreq: 4, arrivalMin: 100 }), // safest
      cand({ id: 2, bearing: 95, distM: 4500, lreq: 8, arrivalMin: 70 }), // too close to 1
      cand({ id: 3, bearing: 200, distM: 9000, lreq: 8, arrivalMin: 80 }), // taken instead
    ];
    const res = rank({ candidates, mode: "earliest", ...base });
    expect(res.picks.map((p) => p.cand.stop.id)).toEqual([1, 3]);
  });

  it("shows fewer cells rather than repeating a stop", () => {
    const res = rank({
      candidates: [cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 90 })],
      mode: "earliest",
      ...base,
    });
    expect(res.picks).toHaveLength(1);
    expect(res.picks[0]!.role).toBe("safest");
  });

  it("returns nothing when no stop is reachable", () => {
    const res = rank({ candidates: [], mode: "earliest", ...base });
    expect(res.picks).toEqual([]);
    expect(res.missedHomeBy).toBe(false);
  });

  it("attaches live journeys by stop id", () => {
    const journey: Journey = {
      dep: NOW + 30 * 60_000,
      arr: NOW + 95 * 60_000,
      transfers: 1,
      categories: ["B", "IC"],
      fetchedAt: NOW,
      stale: false,
    };
    const res = rank({
      candidates: [cand({ id: 7, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 95 })],
      mode: "earliest",
      journeys: new Map([[7, journey]]),
      ...base,
    });
    expect(res.picks[0]!.journey).toBe(journey);
  });
});

describe("rank in home-by mode", () => {
  const homeByMs = NOW + 180 * 60_000; // three hours from now

  it("reports a land-by deadline and the remaining flying budget", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 90 }),
    ];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    expect(res.mode).toBe("homeBy");
    expect(res.missedHomeBy).toBe(false);
    const pick = res.picks[0]!;
    // travelEst is ~75 min, so the latest departure is ~105 min from now and the
    // land-by deadline 15 min (pack + walk) earlier.
    const travel = pick.cand.travelEstMin!;
    expect(pick.landBy).toBe(homeByMs - travel * 60_000 - 15 * 60_000);
    expect(pick.budgetMin).toBeCloseTo(
      (pick.landBy! - NOW) / 60_000 - pick.cand.tFlyMin,
      6,
    );
  });

  it("ranks best by the latest deadline, not the earliest arrival", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 3000, lreq: 4, arrivalMin: 60 }), // fast, early
      cand({ id: 2, bearing: 180, distM: 8000, lreq: 9, arrivalMin: 150 }), // slow, latest deadline
    ];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    const best = res.picks.find((p) => p.role === "best")!;
    expect(best.cand.stop.id).toBe(2);
  });

  it("drops stops whose deadline has already passed", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 90 }),
      cand({ id: 2, bearing: 180, distM: 9000, lreq: 9, arrivalMin: 400 }), // cannot make it
    ];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    expect(res.mode).toBe("homeBy");
    expect(res.picks.map((p) => p.cand.stop.id)).toEqual([1]);
  });

  it("falls back to earliest mode when no stop can make the target", () => {
    const candidates = [
      cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 300 }),
      cand({ id: 2, bearing: 180, distM: 9000, lreq: 9, arrivalMin: 260 }),
    ];
    const res = rank({ candidates, mode: "homeBy", homeByMs, ...base });
    expect(res.mode).toBe("earliest");
    expect(res.missedHomeBy).toBe(true);
    expect(res.picks.map((p) => p.cand.stop.id)).toEqual([1, 2]);
    expect(res.picks[0]!.budgetMin).toBeNull();
  });

  it("uses the live journey's departure when one arrives in time", () => {
    const c = cand({ id: 1, bearing: 0, distM: 4000, lreq: 4, arrivalMin: 90 });
    const journey: Journey = {
      dep: NOW + 130 * 60_000,
      arr: homeByMs - 5 * 60_000,
      transfers: 0,
      categories: ["R"],
      fetchedAt: NOW,
      stale: false,
    };
    const res = rank({
      candidates: [c],
      mode: "homeBy",
      homeByMs,
      journeys: new Map([[1, journey]]),
      ...base,
    });
    expect(res.picks[0]!.landBy).toBe(journey.dep - 15 * 60_000);
  });
});

describe("isDuplicate", () => {
  it("is false when the bearings differ by more than 45 degrees", () => {
    const a = cand({ id: 1, bearing: 10, distM: 2000, lreq: 4, arrivalMin: 60 });
    const b = cand({ id: 2, bearing: 80, distM: 2200, lreq: 4, arrivalMin: 60 });
    expect(isDuplicate(a, b)).toBe(false);
  });

  it("is false when the stops are more than 3 km apart", () => {
    const a = cand({ id: 1, bearing: 90, distM: 2000, lreq: 4, arrivalMin: 60 });
    const b = cand({ id: 2, bearing: 90, distM: 9000, lreq: 4, arrivalMin: 60 });
    expect(isDuplicate(a, b)).toBe(false);
  });
});
