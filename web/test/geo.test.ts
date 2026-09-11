import { describe, expect, it } from "vitest";
import { angleDiffDeg, bboxAround, bearingDeg, haversineM, norm360 } from "../src/geo";

const BERN = { lat: 46.9489, lon: 7.4392 };
const ZURICH = { lat: 47.3779, lon: 8.5403 };

describe("haversineM", () => {
  it("matches a known city pair", () => {
    const d = haversineM(BERN.lat, BERN.lon, ZURICH.lat, ZURICH.lon);
    expect(d / 1000).toBeCloseTo(95.94, 1);
  });

  it("gives one degree of longitude on the equator as ~111.2 km", () => {
    expect(haversineM(0, 0, 0, 1) / 1000).toBeCloseTo(111.19, 1);
  });

  it("is zero for identical points", () => {
    expect(haversineM(BERN.lat, BERN.lon, BERN.lat, BERN.lon)).toBe(0);
  });
});

describe("bearingDeg", () => {
  it("points north-east from Bern to Zurich", () => {
    expect(bearingDeg(BERN.lat, BERN.lon, ZURICH.lat, ZURICH.lon)).toBeCloseTo(59.78, 1);
  });

  it("is 90 degrees due east along the equator", () => {
    expect(bearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 6);
  });

  it("is 0 degrees due north", () => {
    expect(bearingDeg(46, 8, 47, 8)).toBeCloseTo(0, 6);
  });
});

describe("angleDiffDeg", () => {
  it("wraps across north", () => {
    expect(angleDiffDeg(350, 10)).toBe(20);
    expect(angleDiffDeg(10, 350)).toBe(20);
  });

  it("caps at 180 degrees", () => {
    expect(angleDiffDeg(0, 180)).toBe(180);
  });
});

describe("norm360", () => {
  it("wraps negatives into range", () => {
    expect(norm360(-90)).toBe(270);
    expect(norm360(720)).toBe(0);
  });
});

describe("bboxAround", () => {
  it("contains every point inside the radius", () => {
    const box = bboxAround(46.7, 7.9, 10_000);
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const rad = (bearing * Math.PI) / 180;
      const lat = 46.7 + (10_000 * Math.cos(rad)) / 111_320;
      const lon =
        7.9 + (10_000 * Math.sin(rad)) / (111_320 * Math.cos((46.7 * Math.PI) / 180));
      expect(lat).toBeGreaterThanOrEqual(box.minLat - 1e-9);
      expect(lat).toBeLessThanOrEqual(box.maxLat + 1e-9);
      expect(lon).toBeGreaterThanOrEqual(box.minLon - 1e-9);
      expect(lon).toBeLessThanOrEqual(box.maxLon + 1e-9);
    }
  });
});
