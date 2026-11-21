import { ageLabel, freshness, DAY, type Stamped } from '@desk/contracts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/** `{value, asOf, source, stale, age}` for the UI. Stale = older than 3x cadence; a missing datum is stale. */
export function stamped<T = number>(d: { value: T; asOf: string; source: string; cadenceSec: number } | null | undefined, now: number): Stamped<T> {
  if (!d) return { value: null, asOf: null, source: null, stale: true, age: null };
  return { value: d.value, asOf: d.asOf, source: d.source, stale: freshness(d, now) === 'stale', age: ageLabel(d.asOf, now) };
}

/** Whole days between a period end ('YYYY-MM-DD' or ISO) and now. */
export function lagDays(periodEnd: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(periodEnd.length === 10 ? `${periodEnd}T00:00:00Z` : periodEnd)) / DAY));
}

/** 13F-style lag line: "positions as of Sept 30, 52 days stale". */
export function lagText(periodEnd: string, now: number, noun = 'positions'): string {
  const d = new Date(periodEnd.length === 10 ? `${periodEnd}T00:00:00Z` : periodEnd);
  const days = lagDays(periodEnd, now);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${sameYear ? '' : `, ${d.getUTCFullYear()}`}`;
  return `${noun} as of ${date}, ${days} ${days === 1 ? 'day' : 'days'} stale`;
}
