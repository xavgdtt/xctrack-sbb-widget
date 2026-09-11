// In-widget settings overlay: plain DOM, absolutely positioned over the SVG.
// XCTrack's web widget only becomes interactive after a long press, so ordinary
// click handlers are enough; every control is at least 44 px tall for gloves.

import { defaultHomeBy, getConfig, updateSettings } from "./config";
import { formatHHMM, parseHHMM, roundToMinutes } from "./time";
import type { Config } from "./types";

/** Handle returned by `createOverlay`. */
export interface Overlay {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Re-read the config and repaint the controls (call after an external change). */
  sync(): void;
  destroy(): void;
}

const STEP_MIN = 15;

/** Minimum touch target, per the platform guidelines and cold fingers. */
const TOUCH = 44;

function css(theme: "dark" | "light"): string {
  // SBB palette: red accent, black/white grounds, SBB greys.
  const dark = theme !== "light";
  const bg = dark ? "#000000" : "#FFFFFF";
  const fg = dark ? "#FFFFFF" : "#000000";
  const rule = dark ? "#444444" : "#D2D2D2";
  const chip = dark ? "#212121" : "#F6F6F6";
  const accent = "#EB0000";
  const on = accent;
  const onFg = "#FFFFFF";
  return `
.xsbt-ov{position:absolute;inset:0;z-index:10;background:${bg};color:${fg};
  font:600 16px/1.25 "SBB","Helvetica Neue",Helvetica,Arial,system-ui,sans-serif;letter-spacing:-.012em;
  overflow:auto;overscroll-behavior:contain;-webkit-tap-highlight-color:transparent}
.xsbt-ov *{box-sizing:border-box}
.xsbt-in{padding:10px 12px 14px;display:flex;flex-direction:column;gap:8px;max-width:560px;margin:0 auto}
.xsbt-row{display:flex;align-items:center;gap:8px}
.xsbt-lab{flex:0 0 auto;min-width:72px;font-size:13px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;opacity:.65}
.xsbt-seg{display:flex;flex:1 1 auto;gap:6px}
.xsbt-btn{flex:1 1 0;min-height:${TOUCH}px;min-width:${TOUCH}px;border:2px solid ${rule};border-radius:8px;
  background:${chip};color:${fg};font:inherit;font-size:16px;cursor:pointer;padding:0 8px;
  display:flex;align-items:center;justify-content:center;user-select:none}
.xsbt-btn[aria-pressed="true"]{background:${on};border-color:${on};color:${onFg}}
.xsbt-btn:active{border-color:#C60018}
.xsbt-btn:disabled{opacity:.35;cursor:default}
.xsbt-time{flex:1 1 auto;text-align:center;font-size:26px;font-weight:800;font-variant-numeric:tabular-nums}
.xsbt-step{flex:0 0 ${TOUCH + 16}px}
.xsbt-close{position:sticky;bottom:0;min-height:${TOUCH}px;margin-top:4px;border:2px solid ${accent};
  border-radius:8px;background:${accent};color:#FFFFFF;font:inherit;font-size:17px;font-weight:700;cursor:pointer}
.xsbt-hide{display:none}
/* Short widgets cannot fit five 44 px rows; the panel scrolls and Close stays pinned. */
@media (max-height:280px){
  .xsbt-in{padding:6px 10px 8px;gap:6px}
  .xsbt-time{font-size:22px}
}
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

  let theme: "dark" | "light" | null = null;
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
    const seg = doc.createElement("div");
    seg.className = "xsbt-seg";
    const buttons = segs.map((s) => {
      const b = button(s.label, () => apply(s.value));
      seg.appendChild(b);
      return b;
    });
    row.append(lab, seg);
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

  const alt = segRow(
    "altitude",
    [
      { value: "gps", label: "GPS" },
      { value: "baro", label: "baro" },
    ] as const,
    (v) => commit({ alt: v }),
  );

  const close = doc.createElement("button");
  close.type = "button";
  close.className = "xsbt-close";
  close.textContent = "Close";
  close.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    api.close();
  });

  inner.append(mode.row, timeRow, arrow.row, alt.row, close);

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
    if (theme !== cfg.mode) {
      theme = cfg.mode;
      style.textContent = css(cfg.mode);
    }
    mode.paint(cfg.rankMode);
    arrow.paint(cfg.arrow);
    alt.paint(cfg.alt);
    const homeBy = cfg.homeBy ?? defaultHomeBy();
    timeVal.textContent = homeBy;
    const active = cfg.rankMode === "homeBy";
    timeRow.style.opacity = active ? "1" : "0.45";
    minus.disabled = false;
    plus.disabled = false;
  }

  const api: Overlay = {
    open(): void {
      paint(getConfig());
      root.classList.remove("xsbt-hide");
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
      else theme = null;
    },
    destroy(): void {
      root.remove();
    },
  };
  paint(getConfig());
  return api;
}
