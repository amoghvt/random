import { describe, expect, it } from 'vitest';
import { BiasCall, DATUM_KEYS, DAY, HOUR, MIN, fromZoned, iso, type TradePlan } from '@desk/contracts';
import { answerUpOrDown, noEdgeAnswer } from './answer';
import { decideCall, replayCall, storedInputs } from './decide';
import { snapshotFromHistory } from './history';
import { applyCalibration, labelFromScore, probabilityFromScore } from './scoring';
import { recordedCandlesByKey, syntheticBranch, syntheticCatalyst, syntheticDatum, syntheticEvent, syntheticHeadline, syntheticSet, syntheticSnapshot } from './testkit';
import type { BiasSnapshot } from './types';

const by = recordedCandlesByKey();
const NOV17 = fromZoned(2026, 11, 17, 11, 0);
const real = (now: number, over: Partial<Parameters<typeof snapshotFromHistory>[0]> = {}): BiasSnapshot =>
  snapshotFromHistory({ now, instrument: 'NQ', horizon: 'intraday', candlesByKey: by, dataHistory: {}, catalysts: [], structure: [], headlines: [], ...over });
/** Synthetic watcher events on the real Nov 17 tape: a stalled bounce and a bearish MSS, with levels both sides. */
const bearish = (now: number) => [
  syntheticEvent('ev_stall', now - 40 * MIN, { detector: 'retrace_quality', kind: 'bounce_stalled_under_50', bias: -1, confidence: 0.8, level: 27300, text: 'Bounce 41% of the drop, stalled under 27,300 (synthetic)' }),
  syntheticEvent('ev_mss', now - 20 * MIN, { detector: 'mss', kind: 'mss_bearish', bias: -1, confidence: 0.8, level: 27000, text: '15m close under the 27,000 higher low (synthetic)' }),
  syntheticEvent('ev_liq_hi', now - 3 * HOUR, { detector: 'liquidity_pool', kind: 'equal_highs', bias: 0, level: 27480 }),
  syntheticEvent('ev_liq_lo', now - 3 * HOUR, { detector: 'liquidity_pool', kind: 'equal_lows', bias: 0, level: 26700 }),
];
const BANNED = ['consider', 'you may want to', 'might want to', 'perhaps', 'it could be argued'];
const roundTrip = (c: BiasCall): BiasCall => BiasCall.parse(JSON.parse(JSON.stringify(c)));

describe('decideCall', () => {
  it('No edge is returned when there is no catalyst and no structure event', () => {
    const snap = real(NOV17);
    const call = decideCall(snap, null);
    console.log(`no-edge on NQ ${iso(NOV17)}: score ${call.score} | ${call.facts.join(' | ')}`);
    expect(call.call).toBe('no_edge');
    expect(call.probability).toBe(0.5);
    expect(call.trade).toBeNull();
    expect(call.facts[0]).toContain('no catalyst inside the horizon and no structure signal');
    expect(call.facts[1]).toMatch(/^What creates one:/);
    expect(call.expiresAt).toBe(iso(fromZoned(2026, 11, 17, 16, 0)));
    expect(() => BiasCall.parse(call)).not.toThrow();
    // An upcoming catalyst beyond the horizon is named as the fact that would create an edge.
    const withNext = decideCall(real(NOV17, { catalysts: [syntheticCatalyst(NOV17 + 2 * DAY, NOV17 - DAY, null)] }), null);
    expect(withNext.call).toBe('no_edge');
    expect(withNext.facts[1]).toContain('CPI Thu 11:00 ET');
    expect(withNext.nextCatalyst?.name).toBe('CPI');
    expect(noEdgeAnswer('NQ', snap)).toMatch(/^NQ: No edge\. No catalyst inside the intraday horizon, no structure signal\. What creates one:/);
  });

  it('commits to a call with a full plan when structure gives a signal', () => {
    const call = decideCall(real(NOV17, { structure: bearish(NOV17) }), null);
    console.log(`call on NQ ${iso(NOV17)}: ${call.call} ${call.probability} score ${call.score}\n${answerUpOrDown(call, NOV17)}`);
    expect(call.call).toMatch(/short$/);
    expect(call.probability).toBeGreaterThan(0.5);
    expect(call.probability).toBeLessThanOrEqual(0.85);
    expect(call.facts).toHaveLength(3);
    for (const f of call.facts) expect(f).toMatch(/\d/);
    const t = call.trade!;
    expect(t.direction).toBe('short');
    expect(t.entry.text.toLowerCase()).not.toContain('now');
    expect(t.targets.map((x) => x.price)).toEqual([...t.targets.map((x) => x.price)].sort((a, b) => b - a));
    expect(t.targets[0].price).toBeLessThan(t.entry.price!);
    expect(t.invalidation.price).toBeGreaterThan(t.entry.price!);
    expect(t.targets.reduce((a, x) => a + x.fraction, 0)).toBeCloseTo(1, 9);
    expect(call.killCondition).toMatchObject({ level: t.invalidation.price, side: 'above' });
    expect(Date.parse(call.expiresAt)).toBeLessThanOrEqual(fromZoned(2026, 11, 17, 16, 0));
    expect(call.expiresAt).toBe(t.timeStop.at);
    expect(call.trigger).toEqual({ kind: 'initial', ref: 'first call' });
    expect(() => BiasCall.parse(call)).not.toThrow();
    const text = answerUpOrDown(call, NOV17);
    expect(text).toMatch(/^Down\. NQ intraday: (Lean|Strong) short, 0\.\d\d, expires Tue 15:45 ET\./);
    for (const w of BANNED) expect(text.toLowerCase()).not.toContain(w);
    expect(answerUpOrDown(call, Date.parse(call.expiresAt) + MIN)).toContain('expired Tue 15:45 ET');
  });

  it('never changes a call on the same evidence', () => {
    const snap = real(NOV17, { structure: bearish(NOV17) });
    const first = decideCall(snap, null);
    expect(decideCall(snap, first)).toBe(first);
    // Five minutes later, price has moved but no fact is new: same call, same id.
    const later = real(NOV17 + 5 * MIN, { structure: bearish(NOV17) });
    expect(later.price).not.toBe(snap.price);
    expect(decideCall(later, first)).toBe(first);
    // A fresh decision on the same snapshot is the identical call.
    expect(decideCall(snap, null)).toEqual(first);
    // An impact-1 headline is not a fact.
    expect(decideCall(real(NOV17 + 5 * MIN, { structure: bearish(NOV17), headlines: [syntheticHeadline('h_small', NOV17 + 2 * MIN, 1, -1)] }), first)).toBe(first);
  });

  it('a new print produces a new call', () => {
    const first = decideCall(real(NOV17, { structure: bearish(NOV17) }), null);
    const at = NOV17 + 30 * MIN;
    const cat = syntheticCatalyst(at, NOV17 - DAY, { at, branchId: 'hot' });
    const next = decideCall(real(at + 20 * MIN, { structure: bearish(NOV17), catalysts: [cat] }), first);
    expect(next.id).not.toBe(first.id);
    expect(next.trigger).toEqual({ kind: 'print', ref: cat.id });
    expect(next.factors.find((f) => f.factor === 'catalyst')!.weight).toBeGreaterThanOrEqual(0.5);
    expect(storedInputs(next)!.scoring.multiplier).toBe(1.25);
    // Seen once, the same print is not a new fact.
    expect(decideCall(real(at + 25 * MIN, { structure: bearish(NOV17), catalysts: [cat] }), next)).toBe(next);
  });

  it('a headline, a broken level, a time stop and the expiry each produce a new call', () => {
    const structure = bearish(NOV17);
    const first = decideCall(real(NOV17, { structure }), null);
    const head = decideCall(real(NOV17 + 5 * MIN, { structure, headlines: [syntheticHeadline('h_big', NOV17 + 2 * MIN, 2, -1)] }), first);
    expect(head.trigger).toEqual({ kind: 'headline', ref: 'h_big' });
    const bos = decideCall(real(NOV17 + 5 * MIN, { structure: [...structure, syntheticEvent('ev_bos', NOV17 + 3 * MIN, { detector: 'bos', kind: 'bos_bearish', bias: -1 })] }), first);
    expect(bos.trigger).toEqual({ kind: 'level', ref: 'ev_bos' });
    const through = { ...real(NOV17 + 5 * MIN, { structure }), price: first.killCondition.level! + 1 };
    expect(decideCall(through, first).trigger.kind).toBe('level');
    const stop = decideCall(real(Date.parse(first.trade!.timeStop.at!) + MIN, { structure }), first);
    expect(stop.trigger).toEqual({ kind: 'time_stop', ref: first.id });
    const noEdge = decideCall(real(NOV17), null);
    expect(decideCall(real(Date.parse(noEdge.expiresAt) - MIN), noEdge)).toBe(noEdge);
    expect(decideCall(real(Date.parse(noEdge.expiresAt) + MIN), noEdge).trigger).toEqual({ kind: 'expiry', ref: noEdge.id });
  });

  it('first move after a catalyst is not trusted when it contradicts the rates read', () => {
    const at = fromZoned(2026, 11, 17, 8, 30), k = DATUM_KEYS.rate('US10Y');
    const cat = syntheticCatalyst(at, at - DAY, { at, branchId: 'hot' }); // hot branch reads 10Y +6 bp, NQ short
    const y = (t: number, v: number) => syntheticDatum(k, v, t);
    const early = real(at + 8 * MIN, { catalysts: [cat], dataHistory: { [k]: [y(at - MIN, 5.1), y(at + 7 * MIN, 5.07)] } });
    const call = decideCall(early, null);
    console.log(`first move: ${call.call} ${call.probability} | ${call.facts[0]}`);
    expect(call.firstMoveUntrusted).toBe(true);
    expect(call.call).toBe('lean_short');
    expect(call.probability).toBeLessThanOrEqual(0.68);
    expect(call.facts[0]).toMatch(/first move, not yet trusted/i);
    expect(call.facts[0]).toContain('10Y −3.0 bp');
    expect(storedInputs(call)!.scoring.multiplier).toBe(1);
    // Still inside the window: nothing new.
    expect(decideCall(real(at + 12 * MIN, { catalysts: [cat], dataHistory: { [k]: [y(at - MIN, 5.1), y(at + 11 * MIN, 5.07)] } }), call)).toBe(call);
    // After 15 minutes with yields confirming, the second move is trusted.
    const second = decideCall(real(at + 20 * MIN, { catalysts: [cat], dataHistory: { [k]: [y(at - MIN, 5.1), y(at + 7 * MIN, 5.07), y(at + 19 * MIN, 5.16)] } }), call);
    expect(second.id).not.toBe(call.id);
    expect(second.trigger).toEqual({ kind: 'time_stop', ref: `first_move_window:${call.id}` });
    expect(second.firstMoveUntrusted).toBe(false);
    expect(storedInputs(second)!.scoring.multiplier).toBe(1.25);
    expect(Math.abs(second.score)).toBeGreaterThan(Math.abs(call.score));
    // A first move that agrees with the read is trusted at once.
    const agree = decideCall(real(at + 8 * MIN, { catalysts: [cat], dataHistory: { [k]: [y(at - MIN, 5.1), y(at + 7 * MIN, 5.15)] } }), null);
    if (storedInputs(agree)!.features.firstMove!.priceSincePct! <= 0.1) expect(agree.firstMoveUntrusted).toBe(false);
  });

  it('uses the resolved branch\'s own trade plan', () => {
    const at = NOV17 - 30 * MIN;
    const plan: TradePlan = {
      instrument: 'NQ', direction: 'short', entry: { kind: 'condition', text: 'second move after 10:45 ET if the 10Y confirms' }, referencePrice: 27100,
      targets: [{ price: 26900, fraction: 0.5 }, { price: 26750, fraction: 0.3 }, { price: 26600, fraction: 0.2 }],
      invalidation: { price: 27350, reason: 'above the pre-print high' }, timeStop: { at: iso(fromZoned(2026, 11, 17, 15, 30)), text: 'flat by 15:30 ET' },
    };
    const cat = syntheticCatalyst(at, at - DAY, { at, branchId: 'hot' }, [syntheticBranch('hot', -1, 0.3, plan), syntheticBranch('cool', 1, 0.7)]);
    const call = decideCall(real(NOV17, { catalysts: [cat] }), null);
    expect(call.call).toMatch(/short$/);
    expect(call.trade).toEqual(plan);
    expect(call.killCondition).toMatchObject({ level: 27350, side: 'above' });
    expect(call.expiresAt).toBe(plan.timeStop.at);
  });

  it('the 0.85 cap holds under extreme inputs, and Strong needs three independent factors', () => {
    const T = fromZoned(2026, 11, 18, 11, 0), k = DATUM_KEYS.rate('US10Y');
    const snap = syntheticSnapshot(T, {
      candles: syntheticSet('NQ', T, 25000, 3),
      peers: { SOX: syntheticSet('SOX', T, 5000, 6), QQQ: syntheticSet('QQQ', T, 600, 3), XLP: syntheticSet('XLP', T, 80, -1), XLU: syntheticSet('XLU', T, 80, -1), DXY: syntheticSet('DXY', T, 100, -1), BTC: syntheticSet('BTC', T, 60000, 5) },
      data: { [k]: syntheticDatum(k, 4.7, T - MIN) },
      dataHistory: { [k]: [syntheticDatum(k, 4.95, T - DAY - MIN), syntheticDatum(k, 4.8, T - HOUR - MIN), syntheticDatum(k, 4.7, T - MIN)] },
      catalysts: [syntheticCatalyst(T - 30 * MIN, T - DAY, { at: T - 30 * MIN, branchId: 'cool' }, [syntheticBranch('hot', -1, 0.9), syntheticBranch('cool', 1, 0.1)])],
      structure: [syntheticEvent('m', T - 10 * MIN), syntheticEvent('s', T - 5 * MIN, { detector: 'sweep_reclaim', kind: 'sweep_low_reclaim', confirmedSetup: true, confidence: 1 })],
      headlines: [1, 2, 3].map((i) => syntheticHeadline(`p${i}`, T - i * 10 * MIN, 3, 1)),
    });
    const call = decideCall(snap, null);
    expect(call.call).toBe('strong_long');
    expect(call.score).toBeGreaterThan(1.75);
    expect(call.probability).toBe(0.85);
    // A calibration map that wants to push higher still cannot.
    const hot = { buckets: [{ lo: 0.8, hi: 0.85, n: 40, shift: 0.1 }] };
    expect(decideCall(snap, null, { calibration: hot }).probability).toBe(0.85);
    expect(applyCalibration(hot, 0.84)).toBe(0.85);
    expect(probabilityFromScore(2)).toBe(0.85);
    expect(probabilityFromScore(0.2)).toBe(0.5);
    for (let s = 0; s < 2; s += 0.05) expect(probabilityFromScore(s + 0.05)).toBeGreaterThanOrEqual(probabilityFromScore(s));
    expect(labelFromScore(1.6, 2, false)).toBe('lean_long');
    expect(labelFromScore(1.6, 3, false)).toBe('strong_long');
    expect(labelFromScore(-1.6, 3, true)).toBe('lean_short');
    expect(labelFromScore(0.2, 5, false)).toBe('no_edge');
  });

  it('every call carries its inputs and can be replayed to the same output', () => {
    const structure = bearish(NOV17);
    const first = decideCall(real(NOV17, { structure }), null);
    const at = NOV17 + 30 * MIN;
    const cat = syntheticCatalyst(at, NOV17 - DAY, { at, branchId: 'hot' });
    const calib = { buckets: [{ lo: 0.6, hi: 0.65, n: 30, shift: -0.04 }, { lo: 0.65, hi: 0.7, n: 25, shift: -0.02 }] };
    const calls = [
      decideCall(real(NOV17), null),
      first,
      decideCall(real(at + 5 * MIN, { structure, catalysts: [cat] }), first, { calibration: calib }),
      decideCall(real(NOV17, { structure, horizon: 'swing' }), null),
      decideCall(real(fromZoned(2026, 11, 20, 17, 0), { structure: bearish(fromZoned(2026, 11, 20, 17, 0)), horizon: 'position' }), null),
    ];
    expect(new Set(calls.map((c) => c.trigger.kind))).toEqual(new Set(['initial', 'print']));
    for (const call of calls) {
      const stored = roundTrip(call);
      expect(stored.inputs).toHaveProperty('features');
      expect(stored.createdAt).toBe((stored.inputs as { features: { now: string } }).features.now);
      expect(replayCall(stored)).toEqual(stored);
      expect(JSON.stringify(stored.inputs).length).toBeLessThan(20_000);
    }
  });
});
