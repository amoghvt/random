import { describe, expect, it } from 'vitest';
import { WatcherUpdate, type BiasCall, type Position, type StructureEvent, type Ticket } from '@desk/contracts';
import { chartLevels } from './chartLevels';
import { UPDATE_MAX_CHARS, diffEvents, emptyWatcherState, generateUpdates, type UpdateInput } from './updates';

const NOW = Date.parse('2026-01-06T19:00:00Z');

/** Synthetic events: hand-written, not detector output and not market data. */
function syntheticEvent(over: Partial<StructureEvent> & { id: string; short?: string; obsKey?: string; severity?: number }): StructureEvent {
  const { short, obsKey, severity, ...rest } = over;
  return {
    detector: 'retrace_quality', kind: 'bounce_stalled_under_50', instrument: 'NQ', tf: '15m', ts: new Date(NOW).toISOString(),
    level: 27024, levelHi: null, bias: -1, confidence: 0.65, text: 'NQ 15m bounce stalled at 42% of the 17:00 drop.', confirmedSetup: false,
    ...rest,
    data: { short: short ?? 'bounce stalled at 42% of the 17:00 drop', ...(obsKey ? { obsKey } : {}), ...(severity !== undefined ? { severity } : {}), ...rest.data },
  };
}

const syntheticPosition: Position = { id: 'pos_1', accountId: 'vest-instant', ticketId: 'tkt_1', instrument: 'NQ-PERP', direction: 'long', units: 50_000, entryPrice: 27000, openedAt: '2026-01-06T15:00:00Z', liquidationPrice: 26800, leverage: 20 };
const syntheticTicket: Ticket = {
  id: 'tkt_1', createdAt: '2026-01-06T14:00:00Z', accountId: 'vest-instant', instrument: 'NQ-PERP', direction: 'long',
  reason: { kind: 'structure', setupEventId: 'se_synthetic' }, entry: { kind: 'price', text: 'reclaim of 27,000', price: 27000 },
  size: { engineMaxUnits: 50_000, units: 50_000, notionalUsd: 50_000, leverage: 20, failPrice: 26800 },
  targets: [{ price: 27130, fraction: 0.5 }, { price: 27200, fraction: 0.25 }, { price: 27300, fraction: 0.25 }],
  invalidation: { price: 26950, reason: 'below the swept low' }, timeStop: '2026-01-06T20:30:00Z',
  holdThroughCatalyst: { flag: false, catalystId: null }, status: 'open',
  fills: [{ ts: '2026-01-06T15:00:00Z', price: 27000, units: 50_000, kind: 'entry', source: 'manual' }], overrides: [], watcherEventIds: [], closedAt: null, result: null, sizingSnapshot: null,
};
const syntheticCall: BiasCall = {
  id: 'call_1', instrument: 'NQ', horizon: 'intraday', call: 'lean_short', probability: 0.58, score: -0.3, factors: [], facts: [], trade: null,
  killCondition: { text: '15m close above 27,180', level: 27180, side: 'above' }, nextCatalyst: null,
  expiresAt: '2026-01-06T20:30:00Z', createdAt: '2026-01-06T14:00:00Z', trigger: { kind: 'initial', ref: 'open' }, firstMoveUntrusted: false, referencePrice: 27050, inputs: {},
};
const input = (over: Partial<UpdateInput>): UpdateInput => ({ now: NOW, instrument: 'NQ', events: [], allEvents: [], lastPrice: 27062, call: null, positions: [], tickets: [], prevState: null, ...over });

describe('diffEvents (synthetic events)', () => {
  const a = syntheticEvent({ id: 'se_a' }), b = syntheticEvent({ id: 'se_b' });
  it('returns the events not seen before, from an id list or a state', () => {
    expect(diffEvents(null, [a, b])).toEqual([a, b]);
    expect(diffEvents(['se_a'], [a, b])).toEqual([b]);
    expect(diffEvents(new Set(['se_a', 'se_b']), [a, b])).toEqual([]);
    expect(diffEvents({ eventIds: ['se_b'], observations: {} }, [a, b])).toEqual([a]);
  });
});

describe('generateUpdates (synthetic events)', () => {
  const stall = syntheticEvent({ id: 'se_stall', obsKey: 'retrace_stalled|15m|leg1', severity: 1 });
  const ema = syntheticEvent({ id: 'se_ema', detector: 'ema_posture', kind: 'reclaim_and_hold', tf: '1m', bias: 1, confidence: 0.6, short: 'reclaimed the 1m EMA at 27,024' });
  const peer = syntheticEvent({ id: 'se_div', detector: 'divergence', kind: 'both_lower_highs', bias: -1, confidence: 0.5, short: 'ES lower highs too' });

  it('writes one update when a state change touches an open position, numbers first, in the spec format', () => {
    const { updates, state } = generateUpdates(input({ events: [stall, ema], allEvents: [stall, ema, peer], positions: [syntheticPosition], tickets: [syntheticTicket], call: syntheticCall }));
    expect(updates).toHaveLength(1);
    const u = updates[0]!;
    expect(u.text).toBe('NQ 27,062, bounce stalled at 42% of the 17:00 drop. Reclaimed the 1m EMA at 27,024. ES lower highs too. Call unchanged: Lean short, 0.58, expires 15:30 ET. Half off at 27,130 per ticket.');
    expect(u.text.length).toBeLessThanOrEqual(UPDATE_MAX_CHARS);
    expect(u.touches).toEqual({ positionIds: ['pos_1'], ticketIds: ['tkt_1'], biasKill: false });
    expect(u.eventIds).toEqual(['se_stall', 'se_ema']);
    expect(u).toMatchObject({ dedupeKey: 'retrace_stalled|15m|leg1', severity: 1, ts: new Date(NOW).toISOString() });
    expect(() => WatcherUpdate.parse(u)).not.toThrow();
    expect(state.eventIds).toEqual(expect.arrayContaining(['se_stall', 'se_ema', 'se_div']));
  });

  it('never emits the same observation twice, and does emit a worsening of it', () => {
    const base = { positions: [syntheticPosition], tickets: [syntheticTicket], call: syntheticCall };
    const first = generateUpdates(input({ ...base, events: [stall], allEvents: [stall] }));
    expect(first.updates).toHaveLength(1);
    // Same observation under a new event id (e.g. the lookback slid): not pushed again.
    const again = syntheticEvent({ id: 'se_stall_again', obsKey: 'retrace_stalled|15m|leg1', severity: 1 });
    const second = generateUpdates(input({ ...base, events: [again], allEvents: [stall, again], prevState: first.state }));
    expect(second.updates).toHaveLength(0);
    // The caller's diff also removes a literal repeat.
    expect(diffEvents(first.state, [stall])).toEqual([]);
    const worse = syntheticEvent({ id: 'se_stall_2', obsKey: 'retrace_stalled|15m|leg1', severity: 2, short: 'bounce stalled again at 38% of the 17:00 drop' });
    const third = generateUpdates(input({ ...base, events: [worse], allEvents: [stall, worse], prevState: second.state }));
    expect(third.updates).toHaveLength(1);
    expect(third.updates[0]).toMatchObject({ dedupeKey: 'retrace_stalled|15m|leg1', severity: 2 });
    expect(third.updates[0]!.id).not.toBe(first.updates[0]!.id);
    expect(generateUpdates(input({ ...base, events: [worse], allEvents: [worse], prevState: third.state })).updates).toHaveLength(0);
  });

  it('stays quiet when nothing is open and the event is not high-confidence', () => {
    expect(generateUpdates(input({ events: [stall], allEvents: [stall] })).updates).toHaveLength(0);
  });

  it('allows a general-interest update on a high-confidence event for the primary instrument only', () => {
    const spike = syntheticEvent({ id: 'se_spike', detector: 'volume_context', kind: 'spike_rejected', confidence: 0.7, short: 'spike +110 pts to 27,170, rejected, volume 60% of the 17:00 impulse' });
    const { updates } = generateUpdates(input({ events: [spike], allEvents: [spike] }));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.text).toBe('NQ 27,062, spike +110 pts to 27,170, rejected, volume 60% of the 17:00 impulse.');
    expect(updates[0]!.touches).toEqual({ positionIds: [], ticketIds: [], biasKill: false });
    expect(generateUpdates(input({ events: [spike], allEvents: [spike], primary: false })).updates).toHaveLength(0);
  });

  it('flags a state change at the bias call kill level', () => {
    const atKill = syntheticEvent({ id: 'se_kill', detector: 'mss', kind: 'mss_bullish', bias: 1, level: 27175, confidence: 0.5, short: '15m MSS up through 27,175' });
    const { updates } = generateUpdates(input({ events: [atKill], allEvents: [atKill], call: syntheticCall }));
    expect(updates[0]!.touches.biasKill).toBe(true);
    expect(updates[0]!.text).toContain('Call unchanged: Lean short, 0.58');
    const through = generateUpdates(input({ events: [atKill], allEvents: [atKill], call: syntheticCall, lastPrice: 27190 }));
    expect(through.updates[0]!.text).toContain('Kill level 27,180 reached: Lean short, 0.58 under review.');
  });

  it('a live ticket is touched by a low-confidence event at one of its levels, and not by one elsewhere', () => {
    const planned: Ticket = { ...syntheticTicket, id: 'tkt_2', status: 'planned', fills: [] };
    const atTarget = syntheticEvent({ id: 'se_fvg', detector: 'fvg', kind: 'fvg_bear_open', level: 27125, levelHi: 27140, confidence: 0.45, short: '15m bear FVG 27,125-27,140 open' });
    const far = syntheticEvent({ id: 'se_far', detector: 'fvg', kind: 'fvg_bear_open', level: 27500, levelHi: 27520, confidence: 0.45, short: '15m bear FVG 27,500-27,520 open' });
    const hit = generateUpdates(input({ events: [atTarget, far], allEvents: [atTarget, far], tickets: [planned] }));
    expect(hit.updates).toHaveLength(1);
    expect(hit.updates[0]!.eventIds).toEqual(['se_fvg']);
    expect(hit.updates[0]!.touches.ticketIds).toEqual(['tkt_2']);
    expect(hit.updates[0]!.text).toContain('Invalidation 26,950 per ticket.');
    expect(generateUpdates(input({ events: [far], allEvents: [far], tickets: [{ ...planned, status: 'closed' }] })).updates).toHaveLength(0);
  });

  it('ignores events for other instruments and plain swings', () => {
    const other = syntheticEvent({ id: 'se_es', instrument: 'ES', confidence: 0.9 });
    const swing = syntheticEvent({ id: 'se_sw', detector: 'swing', kind: 'swing_high', confidence: 0.9 });
    expect(generateUpdates(input({ events: [other, swing], allEvents: [other, swing], positions: [syntheticPosition] })).updates).toHaveLength(0);
  });

  it('enforces 280 characters in code: optional parts go first, then a hard cut', () => {
    const long = (id: string, detector: StructureEvent['detector'], n: number): StructureEvent => syntheticEvent({ id, detector, short: `${id} ${'x'.repeat(n)}` });
    const a = long('lead', 'retrace_quality', 90), b = long('second', 'mss', 90), d = syntheticEvent({ id: 'se_d', detector: 'divergence', short: `peer ${'y'.repeat(60)}` });
    const u = generateUpdates(input({ events: [a, b], allEvents: [a, b, d], positions: [syntheticPosition], tickets: [syntheticTicket], call: syntheticCall })).updates[0]!;
    expect(u.text.length).toBeLessThanOrEqual(UPDATE_MAX_CHARS);
    expect(u.text).toContain('Call unchanged');
    expect(u.text).toContain('Half off at 27,130 per ticket.');
    expect(u.text).not.toContain('peer yyy');
    const huge = generateUpdates(input({ events: [long('huge', 'retrace_quality', 400)], allEvents: [], positions: [syntheticPosition] })).updates[0]!;
    expect(huge.text.length).toBe(UPDATE_MAX_CHARS);
    expect(huge.text.endsWith('…')).toBe(true);
    expect(() => WatcherUpdate.parse(huge)).not.toThrow();
  });

  it('is pure: the previous state is not mutated', () => {
    const prev = emptyWatcherState();
    generateUpdates(input({ events: [stall], allEvents: [stall], positions: [syntheticPosition], prevState: prev }));
    expect(prev).toEqual(emptyWatcherState());
  });
});

describe('chartLevels (synthetic events)', () => {
  it('selects liquidity, live FVGs, live order blocks and the EMAs, and drops filled or invalidated zones', () => {
    const ev = [
      syntheticEvent({ id: 'l1', detector: 'liquidity_pool', kind: 'equal_highs', level: 27600, levelHi: 27605, data: { touches: 2 } }),
      syntheticEvent({ id: 'l2', detector: 'liquidity_pool', kind: 'buy_side_liquidity', level: 27605, data: { touches: 2 } }),
      syntheticEvent({ id: 'l3', detector: 'liquidity_pool', kind: 'sell_side_liquidity', level: 27236, data: { touches: 1 } }),
      syntheticEvent({ id: 'f1', detector: 'fvg', kind: 'fvg_bull_open', level: 27100, levelHi: 27130, data: { state: 'open', direction: 'bull' } }),
      syntheticEvent({ id: 'f2', detector: 'fvg', kind: 'fvg_bear_filled', level: 27300, levelHi: 27320, data: { state: 'filled', direction: 'bear' } }),
      syntheticEvent({ id: 'o1', detector: 'order_block', kind: 'ob_bear_mitigated', level: 27400, levelHi: 27440, data: { state: 'mitigated', direction: 'bear' } }),
      syntheticEvent({ id: 'o2', detector: 'order_block', kind: 'ob_bull_invalidated', level: 27000, levelHi: 27020, data: { state: 'invalidated', direction: 'bull' } }),
      syntheticEvent({ id: 'e1', detector: 'ema_posture', kind: 'ema_stack_bear', data: { ema20: 27320, ema50: 27400, ema200: null, asOfT: NOW } }),
      syntheticEvent({ id: 's1', detector: 'sweep_reclaim', kind: 'sweep_reclaim_mss_long', level: 27150, confirmedSetup: true }),
    ];
    const lv = chartLevels(ev);
    expect(lv.liquidity.map((l) => [l.side, l.price])).toEqual(expect.arrayContaining([['buy', 27605], ['sell', 27236]]));
    expect(lv.liquidity).toHaveLength(2);
    expect(lv.fvgs.map((z) => z.eventId)).toEqual(['f1']);
    expect(lv.orderBlocks).toMatchObject([{ eventId: 'o1', lo: 27400, hi: 27440, direction: 'bear', state: 'mitigated' }]);
    expect(lv.emas.map((e) => [e.period, e.price])).toEqual([[20, 27320], [50, 27400]]);
    expect(lv.setups.map((s) => s.eventId)).toEqual(['s1']);
  });
});
