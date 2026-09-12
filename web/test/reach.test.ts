import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config";
import { buildCandidate, buildCandidates, heuristicTravelMin, isReachable } from "../src/reach";
import { buildIndex } from "../src/stops";
import type { Config, Fix, Stop } from "../src/types";

const cfg: Config = { ...DEFAULTS, home: 8507000, v: 34, lmax: 15, lsafe: 6, margin: 150 };
const NOW = new Date(2026, 4, 16, 15, 0, 0).getTime();

const fix: Fix = {
  lat: 46.7,
  lon: 7.9,
  alt: 2000,
  speedKmh: 35,
  track: 90,
  t: NOW,
};

const stop = (over: Partial<Stop> & { id: number }): Stop => ({
  n: `stop ${over.id}`,
  lat: 46.7,
  lon: 7.9,
  e: 600,
  m: 1,
  ...over,
});

// 0.05 degrees of longitude at this latitude is ~3.8 km.
const east = (deg: number): number => 7.9 + deg;

describe("isReachable", () => {
  it("accepts a stop inside the maximum glide ratio", () => {
    // 1250 m of usable height, ~3.8 km away -> L 3.0
    expect(isReachable(fix, stop({ id: 1, lon: east(0.05) }), cfg)).toBe(true);
  });

  it("rejects a stop that needs more than lmax", () => {
    expect(isReachable(fix, stop({ id: 2, lon: east(0.4) }), cfg)).toBe(false);
  });

  it("rejects a stop above the pilot", () => {
    expect(isReachable(fix, stop({ id: 3, e: 2500, lon: east(0.01) }), cfg)).toBe(false);
  });

  it("rejects a stop that is below but inside the safety margin", () => {
    // 2000 - 1810 - 150 = 40 m of usable height, under the 50 m floor.
    expect(isReachable(fix, stop({ id: 4, e: 1810, lon: east(0.001) }), cfg)).toBe(false);
  });
});

describe("buildCandidate", () => {
  it("derives glide time, earliest departure and arrival estimate", () => {
    const home = stop({ id: 8507000, lat: 46.95, lon: 7.44, e: 540 });
    const cand = buildCandidate(fix, stop({ id: 10, lon: east(0.05) }), cfg, {
      home,
      now: NOW,
    });
    expect(cand).not.toBeNull();
    const c = cand!;
    expect(c.distM / 1000).toBeCloseTo(3.8, 1);
    expect(c.tFlyMin).toBeCloseTo((c.distM / 1000 / 34) * 60, 6);
    // now + flight + pack + walk, rounded up to the next whole minute
    expect(c.earliestDep).toBe(NOW + 22 * 60_000);
    expect(c.travelEstMin).toBeCloseTo(heuristicTravelMin(stop({ id: 10, lon: east(0.05) }), home), 6);
    expect(c.arrivalEst).toBe(c.earliestDep + c.travelEstMin! * 60_000);
  });

  it("returns null for an unreachable stop", () => {
    expect(buildCandidate(fix, stop({ id: 11, e: 2500 }), cfg, { now: NOW })).toBeNull();
  });

  it("prefers the table over the heuristic and leaves the estimate null without either", () => {
    const s = { ...stop({ id: 12, lon: east(0.05) }), stopIdx: 7 };
    const withTable = buildCandidate(fix, s, cfg, {
      now: NOW,
      travelEst: (idx) => (idx === 7 ? 41 : null),
      home: stop({ id: 8507000, lat: 46.95, lon: 7.44 }),
    });
    expect(withTable!.travelEstMin).toBe(41);
    const bare = buildCandidate(fix, s, cfg, { now: NOW });
    expect(bare!.travelEstMin).toBeNull();
    expect(bare!.arrivalEst).toBeNull();
  });
});

describe("heuristicTravelMin", () => {
  it("penalises stops off the rail network", () => {
    const home = stop({ id: 8507000, lat: 46.95, lon: 7.44 });
    const rail = heuristicTravelMin(stop({ id: 20, m: 1 }), home);
    const bus = heuristicTravelMin(stop({ id: 21, m: 2 }), home);
    const other = heuristicTravelMin(stop({ id: 22, m: 16 }), home);
    expect(bus - rail).toBe(15);
    expect(other - rail).toBe(25);
  });
});

describe("buildCandidates", () => {
  it("keeps reachable stops only and sorts them by arrival estimate", () => {
    const home = stop({ id: 8507000, lat: 46.95, lon: 7.44, e: 540 });
    const index = buildIndex([
      stop({ id: 1, lon: east(0.05) }),
      stop({ id: 2, lon: east(0.4) }), // too far
      stop({ id: 3, lat: 46.75, lon: east(0.02) }),
      home,
    ]);
    const cands = buildCandidates(fix, index, cfg, { home, now: NOW });
    expect(cands.map((c) => c.stop.id).sort()).toEqual([1, 3]);
    for (let i = 1; i < cands.length; i += 1) {
      expect(cands[i]!.arrivalEst!).toBeGreaterThanOrEqual(cands[i - 1]!.arrivalEst!);
    }
  });

  it("returns nothing when the pilot is below the safety margin", () => {
    const low: Fix = { ...fix, alt: 100 };
    const index = buildIndex([stop({ id: 1, lon: east(0.05) })]);
    expect(buildCandidates(low, index, cfg, { now: NOW })).toEqual([]);
  });
});
