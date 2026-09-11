// SVG rendering for the widget. `render()` is pure: it derives every dimension
// from the (w, h) it is handed and never measures the DOM, so the same call
// produces the same markup in a browser and in a test.
//
// Layout ported from docs/mockups/mockup.html; the palette and the detail
// ladder follow the SBB-inspired visual identity agreed after that mockup.

import { formatDuration, formatHHMM } from "./time";
import type { Pick as StopPick, RenderModel } from "./types";

/** Options that are not part of RenderModel but come from the user's config. */
export interface RenderOptions {
  /** Required glide ratio at or below which a stop is drawn green. */
  lsafe?: number;
  /** Required glide ratio at or below which a stop is drawn amber (red above). */
  lamber?: number;
}

/** `id` of the gear group. Hit-test with `target.closest('#' + GEAR_ID)`. */
export const GEAR_ID = "gear";

/**
 * Face stack standing in for SBB's proprietary typeface, which cannot be
 * shipped. Helvetica is the closest thing present on most devices.
 */
export const FONT_STACK = '"SBB", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif';

/* ---------- palette ---------- */

export interface Palette {
  bg: string;
  fg: string;
  /** Secondary text: units, labels, the role caption's backdrop grey. */
  muted: string;
  /** Tertiary text and separators between footer chips. */
  dim: string;
  /** Cell separator rules. */
  rule: string;
  /** SBB red. Gear, role labels, home-by marker, alarm state. */
  accent: string;
  green: string;
  amber: string;
  red: string;
  stale: string;
}

// SBB reds and greys; the glide-ratio traffic light uses SBB's status tones.
const SBB_RED = "#EB0000";

const PALETTE: Record<"dark" | "light", Palette> = {
  dark: {
    bg: "#000000",
    fg: "#FFFFFF",
    muted: "#B7B7B7",
    dim: "#767676",
    rule: "#444444",
    accent: SBB_RED,
    green: "#00973B",
    amber: "#FCBB00",
    red: SBB_RED,
    stale: "#FCBB00",
  },
  light: {
    bg: "#FFFFFF",
    fg: "#000000",
    muted: "#666969",
    dim: "#767676",
    rule: "#D2D2D2",
    accent: SBB_RED,
    green: "#00973B",
    amber: "#B27F00",
    red: SBB_RED,
    stale: "#B27F00",
  },
};

/* ---------- text metrics (font-independent estimate, no DOM) ---------- */

const CHAR_EM: Record<string, number> = {
  " ": 0.28,
  ".": 0.3,
  ",": 0.3,
  "·": 0.34,
  ":": 0.3,
  "→": 0.95,
  "…": 0.85,
  "-": 0.36,
  "/": 0.36,
  "(": 0.36,
  ")": 0.36,
};

function charEm(ch: string): number {
  const known = CHAR_EM[ch];
  if (known !== undefined) return known;
  if (ch >= "0" && ch <= "9") return 0.57;
  if (ch >= "A" && ch <= "Z") return 0.67;
  if (ch >= "a" && ch <= "z") return "iljt".indexOf(ch) >= 0 ? 0.3 : 0.55;
  return 0.56;
}

/** Width of `text` in em units for a bold sans-serif face. */
export function textEm(text: string): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em;
}

function textWidth(text: string, fontSize: number): number {
  return textEm(text) * fontSize;
}

/** Truncate with an ellipsis so the result fits `maxWidth` at `fontSize`. */
function truncate(text: string, fontSize: number, maxWidth: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  const ell = textWidth("…", fontSize);
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charEm(ch) * fontSize;
    if (w + cw + ell > maxWidth) break;
    out += ch;
    w += cw;
  }
  return out.trimEnd() + "…";
}

/* ---------- small helpers ---------- */

const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const r1 = (v: number): number => Math.round(v * 10) / 10;
const fmtKm = (km: number): string => km.toFixed(1) + " km";
const fmtL = (L: number): string => "L " + L.toFixed(1);

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;

/** Data age as `m:ss`, or `h:mm:ss` once it passes an hour. */
function fmtAge(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 3600) return Math.floor(s / 60) + ":" + pad2(s % 60);
  return Math.floor(s / 3600) + ":" + pad2(Math.floor((s % 3600) / 60)) + ":" + pad2(s % 60);
}

function glideColor(L: number, pal: Palette, lsafe: number, lamber: number): string {
  if (L <= lsafe) return pal.green;
  if (L <= lamber) return pal.amber;
  return pal.red;
}

/* ---------- svg primitives (string building) ---------- */

interface TextOpts {
  anchor?: "start" | "middle" | "end";
  weight?: number;
  tracking?: number;
}

function svgText(x: number, y: number, str: string, size: number, fill: string, opts?: TextOpts): string {
  const o = opts ?? {};
  const anchor = o.anchor ?? "start";
  const weight = o.weight ?? 700;
  const ls = o.tracking ? ` letter-spacing="${r1(o.tracking)}"` : "";
  return (
    `<text x="${r1(x)}" y="${r1(y)}" font-size="${r1(size)}" font-weight="${weight}" ` +
    `text-anchor="${anchor}" fill="${fill}"${ls}>${str}</text>`
  );
}

/** Glyph size as a fraction of the reserved box, so ring + north tick stay inside. */
const ARROW_GLYPH = 0.72;
const RING = 1.26;

/**
 * Direction arrow: a thick chevron rotated to `bearing` (already in screen
 * degrees, i.e. heading-relative or true north) inside a compass ring. With
 * `northMark` the ring gets a small "N", which is how the heading arrow mode
 * admits that it has no track and has fallen back to north-up.
 */
function svgArrow(
  cx: number,
  cy: number,
  size: number,
  bearing: number,
  color: string,
  pal: Palette,
  northMark: boolean,
): string {
  const r = size / 2;
  const a = (bearing * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const pts = ([[0, -1], [0.66, 0.62], [0, 0.24], [-0.66, 0.62]] as const)
    .map(([x, y]) => `${r1(cx + (x * ca - y * sa) * r)},${r1(cy + (x * sa + y * ca) * r)}`)
    .join(" ");
  let out = "";
  if (size >= 30) {
    const rr = r * RING;
    const tick = Math.max(1.6, size * 0.075);
    out +=
      `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(rr)}" fill="none" ` +
      `stroke="${pal.rule}" stroke-width="${r1(Math.max(1.4, size * 0.055))}"/>`;
    out +=
      `<line x1="${r1(cx)}" y1="${r1(cy - rr - tick * 0.2)}" x2="${r1(cx)}" y2="${r1(cy - rr + tick * 1.6)}" ` +
      `stroke="${pal.muted}" stroke-width="${r1(tick)}" stroke-linecap="round"/>`;
    if (northMark) {
      const nf = Math.max(7, size * 0.26);
      out += svgText(cx + rr * 0.72, cy - rr * 0.72, "N", nf, pal.muted, { anchor: "middle", weight: 800 });
    }
  } else if (northMark) {
    const nf = Math.max(6, size * 0.34);
    out += svgText(cx + r * 1.15, cy - r * 0.8, "N", nf, pal.muted, { anchor: "middle", weight: 800 });
  }
  out +=
    `<polygon points="${pts}" fill="${color}" stroke="${color}" ` +
    `stroke-width="${r1(Math.max(1.5, size * 0.09))}" stroke-linejoin="round"/>`;
  return out;
}

/* ---------- cell model ---------- */

/** Third text line of a cell: either the timetable or the home-by budget. */
export type CellLine3 =
  | { kind: "times"; dep: string; home: string }
  | { kind: "landBy"; landBy: string; left: string; urgent: boolean };

/** What one cell draws. Derived from a Pick by `toCell`, kept flat for layout. */
export interface Cell {
  role: string;
  name: string;
  distKm: number;
  L: number;
  /** Screen-space rotation of the arrow, degrees clockwise from up. */
  bearing: number;
  line3: CellLine3 | null;
}

/** Full text of a cell's third line, used for measuring and for the wide form. */
export function line3Text(l: CellLine3): string {
  return l.kind === "times"
    ? "dep " + l.dep + " → home " + l.home
    : "land by " + l.landBy + " (" + l.left + " left)";
}

/** Abbreviated third line for cells too narrow for the labelled form. */
export function line3Short(l: CellLine3): string {
  return l.kind === "times" ? l.dep + " → " + l.home : l.landBy + " · " + l.left;
}

/** Budget below this many minutes turns the home-by line red. */
const URGENT_MIN = 15;

function toCell(pick: StopPick, model: RenderModel): Cell {
  const c = pick.cand;
  const rel = model.arrow === "heading" && model.track !== null ? c.bearing - model.track : c.bearing;
  let line3: CellLine3 | null = null;
  if (!model.offline) {
    if (model.mode === "homeBy" && pick.landBy !== null && pick.budgetMin !== null) {
      line3 = {
        kind: "landBy",
        landBy: formatHHMM(pick.landBy),
        left: formatDuration(pick.budgetMin),
        urgent: pick.budgetMin < URGENT_MIN,
      };
    } else {
      const dep = pick.journey ? pick.journey.dep : c.earliestDep;
      const arr = pick.journey ? pick.journey.arr : c.arrivalEst;
      if (arr !== null) line3 = { kind: "times", dep: formatHHMM(dep), home: formatHHMM(arr) };
    }
  }
  return {
    role: pick.role.toUpperCase(),
    name: c.stop.n,
    distKm: c.distM / 1000,
    L: c.lreq,
    bearing: ((rel % 360) + 360) % 360,
    line3,
  };
}

/* ---------- detail ladder ---------- */

/**
 * One text line of a cell. Departure and arrival times outrank the stop name
 * and the role caption, so the small-cell ladder drops those first.
 */
export type LineSpec =
  | "name"
  | "stats"
  | "statsSmall"
  | "statsCompact"
  | "times"
  | "timesBig"
  | "timesShort"
  | "lOnly";

/** Font size relative to `fName`, and line advance relative to that font size. */
const SPEC: Record<LineSpec, { rel: number; lead: number }> = {
  name: { rel: 1.0, lead: 1.18 },
  stats: { rel: 0.92, lead: 1.22 },
  statsSmall: { rel: 0.8, lead: 1.26 },
  statsCompact: { rel: 1.0, lead: 1.18 },
  times: { rel: 0.76, lead: 1.3 },
  timesBig: { rel: 1.0, lead: 1.22 },
  timesShort: { rel: 1.0, lead: 1.22 },
  lOnly: { rel: 0.86, lead: 1.2 },
};

/** A rung of the ladder: which lines to draw, and whether the role fits too. */
export interface Plan {
  role: boolean;
  lines: readonly LineSpec[];
}

/**
 * Detail ladder when departure/arrival times exist, widest first. The times
 * survive to the last rung; the role caption and the stop name do not.
 */
export const LADDER_TIMED: readonly Plan[] = [
  { role: true, lines: ["name", "stats", "times"] },
  { role: false, lines: ["name", "stats", "times"] },
  { role: false, lines: ["timesBig", "statsSmall"] },
  { role: false, lines: ["timesShort", "lOnly"] },
];

/** Ladder when there is no timetable to show (offline, or no journey yet). */
export const LADDER_UNTIMED: readonly Plan[] = [
  { role: true, lines: ["name", "stats"] },
  { role: false, lines: ["name", "stats"] },
  { role: false, lines: ["statsCompact"] },
];

/** Smallest rendered line font, in user units, that a rung must still afford. */
export const MIN_LEGIBLE = 10.5;

/** Absolute floor for the last rung, below which text is drawn anyway. */
const FONT_FLOOR = 9;

/** The chosen rung plus the name-line font size every other line scales from. */
export interface Fit extends Plan {
  fName: number;
  /** Index into the ladder, 0 = fullest. Exposed for tests and debugging. */
  rung: number;
}

/** Widest line of `spec` across `cells`, in em units. */
function specEm(spec: LineSpec, cells: readonly Cell[]): number {
  let max = 0;
  for (const c of cells) {
    let t: string;
    switch (spec) {
      case "name":
        t = c.name;
        break;
      case "stats":
      case "statsSmall":
        t = fmtKm(c.distKm) + " · " + fmtL(c.L);
        break;
      case "statsCompact":
        t = fmtL(c.L) + " · " + fmtKm(c.distKm);
        break;
      case "times":
      case "timesBig":
        t = c.line3 ? line3Text(c.line3) : "";
        break;
      case "timesShort":
        t = c.line3 ? line3Short(c.line3) : "";
        break;
      case "lOnly":
        t = fmtL(c.L);
        break;
    }
    max = Math.max(max, textEm(t));
  }
  return max;
}

/**
 * Choose one rung and one font size for all cells at once, so they stay
 * visually uniform. `availH` is the height left for the text stack when no role
 * caption is drawn; `roleH` is what the caption would additionally consume.
 */
export function fitCell(cells: readonly Cell[], availW: number, availH: number, roleH = 0): Fit {
  const timed = cells.length > 0 && cells.every((c) => c.line3 !== null);
  const ladder = timed ? LADDER_TIMED : LADDER_UNTIMED;

  const sizeFor = (plan: Plan): number => {
    const h = Math.max(8, plan.role ? availH - roleH : availH);
    let wEm = 0;
    let hUnits = 0;
    let maxRel = 0;
    for (const spec of plan.lines) {
      const { rel, lead } = SPEC[spec];
      wEm = Math.max(wEm, specEm(spec, cells) * rel);
      hUnits += rel * lead;
      maxRel = Math.max(maxRel, rel);
    }
    const cap = plan.lines.length >= 3 ? 0.26 : plan.lines.length === 2 ? 0.34 : 0.52;
    return Math.min(availW / Math.max(0.001, wEm), h / hUnits, (h * cap) / maxRel, 64);
  };

  for (let i = 0; i < ladder.length; i++) {
    const plan = ladder[i];
    if (!plan) continue;
    const f = sizeFor(plan);
    const last = i === ladder.length - 1;
    if (last) return { ...plan, lines: plan.lines, fName: Math.max(FONT_FLOOR, f), rung: i };
    const minRel = Math.min(...plan.lines.map((s) => SPEC[s].rel));
    if (f * minRel >= MIN_LEGIBLE) return { ...plan, lines: plan.lines, fName: f, rung: i };
  }
  /* c8 ignore next */
  return { role: false, lines: ["statsCompact"], fName: FONT_FLOOR, rung: ladder.length - 1 };
}

/** Height of the text stack a `Fit` produces, in user units. */
export function stackHeight(fit: Fit): number {
  let h = 0;
  for (const spec of fit.lines) h += fit.fName * SPEC[spec].rel * SPEC[spec].lead;
  return h;
}

/* ---------- cell drawing ---------- */

/** Times set like an SBB departure board: bold numerals, muted labels. */
function timesMarkup(l: CellLine3, pal: Palette, short: boolean, width: number, f: number): string {
  const wide = !short && textWidth(line3Text(l), f) <= width;
  if (l.kind === "times") {
    const dep = `<tspan font-weight="800" fill="${pal.fg}">${esc(l.dep)}</tspan>`;
    const home = `<tspan font-weight="800" fill="${pal.fg}">${esc(l.home)}</tspan>`;
    return wide
      ? `<tspan fill="${pal.muted}">dep </tspan>${dep}<tspan fill="${pal.muted}"> → home </tspan>${home}`
      : `${dep}<tspan fill="${pal.muted}"> → </tspan>${home}`;
  }
  const strong = l.urgent ? pal.red : pal.fg;
  const soft = l.urgent ? pal.red : pal.muted;
  const when = `<tspan font-weight="800" fill="${strong}">${esc(l.landBy)}</tspan>`;
  return wide
    ? `<tspan fill="${soft}">land by </tspan>${when}<tspan fill="${soft}"> (${esc(l.left)} left)</tspan>`
    : `${when}<tspan fill="${soft}"> · ${esc(l.left)}</tspan>`;
}

function drawTextStack(
  x: number,
  yTop: number,
  width: number,
  cell: Cell,
  fit: Fit,
  anchor: "start" | "middle",
  pal: Palette,
  lsafe: number,
  lamber: number,
): string {
  const col = glideColor(cell.L, pal, lsafe, lamber);
  const tx = anchor === "middle" ? x + width / 2 : x;
  let out = "";
  let y = yTop;

  for (const spec of fit.lines) {
    const { rel, lead } = SPEC[spec];
    const f = fit.fName * rel;
    y += f * 0.8;
    let markup: string;
    switch (spec) {
      case "name":
        markup = esc(truncate(cell.name, f, width));
        break;
      case "stats":
      case "statsSmall":
        markup =
          `${esc(fmtKm(cell.distKm))}<tspan fill="${pal.muted}"> · </tspan>` +
          `<tspan fill="${col}" font-weight="800">${esc(fmtL(cell.L))}</tspan>`;
        break;
      case "statsCompact":
        markup =
          `<tspan fill="${col}" font-weight="800">${esc(fmtL(cell.L))}</tspan>` +
          `<tspan fill="${pal.muted}"> · </tspan>${esc(fmtKm(cell.distKm))}`;
        break;
      case "times":
      case "timesBig":
        markup = cell.line3 ? timesMarkup(cell.line3, pal, false, width, f) : "";
        break;
      case "timesShort":
        markup = cell.line3 ? timesMarkup(cell.line3, pal, true, width, f) : "";
        break;
      case "lOnly":
        markup = `<tspan fill="${col}" font-weight="800">${esc(fmtL(cell.L))}</tspan>`;
        break;
    }
    if (markup) out += svgText(tx, y, markup, f, pal.fg, { anchor });
    y += f * (lead - 0.8);
  }
  return out;
}

/** Shrink the role label until it fits `maxWidth` (tracking included). */
function fitRole(role: string, size: number, maxWidth: number): number {
  const em = textEm(role) + (role.length - 1) * 0.11;
  return Math.min(size, maxWidth / em);
}

function drawCellColumn(
  x: number,
  y: number,
  cw: number,
  ch: number,
  cell: Cell,
  fit: Fit,
  pad: number,
  roleF: number,
  pal: Palette,
  lsafe: number,
  lamber: number,
  northMark: boolean,
): string {
  const col = glideColor(cell.L, pal, lsafe, lamber);
  const arrow = Math.min(cw * 0.46, ch * 0.34);
  const roleH = fit.role ? roleF * 1.5 : 0;
  const blockH = arrow + roleH + stackHeight(fit);
  let cy = y + Math.max(pad * 0.6, (ch - blockH) / 2);

  let out = svgArrow(x + cw / 2, cy + arrow / 2, arrow * ARROW_GLYPH, cell.bearing, col, pal, northMark);
  cy += arrow;
  if (fit.role) {
    const rf = fitRole(cell.role, roleF, cw - 2 * pad);
    out += svgText(x + cw / 2, cy + rf, esc(cell.role), rf, pal.accent, {
      anchor: "middle",
      weight: 800,
      tracking: rf * 0.11,
    });
    cy += roleH;
  }
  out += drawTextStack(x + pad, cy, cw - 2 * pad, cell, fit, "middle", pal, lsafe, lamber);
  return out;
}

function drawCellRow(
  x: number,
  y: number,
  cw: number,
  ch: number,
  cell: Cell,
  fit: Fit,
  pad: number,
  roleF: number,
  pal: Palette,
  lsafe: number,
  lamber: number,
  northMark: boolean,
  /** Width kept clear on the right, for the gear in the top row. */
  reserveRight: number,
): string {
  const col = glideColor(cell.L, pal, lsafe, lamber);
  const aw = Math.min(cw * 0.26, ch * 1.0, 120);
  const roleH = fit.role ? roleF * 1.45 : 0;
  const arrow = Math.min(aw * 0.78, (ch - roleH) * 0.92);
  const acx = x + pad + aw / 2;
  const acy = y + (ch - roleH - arrow) / 2 + arrow / 2;

  let out = svgArrow(acx, acy, arrow * ARROW_GLYPH, cell.bearing, col, pal, northMark);
  if (fit.role) {
    const rf = fitRole(cell.role, roleF, aw + pad * 0.6);
    out += svgText(acx, acy + (arrow * ARROW_GLYPH * RING) / 2 + rf * 1.05, esc(cell.role), rf, pal.accent, {
      anchor: "middle",
      weight: 800,
      tracking: rf * 0.11,
    });
  }

  const tx = x + pad + aw + pad * 1.2;
  const tw = Math.max(20, x + cw - pad - reserveRight - tx);
  out += drawTextStack(tx, y + (ch - stackHeight(fit)) / 2, tw, cell, fit, "start", pal, lsafe, lamber);
  return out;
}

/* ---------- footer ---------- */

interface FooterPart {
  t: string;
  c: string;
}

/** Footer chips, left to right. Deliberately no terrain-check note (README only). */
export function footerParts(model: RenderModel, pal: Palette): FooterPart[] {
  const parts: FooterPart[] = [];
  const age = model.ageSec === null ? null : fmtAge(model.ageSec);
  if (model.stale) parts.push({ t: age ? "STALE " + age : "STALE", c: pal.stale });
  else if (age) parts.push({ t: "age " + age, c: pal.muted });
  if (model.offline) parts.push({ t: "OFFLINE", c: pal.stale });
  parts.push({ t: model.altSource.toUpperCase(), c: pal.muted });
  if (model.homeByLabel) parts.push({ t: model.homeByLabel, c: pal.accent });
  return parts;
}

function drawFooter(
  x: number,
  y: number,
  w: number,
  hFoot: number,
  model: RenderModel,
  f: number,
  pal: Palette,
): string {
  const parts = footerParts(model, pal);
  if (parts.length === 0) return "";
  const sepEm = textEm(" · ");
  let total = 0;
  parts.forEach((p, i) => {
    total += textEm(p.t) + (i ? sepEm : 0);
  });
  let size = f;
  const padX = w * 0.02;
  if (total * size > w - 2 * padX) size = (w - 2 * padX) / total;
  const baseline = y + hFoot / 2 + size * 0.36;
  let out =
    `<line x1="${r1(x)}" y1="${r1(y)}" x2="${r1(x + w)}" y2="${r1(y)}" ` +
    `stroke="${pal.rule}" stroke-width="${r1(Math.max(1, size * 0.09))}"/>`;
  let str = "";
  parts.forEach((p, i) => {
    if (i) str += `<tspan fill="${pal.dim}"> · </tspan>`;
    str += `<tspan fill="${p.c}">${esc(p.t)}</tspan>`;
  });
  out += svgText(x + w / 2, baseline, str, size, pal.muted, { anchor: "middle", weight: 700 });
  return out;
}

/* ---------- gear ---------- */

/** Icon box of the settings gear: 12% of the short side, never under 22 px. */
export function gearSize(w: number, h: number): number {
  return Math.max(22, Math.min(w, h) * 0.12);
}

/**
 * Settings gear in the top-right corner, in SBB red, with an invisible hit area
 * roughly twice its size so it stays tappable with gloves on.
 */
function drawGear(w: number, size: number, pad: number, pal: Palette): string {
  const cx = w - pad - size / 2;
  const cy = pad + size / 2;
  const rOuter = size * 0.5;
  const rInner = size * 0.34;
  const rHole = size * 0.15;
  const teeth = 8;
  const half = Math.PI / teeth / 2.2;
  let d = "";
  for (let i = 0; i < teeth; i++) {
    const a = (i * 2 * Math.PI) / teeth;
    const pts: string[] = [];
    for (const [r, da] of [
      [rInner, -half * 1.9],
      [rOuter, -half],
      [rOuter, half],
      [rInner, half * 1.9],
    ] as const) {
      pts.push(`${r1(cx + r * Math.cos(a + da))},${r1(cy + r * Math.sin(a + da))}`);
    }
    d += (i === 0 ? "M" : "L") + pts.join("L");
  }
  d += "Z";
  const hit = size * 2;
  return (
    `<g id="${GEAR_ID}" style="cursor:pointer">` +
    `<path d="${d}" fill="${pal.accent}" fill-rule="evenodd"/>` +
    `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(rHole)}" fill="${pal.bg}"/>` +
    `<rect x="${r1(cx - hit / 2)}" y="${r1(cy - hit / 2)}" width="${r1(hit)}" height="${r1(hit)}" fill="transparent"/>` +
    `</g>`
  );
}

/* ---------- message screen ---------- */

function drawMessage(w: number, h: number, text: string, pad: number, pal: Palette): string {
  const size = clamp(Math.min(h * 0.22, (w - 4 * pad) / Math.max(1, textEm(text))), 10, 72);
  return svgText(w / 2, h / 2 + size * 0.36, esc(text), size, pal.fg, { anchor: "middle", weight: 700 });
}

/* ---------- entry point ---------- */

/** Three columns above this aspect ratio, three rows below it. */
export const COLUMN_ASPECT = 1.5;

/** Whether the cells are laid out side by side (columns) or stacked (rows). */
export function isColumns(w: number, h: number): boolean {
  return w / h > COLUMN_ASPECT;
}

/**
 * Draw `model` into `svg` at exactly `w` x `h` user units. Replaces the whole
 * subtree, so event handlers must be delegated from `svg` itself (see GEAR_ID).
 */
export function render(svg: SVGSVGElement, model: RenderModel, w: number, h: number, opts?: RenderOptions): void {
  const lsafe = opts?.lsafe ?? 6;
  const lamber = opts?.lamber ?? 9;
  const pal = PALETTE[model.theme === "light" ? "light" : "dark"];
  const S = Math.min(w, h);
  const pad = Math.max(3, S * 0.032);
  const gs = gearSize(w, h);

  let body = `<rect x="0" y="0" width="${r1(w)}" height="${r1(h)}" fill="${pal.bg}"/>`;

  const cells = model.picks.map((p) => toCell(p, model));
  const message =
    model.message ?? (model.noFix ? "waiting for GPS" : cells.length === 0 ? "no stop in glide" : null);

  if (message !== null) {
    body += drawMessage(w, h, message, pad, pal);
    body += drawGear(w, gs, pad, pal);
    commit(svg, body, w, h);
    return;
  }

  const columns = isColumns(w, h);
  const n = cells.length;

  // Footer only if what is left still makes for legible cells.
  const footF = clamp(S * 0.075, 8, 18);
  let footH = footF * 1.95;
  const bodyH = h - footH;
  const showFooter = footF >= 8.5 && (columns ? bodyH >= S * 0.5 : bodyH / n >= 30) && footH / h <= 0.22;
  if (!showFooter) footH = 0;

  const roleF = clamp(S * 0.062, 7, 17);
  const usableH = h - footH;
  const northMark = model.arrow === "heading" && model.track === null;

  if (columns) {
    const cw = w / n;
    const arrow = Math.min(cw * 0.46, usableH * 0.34);
    const availH = Math.max(12, usableH - arrow - pad * 1.2);
    const fit = fitCell(cells, cw - 3.2 * pad, availH, roleF * 1.5);
    cells.forEach((c, i) => {
      body += drawCellColumn(i * cw, 0, cw, usableH, c, fit, pad, roleF, pal, lsafe, lamber, northMark);
      if (i)
        body +=
          `<line x1="${r1(i * cw)}" y1="${r1(pad)}" x2="${r1(i * cw)}" y2="${r1(usableH - pad)}" ` +
          `stroke="${pal.rule}" stroke-width="${r1(Math.max(1, S * 0.007))}"/>`;
    });
  } else {
    const ch = usableH / n;
    const aw = Math.min(w * 0.26, ch * 1.0, 120);
    // The gear sits over the top row, so every row is fitted to the width the
    // top row has left; that keeps the three rows visually uniform.
    const reserve = gs + pad;
    const tw = w - 2.2 * pad - aw - pad * 1.2 - reserve;
    const fit = fitCell(cells, Math.max(20, tw), Math.max(12, ch - pad * 1.0));
    cells.forEach((c, i) => {
      body += drawCellRow(0, i * ch, w, ch, c, fit, pad, roleF, pal, lsafe, lamber, northMark, i === 0 ? reserve : 0);
      if (i)
        body +=
          `<line x1="${r1(pad)}" y1="${r1(i * ch)}" x2="${r1(w - pad)}" y2="${r1(i * ch)}" ` +
          `stroke="${pal.rule}" stroke-width="${r1(Math.max(1, S * 0.005))}"/>`;
    });
  }

  if (showFooter) body += drawFooter(0, usableH, w, footH, model, footF, pal);
  body += drawGear(w, gs, pad, pal);
  commit(svg, body, w, h);
}

function commit(svg: SVGSVGElement, body: string, w: number, h: number): void {
  svg.setAttribute("viewBox", `0 0 ${r1(w)} ${r1(h)}`);
  svg.setAttribute("width", String(r1(w)));
  svg.setAttribute("height", String(r1(h)));
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("font-family", FONT_STACK);
  svg.setAttribute("letter-spacing", "-0.012em");
  svg.innerHTML = body;
}
