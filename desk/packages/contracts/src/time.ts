/** Time helpers. All stored times are UTC ISO strings or epoch ms; ET is derived, never stored. */
export type ISO = string;
export const ET = 'America/New_York';

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number; }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a timezone. weekday: 0 = Sunday. */
export function zoned(t: number | Date | ISO, tz: string = ET): ZonedParts {
  const d = typeof t === 'number' ? new Date(t) : typeof t === 'string' ? new Date(t) : t;
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(d)) p[part.type] = part.value;
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour!, minute: +p.minute!, second: +p.second!, weekday: WD[p.weekday!] ?? 0 };
}

/** Epoch ms of a wall-clock time in a timezone (DST-safe). */
export function fromZoned(year: number, month: number, day: number, hour = 0, minute = 0, tz: string = ET): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const z = zoned(guess, tz);
    const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute);
    guess += Date.UTC(year, month - 1, day, hour, minute) - asUtc;
  }
  return guess;
}

/** 'YYYY-MM-DD' of the instant in tz. */
export function dayKey(t: number | Date | ISO, tz: string = ET): string {
  const z = zoned(t, tz);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}
/** 'HH:MM' of the instant in tz. */
export function hhmm(t: number | Date | ISO, tz: string = ET): string {
  const z = zoned(t, tz);
  return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}
export function minutesOfDay(t: number | Date | ISO, tz: string = ET): number {
  const z = zoned(t, tz);
  return z.hour * 60 + z.minute;
}
/** True inside [from, to) wall-clock 'HH:MM'; handles windows that wrap midnight. */
export function inWindow(t: number | Date | ISO, from: string, to: string, tz: string = ET): boolean {
  const m = minutesOfDay(t, tz);
  const [fh, fm] = from.split(':').map(Number) as [number, number];
  const [th, tm] = to.split(':').map(Number) as [number, number];
  const a = fh * 60 + fm, b = th * 60 + tm;
  return a <= b ? m >= a && m < b : m >= a || m < b;
}
/** US cash session 09:30-16:00 ET, Mon-Fri (holidays are the calendar feed's job). */
export function isUsCashSession(t: number | Date | ISO): boolean {
  const z = zoned(t, ET);
  return z.weekday >= 1 && z.weekday <= 5 && inWindow(t, '09:30', '16:00', ET);
}
/** "US hours" for loop cadence: 04:00-20:00 ET on weekdays. */
export function isUsHours(t: number | Date | ISO): boolean {
  const z = zoned(t, ET);
  return z.weekday >= 1 && z.weekday <= 5 && inWindow(t, '04:00', '20:00', ET);
}
export const iso = (t: number | Date): ISO => (typeof t === 'number' ? new Date(t) : t).toISOString();
export const ms = (t: ISO | number | Date): number => (typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : t.getTime());
export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
