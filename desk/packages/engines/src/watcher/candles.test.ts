import { describe, expect, it } from 'vitest';
import { fromZoned, type Candle } from '@desk/contracts';
import { aggregate, atr, buildLegs, closedCandles, ema, fractals, meanVolume, sessionBounds, sessionSlice } from './candles';
import { synthetic } from './synthetic.testkit';

const minute = (t: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ symbol: 'SYN', tf: '1m', t, o, h, l, c, v, source: 'synthetic' });

describe('candle utilities (synthetic candles)', () => {
  it('aggregates 1m into clock-aligned buckets, keeping gaps as gaps', () => {
    const t0 = fromZoned(2026, 1, 6, 9, 30);
    const m1 = [minute(t0, 10, 11, 9, 10.5, 5), minute(t0 + 60_000, 10.5, 12, 10, 11, 0), minute(t0 + 4 * 60_000, 11, 11.5, 8, 9, 7), minute(t0 + 5 * 60_000, 9, 9.5, 8.5, 9.2, 1)];
    const m5 = aggregate(m1, '5m');
    expect(m5).toHaveLength(2);
    expect(m5[0]).toMatchObject({ t: t0, tf: '5m', o: 10, h: 12, l: 8, c: 9, v: 12 });
    expect(m5[1]).toMatchObject({ t: t0 + 300_000, o: 9, c: 9.2, v: 1 });
    expect(aggregate(m1, '1d')[0]!.t).toBe(fromZoned(2026, 1, 6, 0, 0));
  });

  it('closedCandles drops the forming candle', () => {
    const tape = synthetic(100, '15m').calm(3).candles;
    expect(closedCandles(tape, tape[2]!.t + 14 * 60_000)).toHaveLength(2);
    expect(closedCandles(tape, tape[2]!.t + 15 * 60_000)).toHaveLength(3);
  });

  it('EMA is null until seeded with the SMA, then follows the recursion', () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBeCloseTo(2);
    expect(e[3]).toBeCloseTo(3);
    expect(e[4]).toBeCloseTo(4);
  });

  it('ATR counts gaps through the previous close', () => {
    const tape = synthetic(100).calm(14).raw(110, 111, 109, 110).candles;
    const a = atr(tape, 14);
    expect(a[13]).toBeNull();
    expect(a[14]).toBeCloseTo((2 * 13 + 11.25) / 14, 1);
  });

  it('slices sessions in ET', () => {
    const { from, to } = sessionBounds('2026-11-16', 'cash');
    expect(from).toBe(fromZoned(2026, 11, 16, 9, 30));
    expect(to).toBe(fromZoned(2026, 11, 16, 16, 0));
    expect(sessionBounds('2026-11-16', 'globex').from).toBe(fromZoned(2026, 11, 15, 18, 0));
    const tape = synthetic(100, '15m', fromZoned(2026, 11, 16, 9, 0)).calm(30).candles;
    const cash = sessionSlice(tape, '2026-11-16', 'cash');
    expect(cash[0]!.t).toBe(from);
    expect(cash).toHaveLength(26);
  });

  it('finds fractals only once two candles have closed after them, and builds legs between them', () => {
    const tape = synthetic(100).to(110, 3).to(96, 4).to(101, 3).candles;
    const p = fractals(tape, 2);
    expect(p.map((x) => [x.type, x.level, x.confirmedI])).toEqual([['high', 110.2, 4], ['low', 95.8, 8]]);
    expect(fractals(tape.slice(0, 4), 2)).toHaveLength(0);
    const legs = buildLegs(p, tape.map(() => 2));
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ dir: -1 });
    expect(legs[0]!.size).toBeCloseTo(14.4);
    expect(legs[0]!.atrMult).toBeCloseTo(7.2);
  });

  it('mean volume ignores zero-volume candles and says when none remain', () => {
    const tape = synthetic(100).raw(1, 2, 0, 1, 0).raw(1, 2, 0, 1, 300).raw(1, 2, 0, 1, 100).candles;
    expect(meanVolume(tape, 0, 2)).toEqual({ mean: 200, zero: 1, n: 3 });
    expect(meanVolume(tape, 0, 0).mean).toBeNull();
  });
});
