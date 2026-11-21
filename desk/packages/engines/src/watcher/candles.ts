/** Candle utilities for the chart watcher. Pure: no clock, no I/O. */
import { TF_MS, dayKey, fromZoned, isUsCashSession, zoned, type Candle, type Timeframe } from '@desk/contracts';

const etMidnight = (t: number): number => {
  const z = zoned(t);
  return fromZoned(z.year, z.month, z.day);
};

/** Roll lower-timeframe candles (normally 1m) up to `tf`. Intraday buckets are clock-aligned; '1d' is the ET calendar day. Missing minutes are simply absent. */
export function aggregate(candles: Candle[], tf: Timeframe): Candle[] {
  const size = TF_MS[tf];
  const out: Candle[] = [];
  let cur: Candle | undefined;
  for (const k of candles) {
    const b = tf === '1d' ? etMidnight(k.t) : Math.floor(k.t / size) * size;
    if (cur && cur.t === b) {
      cur.h = Math.max(cur.h, k.h); cur.l = Math.min(cur.l, k.l); cur.c = k.c; cur.v += k.v;
    } else {
      cur = { symbol: k.symbol, tf, t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, source: k.source };
      out.push(cur);
    }
  }
  return out;
}

/** Candles whose period has fully elapsed at `now`. Detectors never see a forming candle. */
export function closedCandles(candles: Candle[], now: number): Candle[] {
  let n = candles.length;
  while (n > 0) {
    const k = candles[n - 1]!;
    if (k.t + TF_MS[k.tf] <= now) break;
    n--;
  }
  return n === candles.length ? candles : candles.slice(0, n);
}

/** EMA seeded with the SMA of the first `period` values; null until then. */
export function ema(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(values.length).fill(null);
  if (values.length < period) return out;
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i]!;
  let e = acc / period;
  out[period - 1] = e;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Wilder ATR. True range uses the previous close, so gaps count. null for the first `period` candles. */
export function atr(candles: Candle[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(candles.length).fill(null);
  let acc = 0, a = 0;
  for (let i = 1; i < candles.length; i++) {
    const k = candles[i]!, pc = candles[i - 1]!.c;
    const tr = Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
    if (i <= period) {
      acc += tr;
      if (i === period) { a = acc / period; out[i] = a; }
    } else {
      a = (a * (period - 1) + tr) / period;
      out[i] = a;
    }
  }
  return out;
}

export type SessionName = 'cash' | 'et_day' | 'globex';
/** [from, to) epoch ms of a session for an ET date 'YYYY-MM-DD'. cash 09:30-16:00; et_day 00:00-24:00; globex 18:00 the evening before to 17:00. */
export function sessionBounds(day: string, session: SessionName): { from: number; to: number } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  if (session === 'cash') return { from: fromZoned(y, m, d, 9, 30), to: fromZoned(y, m, d, 16, 0) };
  if (session === 'et_day') return { from: fromZoned(y, m, d, 0, 0), to: fromZoned(y, m, d + 1, 0, 0) };
  return { from: fromZoned(y, m, d - 1, 18, 0), to: fromZoned(y, m, d, 17, 0) };
}
export function sessionSlice(candles: Candle[], day: string, session: SessionName = 'cash'): Candle[] {
  const { from, to } = sessionBounds(day, session);
  return candles.filter((k) => k.t >= from && k.t < to);
}
export const etDay = (t: number): string => dayKey(t);
export const sessionOf = (t: number): 'cash' | 'overnight' => (isUsCashSession(t) ? 'cash' : 'overnight');

export interface Pivot { i: number; t: number; type: 'high' | 'low'; level: number; /** Index of the candle whose close confirms the fractal. */ confirmedI: number }

/** Williams fractals: a high above the `n` highs on its left and not below the `n` on its right (mirrored for lows). Known only at the close of candle i + n. */
export function fractals(c: Candle[], n = 2): Pivot[] {
  const out: Pivot[] = [];
  for (let i = n; i < c.length - n; i++) {
    let hi = true, lo = true;
    for (let k = 1; k <= n && (hi || lo); k++) {
      if (!(c[i]!.h > c[i - k]!.h && c[i]!.h >= c[i + k]!.h)) hi = false;
      if (!(c[i]!.l < c[i - k]!.l && c[i]!.l <= c[i + k]!.l)) lo = false;
    }
    if (hi) out.push({ i, t: c[i]!.t, type: 'high', level: c[i]!.h, confirmedI: i + n });
    if (lo) out.push({ i, t: c[i]!.t, type: 'low', level: c[i]!.l, confirmedI: i + n });
  }
  return out;
}

export interface Leg { from: Pivot; to: Pivot; /** +1 up leg, -1 down leg. */ dir: 1 | -1; size: number; /** Leg size in ATRs measured at the leg's start. */ atrMult: number }

/**
 * Legs between alternating fractals, built causally in confirmation order: a new pivot of the opposite type
 * closes a leg; a more extreme pivot of the same type extends it (recorded as a further leg from the same origin).
 */
export function buildLegs(pivots: Pivot[], atrs: Array<number | null>): Leg[] {
  const alt: Pivot[] = [];
  const legs: Leg[] = [];
  const push = (from: Pivot | undefined, to: Pivot): void => {
    const a = from ? atrs[from.i] : null;
    if (!from || a == null || a <= 0) return;
    const size = Math.abs(to.level - from.level);
    legs.push({ from, to, dir: to.type === 'high' ? 1 : -1, size, atrMult: size / a });
  };
  for (const p of pivots) {
    const last = alt[alt.length - 1];
    if (!last || last.type !== p.type) { alt.push(p); push(last, p); }
    else if (p.type === 'high' ? p.level > last.level : p.level < last.level) { alt[alt.length - 1] = p; push(alt[alt.length - 2], p); }
  }
  return legs;
}

/** Mean volume per candle over [a, b], ignoring zero-volume candles (Yahoo reports 0 on some bars). null when every candle is zero. */
export function meanVolume(c: Candle[], a: number, b: number): { mean: number | null; zero: number; n: number } {
  let s = 0, k = 0, zero = 0;
  for (let i = Math.max(0, a); i <= Math.min(c.length - 1, b); i++) {
    if (c[i]!.v > 0) { s += c[i]!.v; k++; } else zero++;
  }
  return { mean: k ? s / k : null, zero, n: k + zero };
}
