import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasXCTrack, igcToFix, parseIGC, parseXCTrackLocation, startLocationSource } from "../src/xctrack";
import { DEFAULTS } from "../src/config";
import type { Config } from "../src/types";

const cfg: Config = { ...DEFAULTS, home: 8507000 };

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
    expect(parseXCTrackLocation("null")).toBeNull();
    expect(parseXCTrackLocation(null)).toBeNull();
    expect(parseXCTrackLocation("{ not json")).toBeNull();
    expect(parseXCTrackLocation(JSON.stringify({ ...loc, isValid: false }))).toBeNull();
  });

  it("accepts an already-parsed object as well as a JSON string", () => {
    expect(parseXCTrackLocation(loc)).toMatchObject({ lat: 46.7, lon: 7.9, alt: 2000 });
    expect(parseXCTrackLocation(JSON.stringify(loc))).toMatchObject({ lat: 46.7, lon: 7.9 });
  });

  it("treats a missing isValid as valid and reads latitude/longitude aliases", () => {
    const { lat, lon, isValid, ...rest } = loc;
    expect(parseXCTrackLocation({ ...rest, latitude: lat, longitude: lon })).toMatchObject({
      lat: 46.7,
      lon: 7.9,
    });
  });

  it("always uses GPS altitude, falling back to the barometer when it is missing", () => {
    expect(parseXCTrackLocation(loc)).toMatchObject({ alt: 2000 });
    expect(parseXCTrackLocation({ ...loc, altGps: null })).toMatchObject({ alt: 1950 });
    expect(parseXCTrackLocation({ ...loc, altGps: null, stdBaroAlt: null })).toBeNull();
  });

  it("timestamps the fix on arrival and keeps the reported time, in ms or seconds", () => {
    const received = 1_800_000_000_000;
    expect(parseXCTrackLocation(loc, received)).toMatchObject({
      t: received,
      reportedT: loc.time,
    });
    // A replay reports a historical time; it must not make the fix look stale.
    const seconds = parseXCTrackLocation({ ...loc, time: 1_600_000_000 }, received);
    expect(seconds).toMatchObject({ t: received, reportedT: 1_600_000_000_000 });
    expect(parseXCTrackLocation({ ...loc, time: undefined }, received)).toMatchObject({
      t: received,
      reportedT: null,
    });
  });

  it("takes the track from the GPS course when moving and the compass when not", () => {
    expect(parseXCTrackLocation(loc)!.track).toBe(210);
    expect(parseXCTrackLocation({ ...loc, speedGps: 3 })!.track).toBe(180);
  });

  it("reports no track and no speed when the payload carries neither", () => {
    const raw = { ...loc, bearingGps: null, heading: null, speedGps: null, speedComputed: null };
    const fix = parseXCTrackLocation(raw)!;
    expect(fix.track).toBeNull();
    expect(fix.speedKmh).toBe(0);
    expect(parseXCTrackLocation({ ...loc, speedGps: Number.NaN })!.speedKmh).toBe(0);
  });
});

describe("startLocationSource", () => {
  const withBridge = <T>(bridge: unknown, body: () => T): T => {
    const g = globalThis as { XCTrack?: unknown };
    const had = "XCTrack" in g;
    const prev = g.XCTrack;
    g.XCTrack = bridge;
    try {
      return body();
    } finally {
      if (had) g.XCTrack = prev;
      else delete g.XCTrack;
    }
  };

  it("uses XCTrack exclusively once the bridge exists, even with no valid fix", () => {
    withBridge({ getLocation: () => "null" }, () => {
      expect(hasXCTrack()).toBe(true);
      const seen: string[] = [];
      const fixes: unknown[] = [];
      const stop = startLocationSource({ ...cfg, replay: "fixtures/flight.igc" }, (f) => fixes.push(f), {
        onSource: (name) => seen.push(name),
      });
      stop();
      expect(seen).toEqual(["xctrack"]); // never "geolocation", never "replay"
      expect(fixes).toEqual([]);
    });
  });

  it("reports the raw payload and the fix count for the ?debug=1 corner", () => {
    const payload = JSON.stringify({ lat: 46.7, lon: 7.9, altGps: 2000 });
    withBridge({ getLocation: () => payload }, () => {
      const debug: { source: string; raw: string | null; fixes: number }[] = [];
      const stop = startLocationSource(cfg, () => {}, { onDebug: (d) => debug.push(d) });
      stop();
      expect(debug[0]).toMatchObject({ source: "xctrack", raw: payload, fixes: 1 });
    });
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
    const first = igcToFix(fixes, 0);
    expect(first.speedKmh).toBe(0);
    expect(first.track).toBeNull();
    const second = igcToFix(fixes, 1);
    expect(second.track).toBeCloseTo(0, 1); // due north
    expect(second.speedKmh).toBeCloseTo((185 / 5) * 3.6, 0);
    expect(second.alt).toBe(1605); // GPS altitude, always
  });
});
