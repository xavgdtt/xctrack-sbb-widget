import { describe, expect, it } from "vitest";
import { HEADER_BYTES, UNREACHABLE, decodeTable } from "../src/table";

const BUILD_ID = "2026-09-11-4b9110db"; // 19 chars: the header keeps the first 16

interface TableSpec {
  buildId?: string;
  homeId?: number;
  magic?: string;
  version?: number;
  stopCount?: number;
  dayTypes?: number;
  hourStart?: number;
  hourCount?: number;
  fill?: (dayType: number, hourIdx: number, stopIdx: number) => number;
}

/** Build a table buffer in the format data/build_tables.py must emit. */
function makeTable(spec: TableSpec = {}): ArrayBuffer {
  const magic = spec.magic ?? "XSBT";
  const dayTypes = spec.dayTypes ?? 3;
  const hourStart = spec.hourStart ?? 6;
  const hourCount = spec.hourCount ?? 16;
  const stopCount = spec.stopCount ?? 3;
  const cells = dayTypes * hourCount * stopCount;
  const buffer = new ArrayBuffer(HEADER_BYTES + cells * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, magic.charCodeAt(i));
  view.setUint8(4, spec.version ?? 1);
  view.setUint8(5, dayTypes);
  view.setUint8(6, hourStart);
  view.setUint8(7, hourCount);
  view.setUint32(8, stopCount, true);
  view.setUint32(12, spec.homeId ?? 8507000, true);
  const buildId = spec.buildId ?? BUILD_ID;
  for (let i = 0; i < buildId.length && i < 16; i += 1) {
    view.setUint8(16 + i, buildId.charCodeAt(i));
  }
  const values = new Uint16Array(buffer, HEADER_BYTES, cells);
  const fill = spec.fill ?? ((dt, h, s) => dt * 100 + h * 10 + s);
  for (let dt = 0; dt < dayTypes; dt += 1) {
    for (let h = 0; h < hourCount; h += 1) {
      for (let s = 0; s < stopCount; s += 1) {
        values[(dt * hourCount + h) * stopCount + s] = fill(dt, h, s);
      }
    }
  }
  return buffer;
}

const at = (y: number, m: number, d: number, h: number): number =>
  new Date(y, m - 1, d, h, 0).getTime();

describe("decodeTable", () => {
  it("reads the header", () => {
    const table = decodeTable(makeTable(), { buildId: BUILD_ID })!;
    expect(table).not.toBeNull();
    expect(table.homeId).toBe(8507000);
    expect(table.stopCount).toBe(3);
    expect(table.hourStart).toBe(6);
    expect(table.hourCount).toBe(16);
  });

  it("indexes by day type, departure hour and stop", () => {
    const table = decodeTable(makeTable(), { buildId: BUILD_ID })!;
    expect(table.lookup(2, at(2026, 5, 13, 15))).toBe(0 * 100 + 9 * 10 + 2); // Wednesday
    expect(table.lookup(1, at(2026, 5, 16, 15))).toBe(1 * 100 + 9 * 10 + 1); // Saturday
    expect(table.lookup(0, at(2026, 5, 17, 15))).toBe(2 * 100 + 9 * 10 + 0); // Sunday
  });

  it("clamps departures outside the covered hours", () => {
    const table = decodeTable(makeTable(), { buildId: BUILD_ID })!;
    expect(table.lookup(0, at(2026, 5, 13, 3))).toBe(table.lookup(0, at(2026, 5, 13, 6)));
    expect(table.lookup(0, at(2026, 5, 13, 23))).toBe(table.lookup(0, at(2026, 5, 13, 21)));
  });

  it("returns null for unreachable entries and out-of-range stops", () => {
    const table = decodeTable(makeTable({ fill: () => UNREACHABLE }), {
      buildId: BUILD_ID,
    })!;
    expect(table.lookup(0, at(2026, 5, 13, 15))).toBeNull();
    expect(table.lookup(99, at(2026, 5, 13, 15))).toBeNull();
    expect(table.lookup(-1, at(2026, 5, 13, 15))).toBeNull();
  });

  it("matches a build id longer than the 16-byte header field", () => {
    const table = decodeTable(makeTable({ buildId: BUILD_ID }), { buildId: BUILD_ID });
    expect(table!.buildId).toBe(BUILD_ID.slice(0, 16));
  });

  it("rejects a table built against a different dataset", () => {
    expect(decodeTable(makeTable({ buildId: "other-build" }), { buildId: BUILD_ID })).toBeNull();
  });

  it("rejects a wrong magic, version, home or truncated body", () => {
    expect(decodeTable(makeTable({ magic: "NOPE" }), { buildId: BUILD_ID })).toBeNull();
    expect(decodeTable(makeTable({ version: 2 }), { buildId: BUILD_ID })).toBeNull();
    expect(
      decodeTable(makeTable({ homeId: 1 }), { buildId: BUILD_ID, homeId: 8507000 }),
    ).toBeNull();
    expect(decodeTable(makeTable().slice(0, 40), { buildId: BUILD_ID })).toBeNull();
    expect(decodeTable(new ArrayBuffer(8), { buildId: BUILD_ID })).toBeNull();
  });
});
