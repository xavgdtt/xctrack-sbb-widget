// The widget clock. Every time the widget *computes* with — the "now" that
// earliest departures are measured from, the date and time sent to
// transport.opendata.ch, the home-by budget, the table's day type and hour
// bucket — must be the time the location source reports, not the phone's.
// XCTrack can be fed by an external vario or by its own track replay, and the
// IGC replay used in development is a recorded flight: in both cases the
// payload's own timestamp is the time the pilot is flying in.
//
// Elapsed-time rules (fix staleness, the refresh interval, cache TTLs) keep
// using wall-clock receive times; they measure how long ago something happened
// here, not when it happens in the flight.

import type { Fix } from "./types";

export interface Clock {
  /** Current time on the flight's clock, epoch ms. */
  nowMs(): number;
  /** Re-derive the clock from a fix. Sources reporting no time reset it to wall clock. */
  sync(fix: Fix): void;
  /** Reported time minus receive time of the last synced fix, in ms. Zero on wall clock. */
  offsetMs(): number;
}

/**
 * A clock that runs at wall-clock rate but is shifted onto the reported time of
 * the last fix, so it keeps ticking between fixes instead of freezing at the
 * last one. Under a replay sped up by `?speed=`, each fix re-shifts it, so the
 * clock jumps forward with the replay.
 */
export function createClock(): Clock {
  let offset = 0;
  return {
    nowMs: () => Date.now() + offset,
    sync(fix: Fix): void {
      offset = fix.reportedT == null ? 0 : fix.reportedT - fix.t;
    },
    offsetMs: () => offset,
  };
}
