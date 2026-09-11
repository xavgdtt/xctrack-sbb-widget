import { describe, expect, it } from "vitest";
import {
  ceilToMinute,
  dayType,
  easterSunday,
  formatDate,
  formatDuration,
  formatHHMM,
  isSwissHoliday,
  parseHHMM,
  roundToMinutes,
} from "../src/time";

const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();

describe("ceilToMinute", () => {
  it("rounds up to the next whole minute", () => {
    expect(ceilToMinute(at(2026, 5, 1, 10, 30) + 1)).toBe(at(2026, 5, 1, 10, 31));
  });

  it("leaves an exact minute alone", () => {
    expect(ceilToMinute(at(2026, 5, 1, 10, 30))).toBe(at(2026, 5, 1, 10, 30));
  });
});

describe("formatting", () => {
  it("prints local HH:MM and YYYY-MM-DD", () => {
    expect(formatHHMM(at(2026, 5, 1, 7, 5))).toBe("07:05");
    expect(formatDate(at(2026, 5, 1))).toBe("2026-05-01");
  });

  it("prints durations as hours and minutes", () => {
    expect(formatDuration(65)).toBe("1h05");
    expect(formatDuration(45)).toBe("45min");
  });

  it("rounds to a quarter hour", () => {
    expect(formatHHMM(roundToMinutes(at(2026, 5, 1, 16, 38), 15))).toBe("16:45");
  });
});

describe("parseHHMM", () => {
  it("resolves against today when the time is still ahead", () => {
    const now = at(2026, 5, 1, 12, 0);
    expect(parseHHMM("19:30", now)).toBe(at(2026, 5, 1, 19, 30));
  });

  it("rolls over to tomorrow when the time has passed", () => {
    const now = at(2026, 5, 1, 22, 0);
    expect(parseHHMM("06:15", now)).toBe(at(2026, 5, 2, 6, 15));
  });

  it("rejects nonsense", () => {
    expect(parseHHMM("25:00", at(2026, 5, 1))).toBeNull();
    expect(parseHHMM("later", at(2026, 5, 1))).toBeNull();
  });
});

describe("Swiss holidays", () => {
  it("computes Easter Sunday", () => {
    expect(formatDate(easterSunday(2026).getTime())).toBe("2026-04-05");
    expect(formatDate(easterSunday(2027).getTime())).toBe("2027-03-28");
  });

  it("covers the nationwide holidays of 2026", () => {
    const holidays = [
      [1, 1], // New Year
      [4, 3], // Good Friday
      [4, 6], // Easter Monday
      [5, 14], // Ascension
      [5, 25], // Whit Monday
      [8, 1], // National Day
      [12, 25],
      [12, 26],
    ] as const;
    for (const [m, d] of holidays) {
      expect(isSwissHoliday(at(2026, m, d)), `${m}-${d}`).toBe(true);
    }
  });

  it("does not treat an ordinary working day as a holiday", () => {
    expect(isSwissHoliday(at(2026, 5, 13))).toBe(false);
  });
});

describe("dayType", () => {
  it("separates weekdays, Saturday and Sunday", () => {
    expect(dayType(at(2026, 5, 13))).toBe(0); // Wednesday
    expect(dayType(at(2026, 5, 16))).toBe(1); // Saturday
    expect(dayType(at(2026, 5, 17))).toBe(2); // Sunday
  });

  it("treats a weekday holiday as a Sunday", () => {
    expect(dayType(at(2026, 8, 1))).toBe(2); // 1 August, a Saturday in 2026
    expect(dayType(at(2026, 12, 25))).toBe(2); // Christmas, a Friday
  });
});
