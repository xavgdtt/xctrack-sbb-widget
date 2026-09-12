import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../src/clock";
import type { Fix } from "../src/types";

const WALL = new Date(2026, 4, 16, 15, 0, 0).getTime();
const FLIGHT = new Date(2025, 6, 3, 12, 30, 0).getTime();

function fix(over: Partial<Fix> = {}): Fix {
  return { lat: 46.7, lon: 7.9, alt: 2400, speedKmh: 35, track: 90, t: WALL, ...over };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the widget clock", () => {
  it("runs on wall clock until a fix reports a time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(WALL);
    const clock = createClock();
    expect(clock.nowMs()).toBe(WALL);
    clock.sync(fix({ reportedT: null }));
    expect(clock.offsetMs()).toBe(0);
    expect(clock.nowMs()).toBe(WALL);
  });

  it("shifts onto the reported time and keeps ticking between fixes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(WALL);
    const clock = createClock();
    clock.sync(fix({ reportedT: FLIGHT }));
    expect(clock.nowMs()).toBe(FLIGHT);
    vi.setSystemTime(WALL + 20_000);
    expect(clock.nowMs()).toBe(FLIGHT + 20_000);
  });

  it("falls back to wall clock when a later source reports no time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(WALL);
    const clock = createClock();
    clock.sync(fix({ reportedT: FLIGHT }));
    clock.sync(fix({ reportedT: null }));
    expect(clock.nowMs()).toBe(WALL);
  });
});
