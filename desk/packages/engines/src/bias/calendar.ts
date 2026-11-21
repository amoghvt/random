/** US equity session calendar derived from the date alone (no feed): holidays, OpEx, horizon ends. */
import { DAY, dayKey, fromZoned, zoned, type Horizon } from '@desk/contracts';

type Ymd = [number, number, number];
const parse = (k: string): Ymd => k.split('-').map(Number) as Ymd;
const key = (y: number, m: number, d: number): string => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
export const addDays = (k: string, n: number): string => { const [y, m, d] = parse(k); return key(y, m, d + n); };
/** 0 = Sunday. */
export const weekdayOf = (k: string): number => { const [y, m, d] = parse(k); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

/** n-th (1-based) weekday of a month; n = -1 is the last. */
function nthWeekday(y: number, m: number, wd: number, n: number): string {
  if (n > 0) {
    const first = weekdayOf(key(y, m, 1));
    return key(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
  }
  const last = key(y, m + 1, 0);
  return addDays(last, -((weekdayOf(last) - wd + 7) % 7));
}
/** Gregorian Easter Sunday (anonymous algorithm). */
function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return key(y, month, day);
}
/** NYSE observance: Saturday -> Friday, Sunday -> Monday. */
function observed(k: string): string {
  const wd = weekdayOf(k);
  return wd === 6 ? addDays(k, -1) : wd === 0 ? addDays(k, 1) : k;
}

const holidayCache = new Map<number, Set<string>>();
/** NYSE full-day holidays for a year, as ET day keys. */
export function usMarketHolidays(year: number): Set<string> {
  const hit = holidayCache.get(year);
  if (hit) return hit;
  const out = new Set<string>([
    nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), addDays(easter(year), -2), nthWeekday(year, 5, 1, -1),
    observed(key(year, 6, 19)), observed(key(year, 7, 4)), nthWeekday(year, 9, 1, 1), thanksgiving(year), observed(key(year, 12, 25)),
  ]);
  // New Year's Day on a Saturday is not observed on the prior Friday.
  const ny = key(year, 1, 1);
  if (weekdayOf(ny) !== 6) out.add(observed(ny));
  holidayCache.set(year, out);
  return out;
}
export const thanksgiving = (year: number): string => nthWeekday(year, 11, 4, 4);
export const isHoliday = (k: string): boolean => usMarketHolidays(parse(k)[0]).has(k);
export function isTradingDay(k: string): boolean {
  const wd = weekdayOf(k);
  return wd >= 1 && wd <= 5 && !isHoliday(k);
}
export function nextTradingDay(k: string): string {
  let d = addDays(k, 1);
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}
export function addTradingDays(k: string, n: number): string {
  let d = k;
  for (let i = 0; i < n; i++) d = nextTradingDay(d);
  return d;
}
/** 13:00 ET closes: the day after Thanksgiving, Christmas Eve, and July 3 when both it and July 4 are weekdays. */
export function isEarlyClose(k: string): boolean {
  const [y] = parse(k);
  if (!isTradingDay(k)) return false;
  if (k === addDays(thanksgiving(y), 1) || k === key(y, 12, 24)) return true;
  return k === key(y, 7, 3) && weekdayOf(key(y, 7, 4)) >= 1 && weekdayOf(key(y, 7, 4)) <= 5;
}
/** Epoch ms of the cash close on an ET day. */
export function cashClose(k: string): number {
  const [y, m, d] = parse(k);
  return fromZoned(y, m, d, isEarlyClose(k) ? 13 : 16, 0);
}
/** The session a call made at `now` trades: today before the close on a trading day, otherwise the next trading day. */
export function sessionDay(now: number): string {
  const today = dayKey(now);
  return isTradingDay(today) && now < cashClose(today) ? today : nextTradingDay(today);
}
/** Intraday: this session's cash close. Swing: the close 3 trading days on. Position: 10 trading days on. */
export function horizonEnd(now: number, horizon: Horizon): number {
  const s = sessionDay(now);
  return cashClose(addTradingDays(s, horizon === 'intraday' ? 0 : horizon === 'swing' ? 3 : 10));
}

const weekStart = (k: string): string => addDays(k, -((weekdayOf(k) + 6) % 7));
/** Monthly options expiration: the third Friday (moved to Thursday when that Friday is a holiday). */
export function opexDay(y: number, m: number): string {
  const f = nthWeekday(y, m, 5, 3);
  return isHoliday(f) ? addDays(f, -1) : f;
}
export interface DayTags { weekday: number; opexWeek: boolean; opexDay: boolean; monthEnd: boolean; holidayWeek: boolean; thanksgivingWeek: boolean; preLongWeekend: boolean }
export function dayTags(k: string): DayTags {
  const [y, m] = parse(k);
  const opex = opexDay(y, m);
  const mon = weekStart(k);
  const week = [0, 1, 2, 3, 4].map((i) => addDays(mon, i));
  const next = nextTradingDay(k);
  const [ny, nm] = parse(next), [n2y, n2m] = parse(nextTradingDay(next));
  return {
    weekday: weekdayOf(k),
    opexWeek: weekStart(opex) === mon, opexDay: opex === k,
    // Last two trading days of the month.
    monthEnd: ny !== y || nm !== m || n2y !== y || n2m !== m,
    holidayWeek: week.some(isHoliday),
    thanksgivingWeek: week.includes(thanksgiving(y)),
    // The next session is 4 or more calendar days away.
    preLongWeekend: (Date.parse(next) - Date.parse(k)) / DAY >= 4,
  };
}
export const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** "Fri 16:00 ET" style stamp. */
export function etStamp(t: number | string): string {
  const z = zoned(t);
  return `${WEEKDAY[z.weekday]} ${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')} ET`;
}
/** Elapsed ms between two instants, not counting weekend days and full market holidays (ET). */
export function tradingAgeMs(from: number, now: number): number {
  if (now <= from) return 0;
  if (now - from > 30 * DAY) return now - from;
  let closed = 0;
  for (let k = dayKey(from); ; k = addDays(k, 1)) {
    const [y, m, d] = parse(k);
    const start = fromZoned(y, m, d, 0, 0);
    if (start >= now) break;
    if (!isTradingDay(k)) {
      const [y2, m2, d2] = parse(addDays(k, 1));
      closed += Math.max(0, Math.min(now, fromZoned(y2, m2, d2, 0, 0)) - Math.max(from, start));
    }
  }
  return now - from - closed;
}
