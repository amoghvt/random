import type { CalendarEvent, EventCode } from '@desk/contracts';
import { DEFAULT_WATCHLIST } from '@desk/contracts';
import type { TierCtx } from './types';

/**
 * Approximate, as of 2026-11, override via config (`ctx.indexWeights`).
 * Only names held with confidence above 5% of NDX; every other ticker needs the input.
 */
export const DEFAULT_INDEX_WEIGHTS: Readonly<Record<string, number>> = { NVDA: 9, MSFT: 8, AAPL: 7.5 };
export const INDEX_WEIGHTS_LABEL = 'approximate, as of 2026-11, override via config';
export const TIER1_WEIGHT_PCT = 5;
export const AUCTION_ROUND_LEVEL_BP = 10;

const TIER1: ReadonlySet<EventCode> = new Set(['CPI', 'CORE_CPI', 'PPI', 'CORE_PPI', 'NFP', 'UNEMPLOYMENT', 'FOMC', 'FOMC_MINUTES', 'FED_CHAIR', 'SUMMIT', 'ADHOC']);
const TIER2: ReadonlySet<EventCode> = new Set(['ISM_MFG', 'ISM_SVC', 'JOLTS', 'RETAIL_SALES', 'CLAIMS', 'PCE', 'CORE_PCE', 'REGIONAL_FED', 'FED_SPEAKER']);

export interface TierDetail { tier: 1 | 2 | 3; reason: string }

export function indexWeight(symbol: string, ctx: TierCtx): { pct: number | null; source: 'config' | 'default' | 'missing' } {
  const cfg = ctx.indexWeights?.[symbol];
  if (cfg !== undefined) return { pct: cfg, source: 'config' };
  const def = DEFAULT_INDEX_WEIGHTS[symbol];
  return def !== undefined ? { pct: def, source: 'default' } : { pct: null, source: 'missing' };
}

export function tierDetail(event: Pick<CalendarEvent, 'code' | 'name' | 'symbol' | 'importance'>, ctx: TierCtx = {}): TierDetail {
  const { code } = event;
  if (TIER1.has(code)) return { tier: 1, reason: `${code} is Tier 1` };
  if (TIER2.has(code)) return { tier: 2, reason: `${code} is Tier 2` };
  if (code === 'EARNINGS') {
    const sym = event.symbol ?? '';
    const w = indexWeight(sym, ctx);
    const watch = (ctx.watchlist ?? DEFAULT_WATCHLIST).includes(sym);
    if (w.pct !== null && w.pct > TIER1_WEIGHT_PCT) return { tier: 1, reason: `${sym} is ${w.pct}% of NDX (${w.source === 'default' ? INDEX_WEIGHTS_LABEL : 'config'})` };
    const missing = w.source === 'missing' ? `; index weight for ${sym || 'the name'} not supplied` : '';
    return watch ? { tier: 2, reason: `${sym} is on the watchlist${missing}` } : { tier: 3, reason: `${sym || 'name'} is off the watchlist${missing}` };
  }
  if (code === 'IPO') {
    const major = (event.symbol !== undefined && (ctx.majorIpos ?? []).includes(event.symbol)) || event.importance === 1;
    return major ? { tier: 1, reason: 'major IPO pricing' } : { tier: 3, reason: 'IPO not flagged major' };
  }
  if (code === 'TREASURY_AUCTION') {
    const d = ctx.y10RoundLevelDistanceBp;
    const coupon = !/bill|tips|frn/i.test(event.name);
    if (coupon && d !== null && d !== undefined && Math.abs(d) <= AUCTION_ROUND_LEVEL_BP) return { tier: 2, reason: `10Y is ${Math.abs(Math.round(d))} bp from a round level` };
    return { tier: 3, reason: coupon ? '10Y is not within 10 bp of a round level' : 'bill, TIPS or FRN auction' };
  }
  return { tier: 3, reason: 'shown, not planned' };
}

export const tierFor = (event: Pick<CalendarEvent, 'code' | 'name' | 'symbol' | 'importance'>, ctx: TierCtx = {}): 1 | 2 | 3 => tierDetail(event, ctx).tier;
