import { beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_KEY,
  DEFAULTS,
  SETTINGS_KEY,
  clearSettings,
  defaultHomeBy,
  getConfig,
  initConfig,
  onConfigChange,
  parseQuery,
  saveConfig,
  updateSettings,
} from "../src/config";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });
  initConfig("");
});

describe("parseQuery", () => {
  it("reads every documented parameter", () => {
    const cfg = parseQuery(
      "?home=8507000&homeName=Bern&v=38&pack=12&walk=7&margin=200&lmax=12&lsafe=5" +
        "&alt=baro&mode=light&refresh=60&maxRoute=6&arrow=north&rankMode=homeBy" +
        "&homeBy=19:30&replay=fixtures/flight.igc&speed=20",
    );
    expect(cfg).toEqual({
      home: 8507000,
      homeName: "Bern",
      v: 38,
      pack: 12,
      walk: 7,
      margin: 200,
      lmax: 12,
      lsafe: 5,
      alt: "baro",
      mode: "light",
      refresh: 60,
      maxRoute: 6,
      arrow: "north",
      rankMode: "homeBy",
      homeBy: "19:30",
      replay: "fixtures/flight.igc",
      speed: 20,
    });
  });

  it("ignores unparseable values instead of poisoning the config", () => {
    expect(parseQuery("?home=abc&v=&lmax=-3&alt=radar&homeBy=noon")).toEqual({});
  });
});

describe("initConfig", () => {
  it("falls back to the defaults with a bare URL", () => {
    expect(initConfig("")).toEqual(DEFAULTS);
  });

  it("prefers URL parameters over the saved config", () => {
    saveConfig({ ...DEFAULTS, home: 111, v: 30, homeName: "Saved" });
    const cfg = initConfig("?home=222");
    expect(cfg.home).toBe(222);
    expect(cfg.v).toBe(30); // still from the saved config
    expect(cfg.lmax).toBe(DEFAULTS.lmax); // still from the defaults
  });

  it("persists a config that names a home so a bare URL keeps working", () => {
    initConfig("?home=8507000&homeName=Bern");
    expect(localStorage.getItem(CONFIG_KEY)).toContain("8507000");
    expect(initConfig("").home).toBe(8507000);
  });

  it("lets the saved settings slice override the URL", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ arrow: "north", rankMode: "homeBy", homeBy: "18:00" }),
    );
    const cfg = initConfig("?arrow=heading&rankMode=earliest&home=1");
    expect(cfg.arrow).toBe("north");
    expect(cfg.rankMode).toBe("homeBy");
    expect(cfg.homeBy).toBe("18:00");
  });
});

describe("updateSettings", () => {
  it("changes the effective config, persists it and notifies listeners", () => {
    initConfig("?home=8507000");
    const seen: string[] = [];
    const off = onConfigChange((cfg) => seen.push(cfg.arrow));
    updateSettings({ arrow: "north" });
    expect(getConfig().arrow).toBe("north");
    expect(seen).toEqual(["north"]);
    expect(localStorage.getItem(SETTINGS_KEY)).toContain("north");
    off();
    updateSettings({ arrow: "heading" });
    expect(seen).toEqual(["north"]);
  });

  it("leaves the rest of the config alone", () => {
    initConfig("?home=8507000&v=40");
    updateSettings({ rankMode: "homeBy", homeBy: "19:15" });
    expect(getConfig()).toMatchObject({ home: 8507000, v: 40, rankMode: "homeBy", homeBy: "19:15" });
  });

  it("clears back to the URL and saved config", () => {
    initConfig("?home=8507000&arrow=north");
    updateSettings({ arrow: "heading" });
    clearSettings();
    expect(getConfig().arrow).toBe("north");
  });
});

describe("defaultHomeBy", () => {
  it("is three hours out, rounded to a quarter of an hour", () => {
    const now = new Date(2026, 4, 16, 14, 38).getTime();
    expect(defaultHomeBy(now)).toBe("17:45");
  });
});
