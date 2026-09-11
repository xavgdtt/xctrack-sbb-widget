// Widget entry point and main loop.
//
//   on every fix (~1 Hz): reachability -> ranking -> render  (no network)
//   every `refresh` s, or after moving > 2 km / > 300 m:      route candidates,
//                                                             rerank, render
//
// Everything that draws lives in render.ts; everything that talks to the network
// lives in transport.ts. This file only sequences them.

import { getConfig, initConfig, onConfigChange } from "./config";
import { haversineM } from "./geo";
import { createOverlay } from "./overlay";
import { rank } from "./rank";
import { buildCandidates } from "./reach";
import { GEAR_ID, render } from "./render";
import { loadStops, type StopIndex } from "./stops";
import { loadTable, type TravelTable } from "./table";
import { createTransportClient, type TransportClient } from "./transport";
import { parseHHMM } from "./time";
import { startLocationSource } from "./xctrack";
import type { Candidate, Config, Fix, Journey, RenderModel, Stop } from "./types";

/** Horizontal movement since the last routing cycle that forces a new one. */
const MOVE_TRIGGER_M = 2000;
/** Altitude change since the last routing cycle that forces a new one. */
const ALT_TRIGGER_M = 300;
/** A fix older than this means the GPS has dropped out. */
const FIX_TIMEOUT_MS = 30_000;

interface Loop {
  stop(): void;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function start(): Loop {
  const cfg0 = initConfig();
  const host = document.getElementById("app");
  if (!host) throw new Error("#app missing");
  host.textContent = "";
  document.documentElement.dataset["theme"] = cfg0.mode;

  const svg = el("svg");
  svg.style.display = "block";
  host.appendChild(svg);

  const overlay = createOverlay(host, () => draw());
  svg.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (target?.closest(`#${GEAR_ID}`)) overlay.toggle();
  });
  onConfigChange(() => {
    overlay.sync();
    recompute();
  });

  let w = host.clientWidth || window.innerWidth;
  let h = host.clientHeight || window.innerHeight;
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.contentRect;
      if (box.width > 0 && box.height > 0) {
        w = box.width;
        h = box.height;
      }
    }
    draw();
  });
  ro.observe(host);

  let stops: StopIndex | null = null;
  /** Set when the dataset could not be loaded; the widget can do nothing after that. */
  let fatal: string | null = null;
  let home: Stop | null = null;
  let table: TravelTable | null = null;
  let client: TransportClient | null = null;

  let fix: Fix | null = null;
  let candidates: Candidate[] = [];
  let journeys: Map<number, Journey> = new Map();
  let model: RenderModel = idleModel(cfg0, "loading stops…");

  /** Fix and time of the last completed routing cycle, for the refresh triggers. */
  let cycleFix: Fix | null = null;
  let cycleAt = 0;
  let cycleRunning = false;

  function draw(): void {
    const cfg = getConfig();
    render(svg, model, w, h, { lsafe: cfg.lsafe });
  }

  /** Cheap path: rebuild candidates and picks from the current fix, then draw. */
  function recompute(): void {
    const cfg = getConfig();
    if (fatal) {
      model = idleModel(cfg, fatal);
      draw();
      return;
    }
    if (!fix || !stops) {
      model = idleModel(cfg, fix ? "loading stops…" : "waiting for GPS");
      draw();
      return;
    }
    const now = Date.now();
    if (now - fix.t > FIX_TIMEOUT_MS) {
      model = idleModel(cfg, "GPS lost");
      draw();
      return;
    }
    candidates = buildCandidates(fix, stops, cfg, {
      home,
      travelEst: table ? (idx, dep) => table!.lookup(idx, dep) : null,
      now,
    });
    const homeByMs = cfg.homeBy ? parseHHMM(cfg.homeBy, now) : null;
    const result = rank({
      candidates,
      mode: cfg.rankMode,
      lsafe: cfg.lsafe,
      groundMin: cfg.pack + cfg.walk,
      homeByMs,
      journeys,
      now,
    });
    const offline = isOffline(client, journeys);
    model = {
      picks: result.picks,
      mode: result.mode,
      homeByLabel:
        cfg.rankMode === "homeBy" && cfg.homeBy
          ? (result.missedHomeBy ? "missed " : "home by ") + cfg.homeBy
          : null,
      track: fix.track,
      arrow: cfg.arrow,
      ageSec: cycleAt ? (now - cycleAt) / 1000 : null,
      stale: client ? client.isStale() : false,
      offline,
      altSource: fix.altSource,
      theme: cfg.mode,
      noFix: false,
      message: null,
    };
    draw();
  }

  /** Network path: route the best candidates, fold the journeys in, rerank. */
  async function cycle(): Promise<void> {
    if (cycleRunning || !client || !fix || candidates.length === 0) return;
    cycleRunning = true;
    const cfg = getConfig();
    const at = fix;
    try {
      const now = Date.now();
      const homeByMs = cfg.homeBy ? parseHHMM(cfg.homeBy, now) : null;
      const arrival = cfg.rankMode === "homeBy" && homeByMs !== null;
      const requests = routeTargets(candidates, model.picks.map((p) => p.cand), cfg.maxRoute).map(
        (c) => ({ stopId: c.stop.id, when: arrival ? (homeByMs ?? c.earliestDep) : c.earliestDep }),
      );
      const outcomes = await client.route(requests, { arrival });
      const next = new Map(client.allLastGood());
      for (const [stopId, outcome] of outcomes) {
        if (outcome.journey) next.set(stopId, outcome.journey);
        else if (outcome.noService) next.delete(stopId);
      }
      journeys = next;
      cycleFix = at;
      cycleAt = Date.now();
    } catch {
      // transport.ts already keeps the last good result and flags staleness.
    } finally {
      cycleRunning = false;
      recompute();
    }
  }

  function maybeCycle(): void {
    const cfg = getConfig();
    if (!fix || cycleRunning) return;
    const due =
      cycleFix === null ||
      Date.now() - cycleAt >= cfg.refresh * 1000 ||
      haversineM(fix.lat, fix.lon, cycleFix.lat, cycleFix.lon) > MOVE_TRIGGER_M ||
      Math.abs(fix.alt - cycleFix.alt) > ALT_TRIGGER_M;
    if (due) void cycle();
  }

  draw();

  const stopSource = startLocationSource(cfg0, (f) => {
    fix = f;
    recompute();
    maybeCycle();
  });

  const ticker = window.setInterval(() => {
    recompute();
    maybeCycle();
  }, 5000);

  void (async () => {
    const cfg = getConfig();
    try {
      stops = await loadStops();
      home = (cfg.home > 0 ? stops.byId(cfg.home) : undefined) ?? null;
    } catch {
      fatal = "stops unavailable";
      recompute();
      return;
    }
    if (cfg.home > 0) {
      client = createTransportClient({ homeId: cfg.home });
      table = await loadTable(cfg.home).catch(() => null);
    }
    recompute();
    maybeCycle();
  })();

  registerServiceWorker();

  return {
    stop(): void {
      ro.disconnect();
      stopSource();
      window.clearInterval(ticker);
      overlay.destroy();
    },
  };
}

/** A model with no picks, used for the big centred states. */
function idleModel(cfg: Config, message: string): RenderModel {
  return {
    picks: [],
    mode: cfg.rankMode,
    homeByLabel: null,
    track: null,
    arrow: cfg.arrow,
    ageSec: null,
    stale: false,
    offline: false,
    altSource: cfg.alt,
    theme: cfg.mode,
    noFix: true,
    message,
  };
}

/**
 * The picks first, then the next best candidates, up to `maxRoute` stops.
 * Candidates arrive sorted by estimated arrival, so the head is the near-front.
 */
function routeTargets(
  candidates: readonly Candidate[],
  picked: readonly Candidate[],
  maxRoute: number,
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<number>();
  for (const c of [...picked, ...candidates]) {
    if (out.length >= maxRoute) break;
    if (seen.has(c.stop.id)) continue;
    seen.add(c.stop.id);
    out.push(c);
  }
  return out;
}

/** Offline means: no live timetable to show, either the browser or the API says so. */
function isOffline(client: TransportClient | null, journeys: ReadonlyMap<number, Journey>): boolean {
  if (!client) return true;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return client.isStale() && journeys.size === 0;
}

function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    const url = new URL("sw.js", new URL(import.meta.env.BASE_URL, location.href));
    void navigator.serviceWorker.register(url, { type: "module" }).catch(() => {
      /* the widget works without it */
    });
  });
}

start();
