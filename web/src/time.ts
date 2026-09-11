// Clock helpers. Everything the pilot sees is local time; the epoch-ms values that
// flow through the ranking code are plain `Date.now()` timestamps.

const MIN_MS = 60_000;

/** Round an epoch timestamp up to the next whole minute. */
export function ceilToMinute(ms: number): number {
  return Math.ceil(ms / MIN_MS) * MIN_MS;
}

/** Local wall-clock time as 'HH:MM'. */
export function formatHHMM(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** A duration in minutes as '1h05' or '45min'. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${pad2(m % 60)}` : `${m}min`;
}

/** Local date as 'YYYY-MM-DD' (the format transport.opendata.ch wants). */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Resolve 'HH:MM' against today's local date, rolling over to tomorrow when that
 * moment has already passed. Returns null if the string is not a valid time.
 */
export function parseHHMM(hhmm: string, now: number = Date.now()): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  const t = d.getTime();
  return t < now ? t + 24 * 60 * MIN_MS : t;
}

/** Epoch ms rounded to the nearest `step` minutes (used for the home-by default). */
export function roundToMinutes(ms: number, step: number): number {
  const s = step * MIN_MS;
  return Math.round(ms / s) * s;
}

/** Easter Sunday (Gregorian, anonymous algorithm) as a local midnight Date. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/**
 * Swiss nationwide public holidays: New Year, Good Friday, Easter Monday,
 * Ascension, Whit Monday, National Day, Christmas and St Stephen's Day.
 * Cantonal holidays are deliberately ignored — the timetable day type only needs
 * the days on which the whole country runs a Sunday service.
 */
export function isSwissHoliday(ms: number): boolean {
  const d = new Date(ms);
  const key = d.getMonth() * 100 + d.getDate();
  if (key === 0 * 100 + 1) return true; // 1 Jan
  if (key === 7 * 100 + 1) return true; // 1 Aug
  if (key === 11 * 100 + 25) return true; // 25 Dec
  if (key === 11 * 100 + 26) return true; // 26 Dec
  const easter = easterSunday(d.getFullYear()).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const offsetDays = Math.round((day - easter) / (24 * 60 * MIN_MS));
  return offsetDays === -2 || offsetDays === 1 || offsetDays === 39 || offsetDays === 50;
}

/** Timetable day type: 0 = Mon–Fri, 1 = Sat, 2 = Sun or national holiday. */
export function dayType(ms: number): 0 | 1 | 2 {
  const dow = new Date(ms).getDay();
  if (dow === 0 || isSwissHoliday(ms)) return 2;
  if (dow === 6) return 1;
  return 0;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
