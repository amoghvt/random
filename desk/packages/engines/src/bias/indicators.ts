/** Candle helpers. Every read is bounded by `now`; a bar stamped after `now` is never used. */
import { DAY, TF_MS, type Candle } from '@desk/contracts';
import { tradingAgeMs } from './calendar';
import type { CandleSet } from './types';

export const barEnd = (c: Candle, now: number): number => Math.min(c.t + TF_MS[c.tf], now);
export const clip = (bars: Candle[] | undefined, now: number): Candle[] => {
  if (!bars || bars.length === 0) return [];
  let n = bars.length;
  while (n > 0 && bars[n - 1]!.t > now) n--;
  return n === bars.length ? bars : bars.slice(0, n);
};
/** Fresh = last bar closed no more than 3 bar-lengths of trading time ago (weekends and holidays do not count). */
export const isFresh = (c: Candle | undefined, now: number): boolean => !!c && tradingAgeMs(barEnd(c, now), now) <= 3 * TF_MS[c.tf];
export const pct = (a: number, b: number): number => (a / b - 1) * 100;

/** EMA seeded with the SMA of the first `period` values; NaN before that. Null when there are too few values. */
export function emaSeries(xs: number[], period: number): number[] | null {
  if (xs.length < period) return null;
  const k = 2 / (period + 1);
  const out = new Array<number>(xs.length).fill(NaN);
  let e = 0;
  for (let i = 0; i < period; i++) e += xs[i]!;
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < xs.length; i++) { e = xs[i]! * k + e * (1 - k); out[i] = e; }
  return out;
}
/** Mean true range of the last `period` bars. */
export function atr(bars: Candle[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const b = bars[i]!, p = bars[i - 1]!.c;
    sum += Math.max(b.h - b.l, Math.abs(b.h - p), Math.abs(b.l - p));
  }
  return sum / period;
}

/**
 * One series as of `now`: the freshest price (15m, then 1h, then the daily close) and the completed
 * daily closes before it. `stale` means nothing in the set is inside 3x its cadence.
 */
export interface View {
  cur: number; asOf: number; basis: '15m' | '1h' | '1d'; stale: boolean;
  /** Completed daily bars strictly before `cur`. */
  refBars: Candle[];
  /** Close n completed daily bars back. */
  ref(n: number): number | null;
  /** Price `ms` before `asOf` from the intraday series; null when only daily data is fresh. */
  ago(ms: number): number | null;
  /** Value at an instant: the open of the intraday bar containing it, or the close of the bar that ended just before. */
  at(t: number): number | null;
}
export function view(set: CandleSet | undefined, now: number): View | null {
  if (!set) return null;
  const m15 = clip(set.m15, now), h1 = clip(set.h1, now), d1 = clip(set.d1, now);
  const intra = isFresh(m15.at(-1), now) ? m15 : isFresh(h1.at(-1), now) ? h1 : null;
  const dLast = d1.at(-1);
  const curBar = intra?.at(-1) ?? dLast ?? [m15.at(-1), h1.at(-1)].filter((c): c is Candle => !!c).sort((a, b) => b.t - a.t)[0];
  if (!curBar) return null;
  const asOf = barEnd(curBar, now);
  const refBars = d1.filter((c) => c !== curBar && c.t + DAY <= asOf);
  const series = intra ?? (m15.length ? m15 : h1);
  const tol = (c: Candle): number => 3 * TF_MS[c.tf];
  const at = (t: number): number | null => {
    for (let i = series.length - 1; i >= 0; i--) {
      const c = series[i]!;
      if (c.t <= t && t < c.t + TF_MS[c.tf]) return c.o;
      if (c.t + TF_MS[c.tf] <= t) return t - (c.t + TF_MS[c.tf]) <= tol(c) ? c.c : null;
    }
    return null;
  };
  return {
    cur: curBar.c, asOf, basis: curBar.tf === '15m' ? '15m' : curBar.tf === '1h' ? '1h' : '1d',
    stale: !intra && !isFresh(dLast, now),
    refBars,
    ref: (n) => refBars.at(-n)?.c ?? null,
    ago: (ms) => {
      if (!intra) return null;
      const target = asOf - ms;
      for (let i = intra.length - 1; i >= 0; i--) {
        const c = intra[i]!, end = c.t + TF_MS[c.tf];
        if (end <= target) return target - end <= tol(c) ? c.c : null;
      }
      return null;
    },
    at,
  };
}
