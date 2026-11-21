/** Test fixtures: real recorded candles and obviously synthetic catalysts and states. Not used by shipped paths. */
import { loadRecordedCandles } from '@desk/feeds';
import { iso, type AccountRules, type AccountState, type Catalyst } from '@desk/contracts';
import { loadAccounts } from './load';
import { defaultAccountState } from './room';
import type { CandleSet } from './worst';

export const RULES: Record<string, AccountRules> = Object.fromEntries(loadAccounts().map((r) => [r.id, r]));
export const rulesOf = (id: string): AccountRules => {
  const r = RULES[id];
  if (!r) throw new Error(`no account ${id}`);
  return r;
};

const cache = new Map<string, CandleSet>();
/** Real recorded candles for a desk symbol (Yahoo, data/recorded). */
export function recorded(symbol: string): CandleSet {
  let s = cache.get(symbol);
  if (!s) {
    s = { m1: loadRecordedCandles(symbol, '1m'), m15: loadRecordedCandles(symbol, '15m'), h1: loadRecordedCandles(symbol, '1h'), d1: loadRecordedCandles(symbol, '1d') };
    cache.set(symbol, s);
  }
  return s;
}
export function lastClose(set: CandleSet, now: number): number {
  const c = set.m1.filter((k) => k.t <= now).at(-1);
  if (!c) throw new Error('no 1m candle at or before now');
  return c.c;
}

/** Synthetic account state: active, with overrides. */
export function syntheticState(rules: AccountRules, now: number, over: Partial<AccountState> = {}): AccountState {
  return { ...defaultAccountState(rules, now), active: true, ...over };
}
/** Synthetic Tier-1 catalyst; the implied move is a test input, not market data. */
export function syntheticCatalyst(at: number, over: Partial<Catalyst> = {}): Catalyst {
  return {
    id: 'cat_synthetic_cpi', code: 'CPI', name: 'CPI', tier: 1, scheduledAt: iso(at), instruments: ['NQ', 'ES'],
    consensus: null, prior: null, whisper: null, impliedMovePct: 1.2, impliedMoveSource: 'options', history: [], predictionOdds: [],
    matrix: null, status: 'upcoming', resolution: null, source: 'synthetic', asOf: iso(at), ...over,
  };
}
