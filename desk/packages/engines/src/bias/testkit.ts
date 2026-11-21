/** Test helpers: recorded candles into the shape snapshotFromHistory reads. Filesystem access lives here, not in the engine. */
import { loadRecordedCandles, hasRecorded } from '@desk/feeds/recorded.ts';
import { DEFAULT_WEIGHTS, TF_MS, iso, type Candle, type Catalyst, type Datum, type Headline, type ScenarioBranch, type StructureEvent, type Timeframe, type TradePlan } from '@desk/contracts';
import { candleKey } from './history';
import { PEER_SYMBOLS, type BiasSnapshot, type CandleSet } from './types';

const cache = new Map<string, Record<string, Candle[]>>();
export function recordedCandlesByKey(symbols: string[] = ['NQ', ...PEER_SYMBOLS], tfs: Timeframe[] = ['1m', '15m', '1h', '1d']): Record<string, Candle[]> {
  const id = `${symbols.join(',')}|${tfs.join(',')}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const out: Record<string, Candle[]> = {};
  for (const s of symbols) for (const tf of tfs) if (hasRecorded(s, tf)) out[candleKey(s, tf)] = loadRecordedCandles(s, tf);
  cache.set(id, out);
  return out;
}

/* ───────── obviously synthetic builders for sign tests ───────── */

/** Synthetic candles ending at `end` (last bar closes there), compounding `stepPct` per bar. */
export function syntheticCandles(symbol: string, tf: Timeframe, n: number, end: number, last: number, stepPct: number): Candle[] {
  const out: Candle[] = [];
  let c = last / Math.pow(1 + stepPct / 100, n - 1);
  for (let i = 0; i < n; i++) {
    const o = i === 0 ? c : out[i - 1]!.c;
    const wig = Math.abs(c) * 0.001;
    out.push({ symbol, tf, t: end - (n - i) * TF_MS[tf], o, h: Math.max(o, c) + wig, l: Math.min(o, c) - wig, c, v: 1000, source: 'synthetic' });
    c *= 1 + stepPct / 100;
  }
  return out;
}
export const syntheticSet = (symbol: string, end: number, last: number, dayPct: number): CandleSet => ({
  m15: syntheticCandles(symbol, '15m', 300, end, last, dayPct / 60), h1: syntheticCandles(symbol, '1h', 60, end, last, dayPct / 16),
  d1: syntheticCandles(symbol, '1d', 300, end, last, dayPct),
});
export const syntheticDatum = (key: string, value: number, at: number, cadenceSec = 60): Datum => ({ key, value, source: 'synthetic', asOf: iso(at), cadenceSec });
export function syntheticSnapshot(now: number, over: Partial<BiasSnapshot> = {}): BiasSnapshot {
  return {
    now, instrument: 'NQ', horizon: 'intraday', price: 25000, candles: syntheticSet('NQ', now, 25000, 0), peers: {}, data: {}, dataHistory: {},
    catalysts: [], structure: [], headlines: [], weights: DEFAULT_WEIGHTS, ...over,
  };
}
export function syntheticEvent(id: string, at: number, over: Partial<StructureEvent> = {}): StructureEvent {
  return { id, detector: 'mss', kind: 'mss_bullish', instrument: 'NQ', tf: '15m', ts: iso(at), level: null, bias: 1, confidence: 0.8, text: `synthetic ${id}`, data: {}, confirmedSetup: false, ...over };
}
export function syntheticHeadline(id: string, at: number, impact: number, direction: -1 | 0 | 1): Headline {
  return { id, ts: iso(at), source: 'synthetic', title: `synthetic headline ${id}`, category: 'macro', impact, direction, symbols: [], classifier: 'rules', dedupeKey: id };
}
export function syntheticBranch(id: string, dir: 1 | -1, probability: number, trade: TradePlan | null = null): ScenarioBranch {
  return {
    id, label: dir === 1 ? 'cool' : 'hot', match: { metric: 'core_mom', lo: null, hi: null }, probability, probabilitySource: 'prior',
    ratesRead: { y2Bp: -8 * dir, y10Bp: -6 * dir, text: 'synthetic' }, indexRead: { m15Pct: 0.6 * dir, h1Pct: 1.0 * dir, closePct: 1.2 * dir, text: 'synthetic' },
    secondOrder: 'synthetic', trade,
  };
}
/** A synthetic Tier-1 CPI. `resolved` = { at, branchId } resolves it. */
export function syntheticCatalyst(scheduledAt: number, generatedAt: number, resolved: { at: number; branchId: string } | null, branches = [syntheticBranch('hot', -1, 0.3), syntheticBranch('cool', 1, 0.7)]): Catalyst {
  return {
    id: 'cat_synthetic_cpi', code: 'CPI', name: 'CPI', tier: 1, scheduledAt: iso(scheduledAt), instruments: ['NQ'], consensus: 0.3, prior: 0.3, whisper: null, unit: '%',
    impliedMovePct: 1.2, impliedMoveSource: 'historical', history: [], predictionOdds: [],
    matrix: { catalystId: 'cat_synthetic_cpi', generatedAt: iso(generatedAt), referencePrice: 25000, branches, regimeNotes: [], whatIWouldDo: 'synthetic', inputs: {} },
    status: resolved ? 'resolved' : 'upcoming',
    resolution: resolved ? { actual: 0.4, branchId: resolved.branchId, resolvedAt: iso(resolved.at) } : null,
    reaction: null, source: 'synthetic', asOf: iso(generatedAt),
  };
}
