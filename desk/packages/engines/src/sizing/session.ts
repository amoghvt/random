/** ET session clocks for account rules: weekend locks, flatten-by times, daily snapshots. Pure. */
import { DAY, HOUR, MIN, fromZoned, hhmm, instrument, zoned, type AccountRules } from '@desk/contracts';

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DOW_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Globex reopen after the daily maintenance break and on Sunday, ET minutes of day. */
const CME_REOPEN_MIN = 18 * 60;

export function parseHHMM(s: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Bad HH:MM "${s}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}
/** 'Fri 20:00' -> weekday 5, 20:00. */
export function parseWeeklyET(s: string): { weekday: number; hour: number; minute: number } {
  const [d, t] = s.trim().split(/\s+/);
  const weekday = d === undefined ? undefined : DOW[d];
  if (weekday === undefined || t === undefined) throw new Error(`Bad weekly time "${s}", expected e.g. "Fri 20:00"`);
  return { weekday, ...parseHHMM(t) };
}
/** First instant at or after `t` that is HH:MM ET on one of `weekdays`. */
export function nextET(t: number, hour: number, minute: number, weekdays: number[]): number {
  const z = zoned(t);
  for (let d = 0; d <= 8; d++) {
    const cand = fromZoned(z.year, z.month, z.day + d, hour, minute);
    if (cand >= t && weekdays.includes(zoned(cand).weekday)) return cand;
  }
  throw new Error('nextET: no match inside 8 days');
}
export const etLabel = (t: number): string => `${DOW_NAME[zoned(t).weekday]} ${hhmm(t)} ET`;
export function durationLabel(msLeft: number): string {
  const m = Math.max(0, Math.round(msLeft / MIN));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

export interface LockWindow { from: number; to: number; inside: boolean }
/** The weekend lock that contains `t`, or the next one. null when the account has none or the instrument is exempt (crypto). */
export function weekendLockAt(rules: AccountRules, symbol: string, t: number): LockWindow | null {
  const lock = rules.session.weekendLock;
  if (!lock || instrument(symbol).kind === 'crypto') return null;
  const a = parseWeeklyET(lock.fromET), b = parseWeeklyET(lock.toET);
  const to = nextET(t + 1, b.hour, b.minute, [b.weekday]);
  const from = nextET(to - 7 * DAY + HOUR, a.hour, a.minute, [a.weekday]);
  return { from, to, inside: t >= from };
}
/** True when a position opened before the lock is still on when it starts. */
export function crossesWeekendLock(rules: AccountRules, symbol: string, entryAt: number, holdUntil: number): LockWindow | null {
  const w = weekendLockAt(rules, symbol, entryAt);
  return w && !w.inside && holdUntil > w.from ? w : null;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
/** Next flatten-by instant at or after `t` (weekdays), null when the account has none. */
export function nextFlatten(rules: AccountRules, t: number): number | null {
  if (!rules.session.flattenByET) return null;
  const f = parseHHMM(rules.session.flattenByET);
  return nextET(t, f.hour, f.minute, WEEKDAYS);
}
/** True between the flatten-by time and the 18:00 ET reopen, and over the weekend. */
export function inFlatWindow(rules: AccountRules, t: number): boolean {
  if (!rules.session.flattenByET) return false;
  const f = parseHHMM(rules.session.flattenByET);
  const z = zoned(t), m = z.hour * 60 + z.minute, flat = f.hour * 60 + f.minute;
  if (z.weekday === 6) return true;
  if (z.weekday === 0) return m < CME_REOPEN_MIN;
  if (z.weekday === 5) return m >= flat;
  return m >= flat && m < CME_REOPEN_MIN;
}
/** Next daily-loss snapshot (every day at snapshotET), null when the rule has no snapshot clock. */
export function nextSnapshot(rules: AccountRules, t: number): number | null {
  const s = rules.dailyLoss?.snapshotET;
  if (!s) return null;
  const p = parseHHMM(s);
  return nextET(t + 1, p.hour, p.minute, [0, 1, 2, 3, 4, 5, 6]);
}
/** Most recent snapshot at or before `t`. */
export function lastSnapshot(rules: AccountRules, t: number): number | null {
  const s = rules.dailyLoss?.snapshotET;
  if (!s) return null;
  const p = parseHHMM(s);
  return nextET(t - DAY + 1, p.hour, p.minute, [0, 1, 2, 3, 4, 5, 6]);
}
