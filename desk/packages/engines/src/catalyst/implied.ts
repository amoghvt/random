import { freshness, iso, median, round } from '@desk/contracts';
import type { Catalyst } from '@desk/contracts';
import type { ImpliedCtx, ImpliedMove } from './types';

/** p90 / median of |x| for a zero-mean normal: 1.645 / 0.6745. Scales the median reaction to a risk number. */
export const P90_OVER_MEDIAN = 2.44;
export const MIN_HISTORY_FOR_IMPLIED = 4;
/** One-day 90th percentile of |move| from an annualised vol index: VIX / sqrt(252) * 1.645. */
export const vixDailyP90 = (vix: number): number => (vix / Math.sqrt(252)) * 1.645;

/** Expected absolute move through the event, percent: options if a fresh datum exists, else history, else VIX. Always tagged. */
export function impliedMove(catalyst: Catalyst, ctx: ImpliedCtx): ImpliedMove {
  const symbol = catalyst.instruments[0] ?? '';
  const opt = (ctx.data ?? []).find((d) => d.key === `opt.implied_move.${symbol}` && freshness(d, ctx.now) !== 'stale');
  if (opt) return { pct: round(Math.abs(opt.value), 2), source: 'options', n: null, asOf: opt.asOf, text: `Implied move ${round(Math.abs(opt.value), 2)}% on ${symbol} (options, ${opt.source}).` };
  if (catalyst.impliedMoveSource === 'options' && catalyst.impliedMovePct !== null) {
    return { pct: catalyst.impliedMovePct, source: 'options', n: null, asOf: catalyst.asOf, text: `Implied move ${catalyst.impliedMovePct}% on ${symbol} (options, ${catalyst.source}).` };
  }
  const closes = catalyst.history.map((h) => h.closePct).filter((x): x is number => x !== null).map(Math.abs);
  if (closes.length >= MIN_HISTORY_FOR_IMPLIED) {
    const pct = round(median(closes) * P90_OVER_MEDIAN, 2);
    return { pct, source: 'historical', n: closes.length, asOf: iso(ctx.now), text: `Implied move ${pct}% on ${symbol} (historical: median |close-to-close| ${round(median(closes), 2)}% over ${closes.length} prints, scaled x${P90_OVER_MEDIAN} to p90).` };
  }
  if (ctx.vix) {
    const pct = round(vixDailyP90(ctx.vix.value), 2);
    return { pct, source: 'vix', n: null, asOf: ctx.vix.asOf, text: `Implied move ${pct}% (VIX ${round(ctx.vix.value, 1)}, one-day p90, S&P vol not adjusted for ${symbol} beta).` };
  }
  return { pct: null, source: null, n: null, asOf: iso(ctx.now), text: 'No implied move on file.' };
}

export function withImpliedMove<T extends Catalyst>(catalyst: T, ctx: ImpliedCtx): T {
  const m = impliedMove(catalyst, ctx);
  return { ...catalyst, impliedMovePct: m.pct, impliedMoveSource: m.source };
}
