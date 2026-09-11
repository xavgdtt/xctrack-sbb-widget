import { describe, expect, it } from "vitest";
import {
  COLUMN_ASPECT,
  fitCell,
  gearSize,
  isColumns,
  render,
  type Cell,
} from "../src/render";
import type { Candidate, Pick, RenderModel, Role, Stop } from "../src/types";

function cell(over: Partial<Cell> = {}): Cell {
  return {
    role: "BEST",
    name: "Interlaken Ost",
    distKm: 6.8,
    L: 5.1,
    bearing: 75,
    line3: { kind: "times", dep: "15:52", home: "17:28" },
    ...over,
  };
}

const CELLS = [cell({ role: "SAFEST", name: "Wilderswil" }), cell(), cell({ role: "NEAREST" })];

/** Minimal stand-in for an SVGSVGElement: render() only sets attributes and innerHTML. */
function fakeSvg(): { innerHTML: string; attrs: Record<string, string> } & SVGSVGElement {
  const attrs: Record<string, string> = {};
  return {
    innerHTML: "",
    attrs,
    setAttribute(name: string, value: string) {
      attrs[name] = value;
    },
  } as unknown as { innerHTML: string; attrs: Record<string, string> } & SVGSVGElement;
}

function stop(id: number, n: string): Stop {
  return { id, n, lat: 46.68, lon: 7.86, e: 568, m: 1 };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    stop: stop(8507492, "Interlaken Ost"),
    distM: 6800,
    bearing: 75,
    lreq: 5.1,
    tFlyMin: 12,
    earliestDep: Date.UTC(2026, 5, 6, 13, 52),
    travelEstMin: 96,
    arrivalEst: Date.UTC(2026, 5, 6, 15, 28),
    ...over,
  };
}

function pick(role: Role, over: Partial<Pick> = {}): Pick {
  return { role, cand: candidate(), journey: null, landBy: null, budgetMin: null, ...over };
}

function model(over: Partial<RenderModel> = {}): RenderModel {
  return {
    picks: [pick("safest"), pick("best"), pick("nearest")],
    mode: "earliest",
    homeByLabel: null,
    track: null,
    arrow: "north",
    ageSec: 42,
    stale: false,
    offline: false,
    altSource: "gps",
    theme: "dark",
    noFix: false,
    message: null,
    ...over,
  };
}

describe("layout rule", () => {
  it("uses columns only above the aspect threshold", () => {
    expect(isColumns(720, 220)).toBe(true);
    expect(isColumns(360, 360)).toBe(false);
    // Exactly at the threshold counts as rows.
    expect(isColumns(COLUMN_ASPECT * 200, 200)).toBe(false);
    expect(isColumns(COLUMN_ASPECT * 200 + 1, 200)).toBe(true);
  });
});

describe("detail ladder", () => {
  it("shows role, name, stats and times when there is room", () => {
    const fit = fitCell(CELLS, 300, 120, 24);
    expect(fit.role).toBe(true);
    expect(fit.lines).toEqual(["name", "stats", "times"]);
  });

  it("drops the role label before anything else", () => {
    const fit = fitCell(CELLS, 220, 58, 24);
    expect(fit.role).toBe(false);
    expect(fit.lines).toEqual(["name", "stats", "times"]);
  });

  it("drops the name next, keeping the times above the stats", () => {
    const fit = fitCell(CELLS, 220, 40, 24);
    expect(fit.lines).toEqual(["timesBig", "statsSmall"]);
  });

  it("falls back to short times plus the glide ratio at the smallest size", () => {
    const fit = fitCell(CELLS, 80, 30, 24);
    expect(fit.lines).toEqual(["timesShort", "lOnly"]);
    expect(fit.fName).toBeGreaterThanOrEqual(9);
  });

  it("shows name and stats when there is no timetable to show", () => {
    const untimed = CELLS.map((c) => cell({ ...c, line3: null }));
    expect(fitCell(untimed, 300, 120, 24).lines).toEqual(["name", "stats"]);
    expect(fitCell(untimed, 70, 26, 24).lines).toEqual(["statsCompact"]);
  });

  it("never grows the font past the ceiling on a huge cell", () => {
    expect(fitCell(CELLS, 4000, 4000, 24).fName).toBeLessThanOrEqual(64);
  });
});

describe("render", () => {
  it("draws three cells, a footer and the gear, and no terrain note", () => {
    const svg = fakeSvg();
    render(svg, model(), 720, 220);
    expect(svg.attrs["viewBox"]).toBe("0 0 720 220");
    expect(svg.innerHTML).toContain('id="gear"');
    expect(svg.innerHTML).toContain("SAFEST");
    expect(svg.innerHTML).toContain("age 0:42");
    expect(svg.innerHTML).not.toContain("no terrain check");
  });

  it("omits the timetable and marks OFFLINE when offline", () => {
    const svg = fakeSvg();
    render(svg, model({ offline: true }), 720, 220);
    expect(svg.innerHTML).toContain("OFFLINE");
    expect(svg.innerHTML).not.toContain("dep ");
  });

  it("shows the land-by line in home-by mode, red when the budget is short", () => {
    const svg = fakeSvg();
    const picks = [
      pick("safest", { landBy: Date.UTC(2026, 5, 6, 15, 42), budgetMin: 65 }),
      pick("best", { landBy: Date.UTC(2026, 5, 6, 15, 42), budgetMin: 9 }),
    ];
    render(svg, model({ mode: "homeBy", picks, homeByLabel: "home by 19:30" }), 720, 220);
    expect(svg.innerHTML).toContain("land by");
    expect(svg.innerHTML).toContain("1h05 left");
    expect(svg.innerHTML).toContain("home by 19:30");
    expect(svg.innerHTML).toContain("#EB0000"); // the 9-minute budget is red
  });

  it("lays out fewer than three picks across the whole widget", () => {
    const svg = fakeSvg();
    render(svg, model({ picks: [pick("safest"), pick("best")] }), 720, 220);
    // Two columns means a single separator, at the halfway mark.
    expect(svg.innerHTML).toContain('x1="360"');
  });

  it("marks north-up when heading mode has no track", () => {
    const svg = fakeSvg();
    render(svg, model({ arrow: "heading", track: null }), 720, 220);
    expect(svg.innerHTML).toContain(">N</text>");
    const withTrack = fakeSvg();
    render(withTrack, model({ arrow: "heading", track: 180 }), 720, 220);
    expect(withTrack.innerHTML).not.toContain(">N</text>");
  });

  it("shows a big centred message instead of cells", () => {
    const svg = fakeSvg();
    render(svg, model({ noFix: true, picks: [], message: "waiting for GPS" }), 360, 160);
    expect(svg.innerHTML).toContain("waiting for GPS");
    expect(svg.innerHTML).toContain('text-anchor="middle"');
    expect(svg.innerHTML).not.toContain("SAFEST");
  });

  it("keeps the gear tappable on a tiny widget", () => {
    expect(gearSize(180, 160)).toBe(22);
    expect(gearSize(720, 400)).toBeCloseTo(48);
  });
});
