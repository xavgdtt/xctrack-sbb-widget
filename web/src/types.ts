// Shared data model for the widget. Every other module imports these; the shapes
// are fixed by the project spec, so change them there first.

export interface Fix {
  lat: number;
  lon: number;
  alt: number;
  altSource: "baro" | "gps";
  speedKmh: number;
  track: number | null /* deg, bearingGps if moving else heading, null if unknown */;
  t: number /* epoch ms */;
}
export interface Stop {
  id: number;
  n: string;
  lat: number;
  lon: number;
  e: number;
  m: number;
}
export type Role = "safest" | "best" | "nearest";
export type Mode = "earliest" | "homeBy";
export interface Candidate {
  stop: Stop;
  distM: number;
  bearing: number /* deg true, from pilot to stop */;
  lreq: number;
  tFlyMin: number;
  earliestDep: number /* epoch ms */;
  travelEstMin: number | null;
  arrivalEst: number | null /* epoch ms */;
}
export interface Journey {
  dep: number;
  arr: number;
  transfers: number;
  categories: string[];
  fetchedAt: number;
  stale: boolean;
}
export interface Pick {
  role: Role;
  cand: Candidate;
  journey: Journey | null;
  landBy: number | null;
  budgetMin: number | null;
}
export interface Config {
  home: number;
  homeName: string;
  v: number;
  pack: number;
  walk: number;
  margin: number;
  lmax: number;
  lsafe: number;
  alt: "gps" | "baro";
  mode: "dark" | "light";
  refresh: number;
  maxRoute: number;
  arrow: "heading" | "north";
  rankMode: Mode;
  homeBy: string | null /* 'HH:MM' */;
  replay: string | null;
  speed: number;
}
export interface RenderModel {
  picks: Pick[];
  mode: Mode;
  homeByLabel: string | null /* 'home by 19:30' or 'missed 19:30' */;
  track: number | null;
  arrow: "heading" | "north";
  ageSec: number | null;
  stale: boolean;
  offline: boolean;
  altSource: "gps" | "baro";
  theme: "dark" | "light";
  noFix: boolean;
  message: string | null /* big centered text e.g. 'waiting for GPS' */;
}

// Mode bitmask used by stops.json.gz (`m`).
export const MODE_RAIL = 1;
export const MODE_BUS = 2;
export const MODE_TRAM = 4;
export const MODE_BOAT = 8;
export const MODE_CABLEWAY = 16;
export const MODE_METRO = 32;

/** A stop plus its index in stops.json.gz, which is what the per-home table is keyed by. */
export interface IndexedStop extends Stop {
  stopIdx: number;
}
