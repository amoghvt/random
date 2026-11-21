import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, FactorName, HOUR, MIN, fromZoned, iso, type BiasCall, type Candle } from '@desk/contracts';
import { addDays, isTradingDay } from './calendar';
import { decideCall } from './decide';
import { snapshotFromHistory } from './history';
import { calibration, scoreOutcome } from './outcome';
import { REFIT_MAX_STEP, refitWeights } from './refit';
import { applyCalibration, buildCalibrationMap, normaliseWeights } from './scoring';
import { recordedCandlesByKey, syntheticEvent } from './testkit';

const by = recordedCandlesByKey();

/** A synthetic resolved call: only the fields calibration and the re-fit read. */
function syntheticCall(i: number, probability: number, correct: boolean | null, scores: Partial<Record<FactorName, number>> = {}, long = true): BiasCall {
  return {
    id: `synthetic_${i}`, instrument: 'NQ', horizon: 'intraday', call: correct === null ? 'no_edge' : long ? 'lean_long' : 'lean_short', probability, score: 0.5,
    factors: FactorName.options.map((f) => ({ factor: f, score: scores[f] ?? 0, weight: f in scores ? 0.2 : 0, evidence: 'synthetic', asOf: iso(0), stale: false })),
    facts: [], trade: null, killCondition: { text: 'synthetic' }, nextCatalyst: null, expiresAt: iso(HOUR), createdAt: iso(0),
    trigger: { kind: 'initial', ref: 'synthetic' }, firstMoveUntrusted: false, referencePrice: 100, inputs: {},
    outcome: { resolvedAt: iso(HOUR), movePct: correct ? 0.4 : -0.4, correct },
  };
}
const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ symbol: 'NQ', tf: '15m', t, o, h, l, c, v: 1, source: 'synthetic' });

describe('scoreOutcome', () => {
  const base: BiasCall = {
    ...syntheticCall(0, 0.6, true), createdAt: iso(0), expiresAt: iso(HOUR), outcome: undefined,
    trade: {
      instrument: 'NQ', direction: 'long', entry: { kind: 'price', text: 'pullback to 100 that holds', price: 100 }, referencePrice: 100,
      targets: [{ price: 101, fraction: 0.5 }, { price: 102, fraction: 0.3 }, { price: 103, fraction: 0.2 }],
      invalidation: { price: 99, reason: 'trade below 99' }, timeStop: { text: 'flat by the close' },
    },
  };
  const q = 15 * MIN;
  it('is right when T1 trades before the invalidation and wrong the other way round', () => {
    const t1First = [bar(0, 100, 100.5, 99.5, 100.2), bar(q, 100.2, 101.2, 100, 101), bar(2 * q, 101, 101, 98, 98.5), bar(3 * q, 98.5, 99, 98, 98.2)];
    expect(scoreOutcome(base, t1First)).toEqual({ resolvedAt: iso(HOUR), movePct: -1.8, correct: true });
    const invFirst = [bar(0, 100, 100.5, 98.9, 99.5), bar(q, 99.5, 102, 99.5, 101.5), bar(2 * q, 101.5, 102, 101, 101.8), bar(3 * q, 101.8, 102, 101, 101.9)];
    expect(scoreOutcome(base, invFirst)).toEqual({ resolvedAt: iso(HOUR), movePct: 1.9, correct: false });
    // The same bar touching both counts as the invalidation.
    expect(scoreOutcome(base, [bar(0, 100, 101.5, 98.5, 100), bar(q, 100, 100, 100, 100), bar(2 * q, 100, 100, 100, 100), bar(3 * q, 100, 100, 100, 100)])!.correct).toBe(false);
  });
  it('falls back to the sign of the move at expiry with a 0.05% dead band', () => {
    const flat = [0, 1, 2, 3].map((i) => bar(i * q, 100, 100.2, 99.8, 100.03));
    expect(scoreOutcome(base, flat)).toEqual({ resolvedAt: iso(HOUR), movePct: 0.03, correct: false });
    const drift = [0, 1, 2, 3].map((i) => bar(i * q, 100, 100.6, 99.8, 100.5));
    expect(scoreOutcome({ ...base, trade: null }, drift)!.correct).toBe(true);
    expect(scoreOutcome({ ...base, trade: null, call: 'lean_short' }, drift)).toEqual({ resolvedAt: iso(HOUR), movePct: -0.5, correct: false });
  });
  it('No edge gets correct: null, and nothing resolves before the candles reach the expiry', () => {
    const drift = [0, 1, 2, 3].map((i) => bar(i * q, 100, 100.6, 99.8, 100.5));
    expect(scoreOutcome({ ...base, call: 'no_edge', trade: null }, drift)).toEqual({ resolvedAt: iso(HOUR), movePct: 0.5, correct: null });
    expect(scoreOutcome(base, drift.slice(0, 2))).toBeNull();
  });
});

describe('calibration', () => {
  it('calibration buckets render from resolved calls', () => {
    // Engine calls on recorded NQ sessions (10:00 ET, each trading day of the last 6 recorded weeks), resolved on recorded 15m candles.
    // The watcher event that opens the gate is synthetic, so the hit rates printed here are a pipeline check, not a track record.
    const candles = by['NQ.15m']!;
    const calls: BiasCall[] = [];
    for (let k = '2026-10-12'; k <= '2026-11-20'; k = addDays(k, 1)) {
      if (!isTradingDay(k)) continue;
      const [y, m, d] = k.split('-').map(Number) as [number, number, number];
      const now = fromZoned(y, m, d, 10, 0);
      const snap = snapshotFromHistory({
        now, instrument: 'NQ', horizon: 'intraday', candlesByKey: by, dataHistory: {}, catalysts: [], headlines: [],
        structure: [syntheticEvent(`ev_${k}`, now - 15 * MIN, { detector: 'mss', kind: 'mss_bearish', bias: -1, text: 'synthetic MSS' })],
      });
      const call = decideCall(snap, null);
      const outcome = scoreOutcome(call, candles);
      expect(outcome).not.toBeNull();
      calls.push({ ...call, outcome });
    }
    const cal = calibration(calls);
    console.log(`calibration from ${calls.length} engine calls on recorded sessions (${calls.filter((c) => c.call === 'no_edge').length} no-edge excluded):`);
    for (const b of cal.buckets) console.log(`  ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}  n ${String(b.n).padStart(2)}  predicted ${b.predicted.toFixed(3)}  realized ${b.realized == null ? 'n/a' : b.realized.toFixed(3)}`);
    expect(cal.buckets.map((b) => [b.lo, b.hi])).toEqual([[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.75], [0.75, 0.8], [0.8, 0.85]]);
    const directional = calls.filter((c) => c.call !== 'no_edge');
    expect(directional.length).toBeGreaterThan(10);
    expect(cal.n).toBe(directional.length);
    expect(cal.buckets.reduce((a, b) => a + b.n, 0)).toBe(cal.n);
    for (const b of cal.buckets) {
      if (b.n === 0) { expect(b.realized).toBeNull(); continue; }
      expect(b.realized!).toBeGreaterThanOrEqual(0);
      expect(b.realized!).toBeLessThanOrEqual(1);
      expect(b.predicted).toBeGreaterThanOrEqual(b.lo);
      expect(b.predicted).toBeLessThanOrEqual(b.hi);
    }
    for (const c of calls.filter((x) => x.call === 'no_edge')) expect(c.outcome!.correct).toBeNull();
  });
  it('buckets a constructed set exactly, and No edge stays out', () => {
    const calls = [
      ...Array.from({ length: 30 }, (_, i) => syntheticCall(i, 0.62, i < 12)),
      ...Array.from({ length: 10 }, (_, i) => syntheticCall(100 + i, 0.72, i < 9)),
      syntheticCall(200, 0.85, true), syntheticCall(201, 0.5, null),
    ];
    const cal = calibration(calls);
    expect(cal.n).toBe(41);
    expect(cal.buckets[2]).toEqual({ lo: 0.6, hi: 0.65, n: 30, predicted: 0.62, realized: 0.4 });
    expect(cal.buckets[4]).toEqual({ lo: 0.7, hi: 0.75, n: 10, predicted: 0.72, realized: 0.9 });
    expect(cal.buckets[6]!.n).toBe(1);
    expect(cal.buckets[0]!.n).toBe(0);
    const map = buildCalibrationMap(cal.buckets);
    // 30 calls: shrink 30/50 of the way from 0.62 to 0.40. 10 calls: identity.
    expect(map.buckets[2]!.shift).toBeCloseTo(-0.132, 6);
    expect(map.buckets[4]!.shift).toBe(0);
    expect(applyCalibration(map, 0.62)).toBe(0.5);
    expect(applyCalibration(map, 0.72)).toBe(0.72);
    expect(applyCalibration(null, 0.66)).toBe(0.66);
  });
  it('keeps the map monotone when two full buckets come back inverted', () => {
    const calls = [...Array.from({ length: 40 }, (_, i) => syntheticCall(i, 0.57, i < 30)), ...Array.from({ length: 40 }, (_, i) => syntheticCall(100 + i, 0.62, i < 18))];
    const map = buildCalibrationMap(calibration(calls).buckets);
    expect(applyCalibration(map, 0.62)).toBeGreaterThanOrEqual(applyCalibration(map, 0.57));
  });
});

describe('refitWeights', () => {
  it('refuses under 50 resolved directional calls', () => {
    const calls = [...Array.from({ length: 49 }, (_, i) => syntheticCall(i, 0.6, i % 2 === 0, { structure: 1 })), ...Array.from({ length: 30 }, (_, i) => syntheticCall(100 + i, 0.5, null))];
    const { weights, report } = refitWeights(calls, DEFAULT_WEIGHTS);
    expect(weights).toBe(DEFAULT_WEIGHTS);
    expect(report.refit).toBe(false);
    expect(report.reason).toBe('49 resolved directional calls; the re-fit needs 50. Weights unchanged.');
  });
  it('moves weights toward the factors that were right, inside the constraints', () => {
    // Constructed: structure sides with the call exactly when the call is right; regime sides with it exactly when it is wrong.
    const calls = Array.from({ length: 80 }, (_, i) => {
      const right = i % 2 === 0, long = i % 4 < 2, d = long ? 1 : -1;
      return syntheticCall(i, 0.6, right, { structure: d * (right ? 1.5 : -1.5), regime: d * (right ? -1.5 : 1.5), rates: d * (i % 3 === 0 ? 1 : -1) }, long);
    });
    const start = normaliseWeights(DEFAULT_WEIGHTS);
    const total = Object.values(start).reduce((a, x) => a + x, 0);
    const { weights, report } = refitWeights(calls, DEFAULT_WEIGHTS);
    console.log(report.lines.join('\n'));
    expect(report.refit).toBe(true);
    expect(report.n).toBe(80);
    expect(weights.structure).toBeGreaterThan(start.structure / total + 0.02);
    expect(weights.regime).toBeLessThan(start.regime / total - 0.02);
    expect(Object.values(weights).reduce((a, x) => a + x, 0)).toBeCloseTo(1, 3);
    for (const f of FactorName.options) {
      expect(weights[f]).toBeGreaterThanOrEqual(0);
      expect(Math.abs(weights[f] - start[f] / total)).toBeLessThanOrEqual(REFIT_MAX_STEP + 1e-3);
    }
    expect(report.moved[0]!.why).toMatch(/hit \d+% \(\d+\)/);
    expect(report.moved.map((m) => m.factor)).toEqual(expect.arrayContaining(['structure', 'regime']));
    // Deterministic.
    expect(refitWeights(calls, DEFAULT_WEIGHTS).weights).toEqual(weights);
  });
});
