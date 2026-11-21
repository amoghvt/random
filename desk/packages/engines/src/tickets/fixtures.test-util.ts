/** Test fixtures. Everything here is synthetic unless it is loaded from data/recorded by the test that uses it. */
import { MIN, iso, type Candle, type Catalyst, type SizingResult, type StructureEvent, type Ticket, type TicketDraft } from '@desk/contracts';

export const NOW = Date.parse('2026-11-17T14:25:00Z');

export function syntheticCatalyst(over: Partial<Catalyst> = {}): Catalyst {
  return {
    id: 'cat_synthetic_cpi', code: 'CPI', name: 'CPI (synthetic)', tier: 1, scheduledAt: iso(NOW - 30 * MIN), instruments: ['NQ', 'ES'],
    consensus: null, prior: null, whisper: null, impliedMovePct: null, impliedMoveSource: null, history: [], predictionOdds: [], matrix: null,
    status: 'resolved', resolution: { actual: null, branchId: null, resolvedAt: iso(NOW - 30 * MIN) }, source: 'synthetic', asOf: iso(NOW), ...over,
  };
}
export function syntheticSetup(over: Partial<StructureEvent> = {}): StructureEvent {
  return { id: 'se_synthetic_1', detector: 'sweep_reclaim', kind: 'sweep_reclaim_mss', instrument: 'NQ', tf: '15m', ts: iso(NOW - 20 * MIN), level: 27400, bias: -1, confidence: 0.7, text: 'synthetic setup', data: {}, confirmedSetup: true, ...over };
}
export function syntheticSizing(over: Partial<SizingResult> = {}): SizingResult {
  return {
    accountId: 'mffu-pro-50k', instrument: 'NQ', direction: 'short', asOf: iso(NOW), blocked: false, blockReason: null,
    maxUnits: 3, notionalUsd: 3 * 20 * 27338, leverage: null, failPrice: 27600, failDistancePts: 262, failDistancePct: 0.96,
    worstMove: { pct: 0.6, pts: 164, basis: 'p95_window', text: 'synthetic' },
    room: { toDrawdownUsd: 2000, toDailyLimitUsd: null, usableUsd: 1600, cushionPct: 20, binding: 'drawdown' },
    catalystInWindow: null, notes: [], payoutNote: null, inputs: { synthetic: true }, ...over,
  };
}
export function shortDraft(over: Partial<TicketDraft> = {}): TicketDraft {
  return {
    accountId: 'mffu-pro-50k', instrument: 'NQ', direction: 'short',
    reason: { kind: 'catalyst', catalystId: 'cat_synthetic_cpi' },
    entry: { kind: 'price', price: 27338, text: 'sell 27,338 on the cash open' },
    targets: [{ price: 27250 }, { price: 27150 }, { price: 26900 }],
    invalidation: { price: 27440, reason: 'reclaims the pre-market high' },
    timeStop: '2026-11-17T20:00:00Z', ...over,
  };
}
export const ctx = (over: Partial<Parameters<typeof import('./validate').validateDraft>[1]> = {}): Parameters<typeof import('./validate').validateDraft>[1] => ({
  now: NOW, catalysts: [syntheticCatalyst()], setups: [syntheticSetup()], sizing: syntheticSizing(), accountIds: ['mffu-pro-50k', 'vest-instant'], recentTickets: [], price: 27359.75, reentryCooldownMin: 15, ...over,
});

/** A synthetic 1m candle; o=c=mid unless given. */
export function syntheticCandle(t: number, h: number, l: number, o = (h + l) / 2, c = (h + l) / 2): Candle {
  return { symbol: 'NQ', tf: '1m', t, o, h, l, c, v: 100, source: 'synthetic' };
}
export const at = (hhmmss: string): number => Date.parse(`2026-11-17T${hhmmss}Z`);
export const withFills = (t: Ticket, fills: Ticket['fills']): Ticket => ({ ...t, fills, status: 'open' });
