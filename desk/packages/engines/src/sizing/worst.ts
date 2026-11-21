/** Worst plausible adverse move over a holding window (spec section 7, steps 1 and 5). Pure. */
import { DAY, HOUR, MIN, TF_MS, dayKey, fmtNum, hhmm, instrument, ms, percentile, type AccountRules, type Candle, type Catalyst } from '@desk/contracts';
import { crossesWeekendLock, etLabel } from './session';

/** 1-minute ATR: simple mean of the true range over the last 14 closed 1m candles. */
export const ATR_LOOKBACK = 14;
export const ATR_SCALP_MULT = 2.5;
/** Windows shorter than this are intraday scalps and get the ATR test. */
export const SCALP_WINDOW_MIN = 15;
export const P95_SESSIONS = 60;
export const WEEKEND_GAP_MIN_PCT = 3;
/** A 1m ATR older than this is flagged in the sentence. */
export const ATR_STALE_MS = 15 * MIN;

export interface CandleSet { m1: Candle[]; m15: Candle[]; h1: Candle[]; d1: Candle[] }

/** Mean true range of the last `lookback` candles at or before `asOf`. null with fewer than lookback + 1 candles. */
export function atr(candles: Candle[], lookback: number = ATR_LOOKBACK, asOf?: number): { value: number; asOf: number } | null {
  const cs = asOf === undefined ? candles : candles.filter((c) => c.t <= asOf);
  if (cs.length < lookback + 1) return null;
  let sum = 0;
  for (let i = cs.length - lookback; i < cs.length; i++) {
    const c = cs[i]!, prev = cs[i - 1]!.c;
    sum += Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  }
  return { value: sum / lookback, asOf: cs[cs.length - 1]!.t };
}

/** Trade date of a candle: the 18:00 ET reopen belongs to the next session. */
const tradeDate = (t: number): string => dayKey(t + 6 * HOUR);

/**
 * Largest excursion from the window open, either side, wicks included, for every rolling window of `bars` candles
 * inside the last `sessions` trade dates. Percent. Windows that straddle a data gap (weekend, halt) are skipped on intraday frames.
 */
export function windowMoves(candles: Candle[], bars: number, sessions: number = P95_SESSIONS): { moves: number[]; sessions: number } {
  if (candles.length === 0) return { moves: [], sessions: 0 };
  const dates = [...new Set(candles.map((c) => tradeDate(c.t)))].slice(-sessions);
  const first = dates[0]!;
  const cs = candles.filter((c) => tradeDate(c.t) >= first);
  const tfMs = TF_MS[cs[0]!.tf];
  const intraday = tfMs < DAY;
  const moves: number[] = [];
  for (let i = 0; i + bars <= cs.length; i++) {
    const a = cs[i]!, b = cs[i + bars - 1]!;
    if (intraday && b.t - a.t > (bars - 1) * tfMs * 3 + tfMs) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = i; j < i + bars; j++) { hi = Math.max(hi, cs[j]!.h); lo = Math.min(lo, cs[j]!.l); }
    moves.push((Math.max(hi - a.o, a.o - lo) / a.o) * 100);
  }
  return { moves, sessions: dates.length };
}

/** Absolute Friday-close to next-open gaps from daily candles, percent, oldest first. */
export function weekendGaps(d1: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < d1.length; i++) {
    const a = d1[i - 1]!, b = d1[i]!;
    if (b.t - a.t >= 2.5 * DAY && b.t - a.t <= 4.5 * DAY) out.push((Math.abs(b.o - a.c) / a.c) * 100);
  }
  return out;
}

/** Tier-1 catalysts that land inside [from, to] and touch the instrument. Macro Tier-1 is market-wide. */
export function tier1InWindow(catalysts: Catalyst[], symbol: string, from: number, to: number): Catalyst[] {
  const under = instrument(symbol).priceSymbol;
  return catalysts
    .filter((c) => c.tier === 1 && c.status !== 'resolved' && ms(c.scheduledAt) >= from && ms(c.scheduledAt) <= to)
    .filter((c) => (c.code !== 'EARNINGS' && c.code !== 'IPO') || c.symbol === symbol || c.instruments.some((s) => s === symbol || s === under))
    .sort((a, b) => ms(a.scheduledAt) - ms(b.scheduledAt));
}

export interface WorstMoveInput {
  instrument: string; price: number; entryAt: number; holdUntil: number; now: number;
  catalysts: Catalyst[]; candles: CandleSet;
  /** Account rules, for the weekend lock. Omit for a rule-free read. */
  rules?: AccountRules;
}
export type WorstBasis = 'p95_window' | 'tier1_implied' | 'atr_scalp' | 'weekend_gap';
export interface WorstMove {
  /** Percent of price; NaN when nothing could be measured. */
  pct: number; pts: number; basis: WorstBasis; text: string;
  windowMin: number;
  components: {
    p95Pct: number | null; p95Tf: string | null; p95Bars: number | null; p95Sessions: number; p95Samples: number;
    tier1ImpliedPct: number | null; atr1m: number | null; atr1mAsOf: number | null; atrScalpPct: number | null;
    weekendGapPct: number | null; weekendGapP95Pct: number | null; weekendGapSamples: number;
  };
  /** The Tier-1 catalyst inside the window with the largest implied move (or the first, when none has one). */
  catalyst: Catalyst | null;
}

export function worstPlausibleMove(input: WorstMoveInput): WorstMove {
  const { price, entryAt, holdUntil, now, candles } = input;
  const windowMs = Math.max(MIN, holdUntil - entryAt);
  const windowMin = windowMs / MIN;
  const upTo = <T extends Candle>(cs: T[]): T[] => cs.filter((c) => c.t <= now);

  // (a) 95th percentile of the window-length move over the last 60 sessions.
  const frames: Array<{ tf: string; cs: Candle[]; bars: number; ok: boolean }> = [
    { tf: '15m', cs: upTo(candles.m15), bars: Math.ceil(windowMin / 15), ok: windowMin <= 240 },
    { tf: '1h', cs: upTo(candles.h1), bars: Math.ceil(windowMin / 60), ok: windowMin <= 2880 },
    { tf: '1d', cs: upTo(candles.d1), bars: Math.ceil(windowMs / DAY), ok: true },
  ];
  let p95Pct: number | null = null, p95Tf: string | null = null, p95Bars: number | null = null, p95Sessions = 0, p95Samples = 0;
  for (const f of frames) {
    if (!f.ok) continue;
    const r = windowMoves(f.cs, Math.max(1, f.bars));
    if (r.moves.length < 20) continue;
    p95Pct = percentile(r.moves, 0.95); p95Tf = f.tf; p95Bars = Math.max(1, f.bars); p95Sessions = r.sessions; p95Samples = r.moves.length;
    break;
  }

  // (b) implied move of any Tier-1 catalyst inside the window.
  const t1 = tier1InWindow(input.catalysts, input.instrument, entryAt, holdUntil);
  const withMove = t1.filter((c) => c.impliedMovePct !== null).sort((a, b) => (b.impliedMovePct ?? 0) - (a.impliedMovePct ?? 0));
  const catalyst = withMove[0] ?? t1[0] ?? null;
  const tier1ImpliedPct = withMove[0]?.impliedMovePct ?? null;

  // (c) 2.5x the current 1-minute ATR for intraday scalps.
  const a = atr(candles.m1, ATR_LOOKBACK, now);
  const scalp = windowMin < SCALP_WINDOW_MIN;
  const atrScalpPct = scalp && a ? ((ATR_SCALP_MULT * a.value) / price) * 100 : null;

  // Weekend lock: size against the gap distribution, 3% minimum.
  const lock = input.rules ? crossesWeekendLock(input.rules, input.instrument, entryAt, holdUntil) : null;
  const gaps = lock ? weekendGaps(upTo(candles.d1)).slice(-104) : [];
  const weekendGapP95Pct = gaps.length > 0 ? percentile(gaps, 0.95) : null;
  const weekendGapPct = lock ? Math.max(WEEKEND_GAP_MIN_PCT, weekendGapP95Pct ?? 0) : null;

  const options: Array<{ basis: WorstBasis; pct: number }> = [];
  if (p95Pct !== null) options.push({ basis: 'p95_window', pct: p95Pct });
  if (tier1ImpliedPct !== null) options.push({ basis: 'tier1_implied', pct: tier1ImpliedPct });
  if (atrScalpPct !== null) options.push({ basis: 'atr_scalp', pct: atrScalpPct });
  if (weekendGapPct !== null) options.push({ basis: 'weekend_gap', pct: weekendGapPct });
  const top = options.sort((x, y) => y.pct - x.pct)[0];
  const components = {
    p95Pct, p95Tf, p95Bars, p95Sessions, p95Samples, tier1ImpliedPct, atr1m: a?.value ?? null, atr1mAsOf: a?.asOf ?? null, atrScalpPct,
    weekendGapPct, weekendGapP95Pct, weekendGapSamples: gaps.length,
  };
  if (!top) {
    return { pct: NaN, pts: NaN, basis: 'p95_window', windowMin, components, catalyst,
      text: `No candles on file for ${input.instrument}: worst move not measured, no size.` };
  }
  const pts = (top.pct / 100) * price;
  const move = `${top.pct.toFixed(2)}% (${fmtNum(pts, pts < 10 ? 2 : 0)} pts)`;
  const win = windowMin < 120 ? `${Math.round(windowMin)}m` : windowMin < 2880 ? `${(windowMin / 60).toFixed(1)}h` : `${(windowMs / DAY).toFixed(1)}d`;
  const p95Note = p95Pct === null ? 'no p95 on file' : `p95 of ${win} windows ${p95Pct.toFixed(2)}% (${p95Tf}, ${p95Sessions} sessions${p95Sessions < P95_SESSIONS ? ` of ${P95_SESSIONS} wanted` : ''})`;
  let text: string;
  if (top.basis === 'weekend_gap' && lock) {
    const lockText = input.rules?.session.weekendLock ? `${input.rules.session.weekendLock.fromET} to ${input.rules.session.weekendLock.toET} ET` : etLabel(lock.from);
    text = `${move} worst case: window crosses the ${input.rules?.firm ?? 'account'} weekend lock (${lockText}), sized against the weekend gap (p95 of ${gaps.length} gaps ${weekendGapP95Pct === null ? 'n/a' : `${weekendGapP95Pct.toFixed(2)}%`}, ${WEEKEND_GAP_MIN_PCT}% minimum).`;
  } else if (top.basis === 'tier1_implied' && catalyst) {
    text = `${move} worst case: ${catalyst.name} at ${hhmm(ms(catalyst.scheduledAt))} ET implies ${top.pct.toFixed(2)}% (${catalyst.impliedMoveSource ?? 'source n/a'}); ${p95Note}.`;
  } else if (top.basis === 'atr_scalp' && a) {
    text = `${move} worst case: 2.5x the 1m ATR of ${fmtNum(a.value, 1)} pts (ATR${ATR_LOOKBACK}, as of ${hhmm(a.asOf)} ET${now - a.asOf > ATR_STALE_MS ? ', stale' : ''}); ${p95Note}.`;
  } else {
    text = `${move} worst case: ${p95Note}.`;
  }
  if (catalyst && tier1ImpliedPct === null) text += ` ${catalyst.name} is inside the window with no implied move on file.`;
  return { pct: top.pct, pts, basis: top.basis, text, windowMin, components, catalyst };
}
