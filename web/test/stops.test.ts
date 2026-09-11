import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIndex, loadStops } from "../src/stops";
import { bboxAround } from "../src/geo";
import type { Stop } from "../src/types";

const DATA: Stop[] = [
  { id: 8507000, n: "Bern", lat: 46.9489, lon: 7.4392, e: 540, m: 3 },
  { id: 8507492, n: "Interlaken Ost", lat: 46.6906, lon: 7.8694, e: 567, m: 11 },
  { id: 8503000, n: "Zürich HB", lat: 47.3779, lon: 8.5403, e: 408, m: 39 },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildIndex", () => {
  it("keeps the file order as stopIdx and looks stops up by id", () => {
    const index = buildIndex(DATA);
    expect(index.all.map((s) => s.stopIdx)).toEqual([0, 1, 2]);
    expect(index.byId(8507492)!.stopIdx).toBe(1);
    expect(index.byId(1)).toBeUndefined();
  });

  it("returns only the stops inside the query box", () => {
    const index = buildIndex(DATA);
    const box = bboxAround(46.7, 7.9, 10_000);
    expect(index.queryBBox(box).map((s) => s.id)).toEqual([8507492]);
  });

  it("finds stops in neighbouring grid cells", () => {
    const index = buildIndex(DATA);
    // 40 km around Thun reaches Bern and Interlaken, which sit in different cells.
    const hits = index.queryRadius(46.76, 7.63, 40_000).map((s) => s.id);
    expect(hits.sort()).toEqual([8507000, 8507492]);
  });

  it("returns nothing for an empty area", () => {
    expect(buildIndex(DATA).queryRadius(45.0, 6.0, 5_000)).toEqual([]);
  });
});

describe("loadStops", () => {
  it("decompresses stops.json.gz", async () => {
    const gz = gzipSync(Buffer.from(JSON.stringify(DATA)));
    vi.stubGlobal("fetch", (url: string) => {
      expect(url).toBe("/data/stops.json.gz");
      return Promise.resolve(new Response(gz));
    });
    const index = await loadStops("/");
    expect(index.all).toHaveLength(3);
    expect(index.byId(8503000)!.n).toBe("Zürich HB");
  });

  it("falls back to the uncompressed file when the gzip fetch fails", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      seen.push(url);
      return url.endsWith(".gz")
        ? Promise.resolve(new Response("", { status: 404 }))
        : Promise.resolve(new Response(JSON.stringify(DATA)));
    });
    const index = await loadStops("/base");
    expect(seen).toEqual(["/base/data/stops.json.gz", "/base/data/stops.json"]);
    expect(index.all).toHaveLength(3);
  });

  it("skips malformed records", async () => {
    const body = JSON.stringify([DATA[0], { id: 1 }, { n: "nameless" }]);
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(body)));
    const original = globalThis.DecompressionStream;
    vi.stubGlobal("DecompressionStream", undefined);
    try {
      const index = await loadStops("/");
      expect(index.all.map((s) => s.id)).toEqual([8507000]);
    } finally {
      vi.stubGlobal("DecompressionStream", original);
    }
  });
});
