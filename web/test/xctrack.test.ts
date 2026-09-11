import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config";
import { igcToFix, parseIGC, parseXCTrackLocation } from "../src/xctrack";
import type { Config } from "../src/types";

const cfg: Config = { ...DEFAULTS, home: 8507000 };
const baroCfg: Config = { ...cfg, alt: "baro" };

describe("parseXCTrackLocation", () => {
  const loc = {
    lat: 46.7,
    lon: 7.9,
    time: 1_777_000_000_000,
    altGps: 2000,
    isValid: true,
    stdBaroAlt: 1950,
    speedGps: 32,
    bearingGps: 210,
    heading: 180,
  };

  it("handles the no-fix payloads", () => {
    expect(parseXCTrackLocation("null", cfg)).toBeNull();
    expect(parseXCTrackLocation(null, cfg)).toBeNull();
    expect(parseXCTrackLocation("{ not json", cfg)).toBeNull();
    expect(parseXCTrackLocation(JSON.stringify({ ...loc, isValid: false }), cfg)).toBeNull();
  });

  it("uses GPS altitude by default and barometric altitude on request", () => {
    expect(parseXCTrackLocation(JSON.stringify(loc), cfg)).toMatchObject({
      alt: 2000,
      altSource: "gps",
      t: loc.time,
    });
    expect(parseXCTrackLocation(JSON.stringify(loc), baroCfg)).toMatchObject({
      alt: 1950,
      altSource: "baro",
    });
  });

  it("falls back to GPS altitude when the barometer reports nothing", () => {
    const raw = JSON.stringify({ ...loc, stdBaroAlt: null });
    expect(parseXCTrackLocation(raw, baroCfg)).toMatchObject({ alt: 2000, altSource: "gps" });
  });

  it("takes the track from the GPS course when moving and the compass when not", () => {
    expect(parseXCTrackLocation(JSON.stringify(loc), cfg)!.track).toBe(210);
    const slow = JSON.stringify({ ...loc, speedGps: 3 });
    expect(parseXCTrackLocation(slow, cfg)!.track).toBe(180);
  });

  it("reports no track when neither course nor heading is known", () => {
    const raw = JSON.stringify({ ...loc, bearingGps: null, heading: null });
    expect(parseXCTrackLocation(raw, cfg)!.track).toBeNull();
  });
});

describe("parseIGC", () => {
  it("decodes B records into fixes", () => {
    const igc = [
      "AXCS001",
      "HFDTE110926",
      "B1215004642075N00748000EA0157001600",
      "B1215054642011N00748110EA0157701607",
      "B121510XXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      "LXCS ignored",
    ].join("\n");
    const fixes = parseIGC(igc);
    expect(fixes).toHaveLength(2);
    expect(fixes[0]!.lat).toBeCloseTo(46 + 42.075 / 60, 6);
    expect(fixes[0]!.lon).toBeCloseTo(7 + 48.0 / 60, 6);
    expect(fixes[0]!.gpsAlt).toBe(1600);
    expect(fixes[0]!.baroAlt).toBe(1570);
    expect(fixes[0]!.t).toBe(Date.UTC(2026, 8, 11, 12, 15, 0));
    expect(fixes[1]!.t - fixes[0]!.t).toBe(5000);
  });

  it("handles southern and western hemispheres", () => {
    const igc = "B1215003330000S01800000WA0010000110";
    const fixes = parseIGC(igc);
    expect(fixes[0]!.lat).toBeCloseTo(-33.5, 6);
    expect(fixes[0]!.lon).toBeCloseTo(-18, 6);
  });

  it("reads the committed replay fixture", () => {
    const text = readFileSync(new URL("../public/fixtures/flight.igc", import.meta.url), "utf8");
    const fixes = parseIGC(text);
    expect(fixes.length).toBe(541); // 45 minutes at one fix per 5 s
    expect(fixes[fixes.length - 1]!.t - fixes[0]!.t).toBe(2700 * 1000);
    const alts = fixes.map((f) => f.gpsAlt);
    expect(Math.max(...alts)).toBeGreaterThanOrEqual(2600);
    expect(alts[alts.length - 1]!).toBeLessThan(700);
    for (const f of fixes) {
      expect(f.lat).toBeGreaterThan(46.6);
      expect(f.lat).toBeLessThan(46.8);
      expect(f.lon).toBeGreaterThan(7.7);
      expect(f.lon).toBeLessThan(8.0);
    }
  });
});

describe("igcToFix", () => {
  it("derives speed and track from the preceding fix", () => {
    const fixes = parseIGC(
      [
        "HFDTE110926",
        "B1215004642000N00748000EA0157001600",
        "B1215054642100N00748000EA0157001605",
      ].join("\n"),
    );
    const first = igcToFix(fixes, 0, cfg);
    expect(first.speedKmh).toBe(0);
    expect(first.track).toBeNull();
    const second = igcToFix(fixes, 1, cfg);
    expect(second.track).toBeCloseTo(0, 1); // due north
    expect(second.speedKmh).toBeCloseTo((185 / 5) * 3.6, 0);
    expect(second.alt).toBe(1605);
    expect(igcToFix(fixes, 1, baroCfg).alt).toBe(1570);
  });
});
