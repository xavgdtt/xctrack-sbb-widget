// In-widget settings overlay: plain DOM, absolutely positioned over the SVG.
// XCTrack's web widget only becomes interactive after a long press, so ordinary
// click handlers are enough.
//
// The look follows render.ts rather than the web: the same black/white grounds,
// the same font stack and tracking, SBB red used only for the selected option and
// the close bar, SBB greys for everything else, hairline rules instead of cards,
// and square-ish corners. Sizes scale from min(w, h) exactly as the SVG does, so
// the four rows fit a 360x160 widget without scrolling while each stays at least
// MIN_TOUCH px tall.

import { defaultHomeBy, getConfig, updateSettings } from "./config";
import { FONT_STACK } from "./render";
import { formatHHMM, parseHHMM, roundToMinutes } from "./time";
import type { Config } from "./types";

/** Handle returned by `createOverlay`. */
export interface Overlay {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Re-read the config and size and repaint (call after an external change). */
  sync(): void;
  destroy(): void;
}

const STEP_MIN = 15;

/** Minimum touch target, per the platform guidelines and cold fingers. */
const MIN_TOUCH = 40;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The type ramp, derived from the widget's short side like render.ts does. */
interface Metrics {
  labelF: number;
  btnF: number;
  timeF: number;
  pad: number;
  gap: number;
  labelW: number;
  stepW: number;
}

function metrics(w: number, h: number): Metrics {
  const s = Math.max(80, Math.min(w, h));
  const labelF = clamp(s * 0.062, 7, 14);
  return {
    labelF,
    btnF: clamp(s * 0.085, 10, 18),
    timeF: clamp(s * 0.14, 14, 30),
    pad: Math.max(3, s * 0.032),
    gap: Math.max(3, s * 0.022),
    labelW: Math.round(labelF * 6.6),
    stepW: Math.round(clamp(w * 0.16, MIN_TOUCH + 6, 96)),
  };
}

function css(theme: "dark" | "light", m: Metrics): string {
  // The render.ts palette, so the overlay and the widget are the same object.
  const dark = theme !== "light";
  const bg = dark ? "#000000" : "#FFFFFF";
  const fg = dark ? "#FFFFFF" : "#000000";
  const muted = dark ? "#B7B7B7" : "#666969";
  const rule = dark ? "#444444" : "#D2D2D2";
  const accent = "#EB0000";
  const r1 = (v: number): string => (Math.round(v * 10) / 10).toString();
  return `
.xsbt-ov{position:absolute;inset:0;z-index:10;background:${bg};color:${fg};
  font:700 ${r1(m.btnF)}px/1.2 ${FONT_STACK};letter-spacing:-.012em;
  overflow:hidden;overscroll-behavior:contain;-webkit-tap-highlight-color:transparent}
.xsbt-ov *{box-sizing:border-box}
.xsbt-in{display:flex;flex-direction:column;height:100%}
.xsbt-row{flex:1 1 0;min-height:${MIN_TOUCH}px;display:flex;align-items:stretch}
/* An inset shadow, not a border: the rule must not eat a pixel of the 40 px row. */
.xsbt-row+.xsbt-row{box-shadow:inset 0 1px 0 ${rule}}
.xsbt-lab{flex:0 0 ${m.labelW}px;display:flex;align-items:center;white-space:nowrap;
  padding-left:${r1(m.pad)}px;
  color:${muted};font-size:${r1(m.labelF)}px;font-weight:800;letter-spacing:.11em;
  text-transform:uppercase}
/* Options are full-height cells split by hairlines, like the widget's cell dividers:
   no pills, no cards, and the whole cell is the touch target. */
.xsbt-btn{flex:1 1 0;border:0;border-left:1px solid ${rule};border-radius:0;
  background:transparent;color:${muted};font:inherit;font-size:${r1(m.btnF)}px;
  letter-spacing:.06em;text-transform:uppercase;cursor:pointer;padding:0 ${r1(m.gap)}px;
  display:flex;align-items:center;justify-content:center;user-select:none;white-space:nowrap}
.xsbt-btn[aria-pressed="true"]{background:${accent};color:#FFFFFF}
.xsbt-step{flex:0 0 ${m.stepW}px;font-variant-numeric:tabular-nums}
.xsbt-time{flex:1 1 auto;border-left:1px solid ${rule};display:flex;align-items:center;
  justify-content:center;color:${fg};font-size:${r1(m.timeF)}px;font-weight:800;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.xsbt-dim{opacity:.38}
.xsbt-close{flex:0 0 ${MIN_TOUCH}px;min-height:${MIN_TOUCH}px;border:0;border-radius:0;
  background:${accent};color:#FFFFFF;font:inherit;font-size:${r1(m.btnF)}px;font-weight:800;
  letter-spacing:.11em;text-transform:uppercase;cursor:pointer}
.xsbt-hide{display:none}
`;
}

interface Seg<T extends string> {
  value: T;
  label: string;
}

/**
 * Build the settings overlay inside `host` (which must be positioned). It is
 * created hidden; `open()` shows it. Changes go straight to `updateSettings`,
 * and `onChange` fires afterwards so the caller can re-render the widget.
 */
export function createOverlay(host: HTMLElement, onChange?: (cfg: Config) => void): Overlay {
  const doc = host.ownerDocument;
  const root = doc.createElement("div");
  root.className = "xsbt-ov xsbt-hide";
  const style = doc.createElement("style");
  const inner = doc.createElement("div");
  inner.className = "xsbt-in";
  root.append(style, inner);
  host.appendChild(root);

  /** Theme + size the current stylesheet was written for. */
  let styledFor: string | null = null;
  /** Home-by target as epoch ms while the overlay is open; null until first used. */
  let homeByMs: number | null = null;

  const button = (label: string, onClick: () => void, extraClass = ""): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "xsbt-btn" + (extraClass ? " " + extraClass : "");
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  const segRow = <T extends string>(
    label: string,
    segs: readonly Seg<T>[],
    apply: (v: T) => void,
  ): { row: HTMLDivElement; paint: (active: T) => void } => {
    const row = doc.createElement("div");
    row.className = "xsbt-row";
    const lab = doc.createElement("div");
    lab.className = "xsbt-lab";
    lab.textContent = label;
    row.appendChild(lab);
    const buttons = segs.map((s) => {
      const b = button(s.label, () => apply(s.value));
      row.appendChild(b);
      return b;
    });
    return {
      row,
      paint: (active: T) => {
        segs.forEach((s, i) => buttons[i]?.setAttribute("aria-pressed", String(s.value === active)));
      },
    };
  };

  const mode = segRow(
    "mode",
    [
      { value: "earliest", label: "earliest" },
      { value: "homeBy", label: "home by" },
    ] as const,
    (v) => {
      if (v === "homeBy") {
        const hb = getConfig().homeBy ?? defaultHomeBy();
        homeByMs = parseHHMM(hb) ?? Date.now();
        commit({ rankMode: "homeBy", homeBy: formatHHMM(homeByMs) });
      } else {
        commit({ rankMode: "earliest" });
      }
    },
  );

  // home-by time: -15 / HH:MM / +15
  const timeRow = doc.createElement("div");
  timeRow.className = "xsbt-row";
  const timeLab = doc.createElement("div");
  timeLab.className = "xsbt-lab";
  timeLab.textContent = "home by";
  const timeVal = doc.createElement("div");
  timeVal.className = "xsbt-time";
  const minus = button("−15", () => nudge(-STEP_MIN), "xsbt-step");
  const plus = button("+15", () => nudge(STEP_MIN), "xsbt-step");
  timeRow.append(timeLab, minus, timeVal, plus);

  const arrow = segRow(
    "arrow",
    [
      { value: "heading", label: "heading" },
      { value: "north", label: "north" },
    ] as const,
    (v) => commit({ arrow: v }),
  );

  const close = doc.createElement("button");
  close.type = "button";
  close.className = "xsbt-close";
  close.textContent = "close";
  close.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    api.close();
  });

  inner.append(mode.row, timeRow, arrow.row, close);

  function nudge(deltaMin: number): void {
    const base = homeByMs ?? parseHHMM(getConfig().homeBy ?? defaultHomeBy()) ?? Date.now();
    homeByMs = roundToMinutes(base + deltaMin * 60_000, STEP_MIN);
    commit({ rankMode: "homeBy", homeBy: formatHHMM(homeByMs) });
  }

  function commit(partial: Parameters<typeof updateSettings>[0]): void {
    const cfg = updateSettings(partial);
    paint(cfg);
    onChange?.(cfg);
  }

  function paint(cfg: Config): void {
    const w = host.clientWidth || root.clientWidth || 360;
    const h = host.clientHeight || root.clientHeight || 160;
    const key = `${cfg.mode}|${Math.round(w)}x${Math.round(h)}`;
    if (styledFor !== key) {
      styledFor = key;
      style.textContent = css(cfg.mode, metrics(w, h));
    }
    mode.paint(cfg.rankMode);
    arrow.paint(cfg.arrow);
    timeVal.textContent = cfg.homeBy ?? defaultHomeBy();
    timeRow.classList.toggle("xsbt-dim", cfg.rankMode !== "homeBy");
  }

  const api: Overlay = {
    open(): void {
      paint(getConfig());
      root.classList.remove("xsbt-hide");
      paint(getConfig()); // now that it is laid out, the measured size is real
    },
    close(): void {
      root.classList.add("xsbt-hide");
    },
    toggle(): void {
      if (api.isOpen()) api.close();
      else api.open();
    },
    isOpen(): boolean {
      return !root.classList.contains("xsbt-hide");
    },
    sync(): void {
      if (api.isOpen()) paint(getConfig());
      else styledFor = null;
    },
    destroy(): void {
      root.remove();
    },
  };
  paint(getConfig());
  return api;
}
