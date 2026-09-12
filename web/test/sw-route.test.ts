import { describe, expect, it } from "vitest";
import { strategyFor } from "../src/sw-route";

const ORIGIN = "https://user.github.io";
const route = (path: string, mode = "no-cors"): string =>
  strategyFor(new URL(path, ORIGIN), mode, ORIGIN);

describe("strategyFor", () => {
  it("serves documents network-first", () => {
    expect(route("/xctrack-sbb-widget/", "navigate")).toBe("network-first");
    expect(route("/xctrack-sbb-widget/setup.html")).toBe("network-first");
  });

  it("serves hashed bundles cache-first", () => {
    expect(route("/xctrack-sbb-widget/assets/main-a1b2c3d4.js")).toBe("cache-first");
  });

  it("serves travel-time tables with the table rule", () => {
    expect(route("/xctrack-sbb-widget/data/tables/8507000.bin.gz")).toBe("table");
    expect(route("/xctrack-sbb-widget/data/tables/8507000.bin")).toBe("table");
  });

  it("serves the stop dataset cache-first", () => {
    expect(route("/xctrack-sbb-widget/data/stops.json.gz")).toBe("cache-first");
    expect(route("/xctrack-sbb-widget/data/meta.json")).toBe("cache-first");
  });

  it("never intercepts the worker script itself", () => {
    expect(route("/xctrack-sbb-widget/sw.js")).toBe("passthrough");
  });

  it("never intercepts cross-origin requests", () => {
    expect(strategyFor(new URL("https://transport.opendata.ch/v1/connections"), "cors", ORIGIN)).toBe(
      "passthrough",
    );
  });
});
