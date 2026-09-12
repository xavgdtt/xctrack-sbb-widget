// Configuration: URL query params on top of the last saved config on top of the
// defaults, with the in-widget settings slice (written by the settings overlay)
// layered over all of it.

import type { Config, Mode } from "./types";
import { roundToMinutes, formatHHMM } from "./time";

/** The part of the config the in-widget settings overlay may change. */
export interface Settings {
  rankMode: Mode;
  homeBy: string | null;
  arrow: "heading" | "north";
}

export const CONFIG_KEY = "xsbt.config";
export const SETTINGS_KEY = "xsbt.settings";

export const DEFAULTS: Config = {
  home: 0,
  homeName: "",
  v: 34,
  pack: 10,
  walk: 5,
  margin: 150,
  lmax: 15,
  lsafe: 6,
  mode: "dark",
  refresh: 120,
  maxRoute: 8,
  arrow: "heading",
  rankMode: "earliest",
  homeBy: null,
  replay: null,
  speed: 1,
  debug: false,
};

const SETTINGS_KEYS: readonly (keyof Settings)[] = ["rankMode", "homeBy", "arrow"];

let current: Config = { ...DEFAULTS };
let base: Config = { ...DEFAULTS };
let settings: Partial<Settings> = {};
const listeners = new Set<(cfg: Config) => void>();

/**
 * Resolve the effective config and make it available to `getConfig()`.
 * `search` defaults to the current page's query string.
 */
export function initConfig(search?: string): Config {
  const query = search ?? (typeof location === "undefined" ? "" : location.search);
  base = { ...DEFAULTS, ...loadConfig(), ...parseQuery(query) };
  settings = loadSettings();
  current = { ...base, ...settings };
  if (base.home > 0) saveConfig(base);
  return current;
}

/** The effective config. Returns the defaults if `initConfig` has not run yet. */
export function getConfig(): Config {
  return current;
}

/** Apply a change from the settings overlay, persist it, and notify listeners. */
export function updateSettings(partial: Partial<Settings>): Config {
  for (const key of SETTINGS_KEYS) {
    if (!(key in partial)) continue;
    const value = partial[key];
    if (value === undefined) delete settings[key];
    else assignSetting(settings, key, value);
  }
  current = { ...base, ...settings };
  writeJSON(SETTINGS_KEY, settings);
  for (const cb of listeners) cb(current);
  return current;
}

/** Subscribe to settings changes. Returns an unsubscribe function. */
export function onConfigChange(cb: (cfg: Config) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Persist a config so a bare URL still works on the next load. */
export function saveConfig(cfg: Config): void {
  writeJSON(CONFIG_KEY, cfg);
}

/** The saved config, filtered to known keys and plausible values. */
export function loadConfig(): Partial<Config> {
  const raw = readJSON(CONFIG_KEY);
  return raw ? coerce(raw) : {};
}

/** The saved settings slice. */
export function loadSettings(): Partial<Settings> {
  const raw = readJSON(SETTINGS_KEY);
  if (!raw) return {};
  const coerced = coerce(raw);
  const out: Partial<Settings> = {};
  for (const key of SETTINGS_KEYS) {
    const value = coerced[key];
    if (value !== undefined) assignSetting(out, key, value);
  }
  return out;
}

/** Forget the settings overlay, falling back to the URL/saved config. */
export function clearSettings(): void {
  settings = {};
  current = { ...base };
  writeJSON(SETTINGS_KEY, settings);
  for (const cb of listeners) cb(current);
}

/** Default home-by target: now + 3 h rounded to a quarter hour, as 'HH:MM'. */
export function defaultHomeBy(now: number = Date.now()): string {
  return formatHHMM(roundToMinutes(now + 3 * 3600_000, 15));
}

/** Parse a query string (with or without a leading '?') into config overrides. */
export function parseQuery(search: string): Partial<Config> {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const raw: Record<string, string> = {};
  for (const [k, v] of params) raw[k] = v;
  return coerce(raw);
}

function coerce(raw: Record<string, unknown>): Partial<Config> {
  const out: Partial<Config> = {};
  const home = int(raw["home"]);
  if (home !== null && home > 0) out.home = home;
  if (typeof raw["homeName"] === "string" && raw["homeName"] !== "") {
    out.homeName = raw["homeName"];
  }
  const nums: readonly (keyof Config)[] = [
    "v",
    "pack",
    "walk",
    "margin",
    "lmax",
    "lsafe",
    "refresh",
    "maxRoute",
    "speed",
  ];
  for (const key of nums) {
    const n = num(raw[key]);
    if (n !== null && n > 0) (out as Record<string, unknown>)[key] = n;
  }
  // `alt` (the old GPS/baro altitude-source setting) is accepted and ignored, so
  // URLs built before the widget settled on GPS altitude still load.
  const mode = oneOf(raw["mode"], ["dark", "light"] as const);
  if (mode) out.mode = mode;
  const arrow = oneOf(raw["arrow"], ["heading", "north"] as const);
  if (arrow) out.arrow = arrow;
  const rankMode = oneOf(raw["rankMode"], ["earliest", "homeBy"] as const);
  if (rankMode) out.rankMode = rankMode;
  if (typeof raw["homeBy"] === "string" && /^\d{1,2}:\d{2}$/.test(raw["homeBy"])) {
    out.homeBy = raw["homeBy"];
  } else if (raw["homeBy"] === null) {
    out.homeBy = null;
  }
  if (typeof raw["replay"] === "string" && raw["replay"] !== "") {
    out.replay = raw["replay"];
  }
  const debug = raw["debug"];
  if (debug === true || debug === "1" || debug === "true") out.debug = true;
  return out;
}

function assignSetting<K extends keyof Settings>(
  target: Partial<Settings>,
  key: K,
  value: unknown,
): void {
  target[key] = value as Settings[K];
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function readJSON(key: string): Record<string, unknown> | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a storage quota error: the widget still works, it just forgets.
  }
}
