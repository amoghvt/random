/**
 * Historical reaction table. All numbers come from the candles passed in; a null means the data does not cover it.
 *
 * Definitions (T = scheduled release time, all moves in percent of the reference price):
 * - 5m resolution (used when a 5m bar closes at T and a 5m bar opens at T):
 *     reference P0 = close of the last 5m bar closed at or before T
 *     m5  = close of the 5m bar opened at T vs P0;  m15 = price at T+15m vs P0;  h1 = price at T+60m vs P0
 * - 1h resolution (older releases): P0 = open of the hourly bar containing T; h1 = close of the last hourly bar opened
 *   before T+60m vs P0. Exact for on-the-hour releases (FOMC); for an :30 release the window is T-30m to T+90m. m5 is null.
 * - closePct = close-to-close: price at the 16:00 ET cash close after T vs price at the previous session's 16:00 ET
 *   cash close (intraday bars; daily bars as a last resort, which settle at 17:00 ET).
 * - firstMoveReversed = sign(m5) is opposite to sign(cash close - P0). False when either is zero. Null without m5.
 */
import { DAY, HOUR, MIN, TF_MS, dayKey, fromZoned, round, zoned } from '@desk/contracts';
import type { CalendarEvent, Candle, EventCode } from '@desk/contracts';
import type { CandlesByTf, HistoricalReactionEx, RateReaction } from './types';

/** Close of the last bar that closed at or before `t`, if that bar closed no more than `maxAgeMs` earlier. */
export function priceAt(candles: Candle[], t: number, maxAgeMs: number): number | null {
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = candles[mid]!;
    if (c.t + TF_MS[c.tf] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  const c = candles[best]!;
  return t - (c.t + TF_MS[c.tf]) <= maxAgeMs ? c.c : null;
}

const barOpenedAt = (candles: Candle[], t: number): Candle | null => candles.find((c) => c.t === t) ?? null;
const barContaining = (candles: Candle[], t: number): Candle | null => candles.find((c) => c.t <= t && t < c.t + TF_MS[c.tf]) ?? null;

/** Epoch ms of the first weekday 16:00 ET strictly after `t`. */
export function cashCloseAfter(t: number): number {
  for (let i = 0; i < 7; i++) {
    const z = zoned(t + i * DAY);
    const close = fromZoned(z.year, z.month, z.day, 16, 0);
    if (close > t && z.weekday >= 1 && z.weekday <= 5) return close;
  }
  return t + DAY;
}
function cashCloseBefore(close: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const z = zoned(close - i * DAY + HOUR);
    if (z.weekday >= 1 && z.weekday <= 5) out.push(fromZoned(z.year, z.month, z.day, 16, 0));
  }
  return out;
}

const pct = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : round((a / b - 1) * 100, 3));

function closeToClose(candles: Candle[], closeT: number): { close: number | null; pct: number | null } {
  const tol = 15 * MIN;
  const close = priceAt(candles, closeT, tol);
  if (close === null) return { close: null, pct: null };
  for (const prevT of cashCloseBefore(closeT)) {
    const prev = priceAt(candles, prevT, tol);
    if (prev !== null) return { close, pct: pct(close, prev) };
  }
  return { close, pct: null };
}

function dailyCloseToClose(daily: Candle[], t: number): number | null {
  const day = dayKey(t);
  const i = daily.findIndex((c) => dayKey(c.t + 12 * HOUR) === day);
  return i > 0 ? pct(daily[i]!.c, daily[i - 1]!.c) : null;
}

export function reactionFor(event: Pick<CalendarEvent, 'time' | 'actual' | 'consensus'>, candles: CandlesByTf, instrument?: string): HistoricalReactionEx {
  const T = Date.parse(event.time);
  const surprise = event.actual !== null && event.consensus !== null ? round(event.actual - event.consensus, 4) : null;
  const m5c = candles['5m'] ?? [], h1c = candles['1h'] ?? [], d1c = candles['1d'] ?? [];
  const row: HistoricalReactionEx = {
    date: dayKey(T), time: event.time, instrument: instrument ?? m5c[0]?.symbol ?? h1c[0]?.symbol ?? d1c[0]?.symbol ?? '',
    actual: event.actual, consensus: event.consensus, surprise,
    m5Pct: null, m15Pct: null, h1Pct: null, closePct: null, firstMoveReversed: null, resolution: null,
  };
  const closeT = cashCloseAfter(T);
  const first = barOpenedAt(m5c, T);
  const p0five = priceAt(m5c, T, 10 * MIN);
  if (first && p0five !== null) {
    const cc = closeToClose(m5c, closeT);
    row.resolution = '5m';
    row.m5Pct = pct(first.c, p0five);
    row.m15Pct = pct(priceAt(m5c, T + 15 * MIN, 5 * MIN), p0five);
    row.h1Pct = pct(priceAt(m5c, T + 60 * MIN, 10 * MIN), p0five);
    row.closePct = cc.pct;
    if (row.m5Pct !== null && cc.close !== null) {
      const s1 = Math.sign(row.m5Pct), s2 = Math.sign(cc.close - p0five);
      row.firstMoveReversed = s1 !== 0 && s2 !== 0 && s1 !== s2;
    }
    return row;
  }
  const hour = barContaining(h1c, T);
  if (hour) {
    row.resolution = '1h';
    let end: Candle | null = null;
    for (const c of h1c) { if (c.t >= hour.t && c.t < T + 60 * MIN) end = c; else if (c.t >= T + 60 * MIN) break; }
    row.h1Pct = end ? pct(end.c, hour.o) : null;
    row.closePct = closeToClose(h1c, closeT).pct;
    return row;
  }
  const dcc = dailyCloseToClose(d1c, T);
  if (dcc !== null) { row.resolution = '1d'; row.closePct = dcc; }
  return row;
}

/**
 * One printed event per release time for a code, newest first. Where the feed gives several series the same code at the
 * same time (MoM and YoY), the MoM series is kept, then the provider's importance.
 */
export function canonicalEvents(events: CalendarEvent[], code: EventCode, before?: number): CalendarEvent[] {
  const rank = (e: CalendarEvent): number => (/mom|m\/m/i.test(e.name) ? 4 : /yoy|y\/y/i.test(e.name) ? 0 : 2) + (e.importance ?? -1);
  const byTime = new Map<string, CalendarEvent>();
  for (const e of events) {
    if (e.code !== code || e.actual === null || (before !== undefined && Date.parse(e.time) >= before)) continue;
    const cur = byTime.get(e.time);
    if (!cur || rank(e) > rank(cur)) byTime.set(e.time, e);
  }
  return [...byTime.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

/** The last `n` releases of `code` that have printed, newest first. */
export function buildHistory(code: EventCode, pastEvents: CalendarEvent[], candlesByTf: CandlesByTf, n = 8, before?: number): HistoricalReactionEx[] {
  return canonicalEvents(pastEvents, code, before)
    .slice(0, n)
    .map((e) => reactionFor(e, candlesByTf));
}

/**
 * 10Y yield reaction in bp from recorded US10Y candles (cash hours only; null outside them).
 * 5m: from the last bar closed before T to T+60m and to the last print of the day. 1h: open to close of the hourly bar containing T, and that open to the last print.
 */
export function buildRateHistory(code: EventCode, pastEvents: CalendarEvent[], us10y: CandlesByTf, n = 8, before?: number): RateReaction[] {
  const bp = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : round((a - b) * 100, 1));
  return canonicalEvents(pastEvents, code, before)
    .slice(0, n)
    .map((e) => {
      const T = Date.parse(e.time);
      const surprise = e.actual !== null && e.consensus !== null ? round(e.actual - e.consensus, 4) : null;
      const m5c = us10y['5m'] ?? [], h1c = us10y['1h'] ?? [];
      const closeT = cashCloseAfter(T);
      const p0five = priceAt(m5c, T, 10 * MIN);
      if (p0five !== null && barOpenedAt(m5c, T)) return { date: dayKey(T), surprise, h1Bp: bp(priceAt(m5c, T + 60 * MIN, 10 * MIN), p0five), closeBp: bp(priceAt(m5c, closeT, HOUR), p0five) };
      const hour = barContaining(h1c, T);
      return { date: dayKey(T), surprise, h1Bp: hour ? bp(hour.c, hour.o) : null, closeBp: hour ? bp(priceAt(h1c, closeT, 2 * HOUR), hour.o) : null };
    });
}
