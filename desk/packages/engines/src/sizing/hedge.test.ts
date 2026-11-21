import { describe, expect, it } from 'vitest';
import { loadRecordedCandles } from '@desk/feeds';
import { HedgeViolation, type Candle } from '@desk/contracts';
import { HEDGE_CORRELATION_THRESHOLD, correlationMatrix, correlationOf, detectHedges, type Exposure } from './index';
import { RULES } from './testkit';

const SYMBOLS = ['NQ', 'ES', 'NVDA', 'AMZN', 'GC', 'CL', 'BTC'];
/** 60-day daily-return correlations from the recorded Yahoo daily candles (through 2026-11-20). */
const CORR = correlationMatrix(Object.fromEntries(SYMBOLS.map((s) => [s, loadRecordedCandles(s, '1d')])));

describe('correlationMatrix on recorded daily candles', () => {
  it('NQ vs NVDA is strongly positive; NQ vs gold, oil and BTC is not', () => {
    console.info(`[hedge] 60-day correlation vs NQ: ${SYMBOLS.map((s) => `${s} ${CORR.NQ![s]!.toFixed(2)}`).join(', ')}`);
    expect(CORR.NQ!.NQ).toBe(1);
    expect(CORR.NQ!.NVDA!).toBeGreaterThan(HEDGE_CORRELATION_THRESHOLD);
    expect(CORR.NQ!.ES!).toBeGreaterThan(0.9);
    expect(CORR.NQ!.NVDA).toBeCloseTo(CORR.NVDA!.NQ!, 12);
    for (const s of ['GC', 'CL', 'BTC']) expect(Math.abs(CORR.NQ![s]!), s).toBeLessThan(HEDGE_CORRELATION_THRESHOLD);
  });

  it('NQ, NQ-PERP and MNQ are one underlying', () => {
    expect(correlationOf('NQ', 'NQ-PERP', {})).toBe(1);
    expect(correlationOf('MNQ', 'NQ-PERP', {})).toBe(1);
    expect(correlationOf('NQ-PERP', 'NVDA', CORR)).toBe(CORR.NQ!.NVDA);
    expect(correlationOf('NQ', 'TTWO', CORR)).toBeNull();
  });

  it('is exact on synthetic series', () => {
    const mk = (symbol: string, closes: number[]): Candle[] => closes.map((c, i) => ({ symbol, tf: '1d' as const, t: Date.UTC(2026, 0, 5 + i, 15), o: c, h: c, l: c, c, v: 1, source: 'synthetic' }));
    const a = [100]; const b = [50]; const inv = [80];
    for (let i = 1; i < 40; i++) { const r = ((i * 37) % 11 - 5) / 100; a.push(a[i - 1]! * (1 + r)); b.push(b[i - 1]! * (1 + r)); inv.push(inv[i - 1]! * (1 - r)); }
    const m = correlationMatrix({ A: mk('A', a), B: mk('B', b), INV: mk('INV', inv), SHORT: mk('SHORT', a.slice(0, 5)) });
    expect(m.A!.B).toBeCloseTo(1, 9);
    expect(m.A!.INV).toBeCloseTo(-1, 9);
    expect(Number.isNaN(m.A!.SHORT!)).toBe(true);
  });
});

describe('detectHedges', () => {
  const nqShort: Exposure = { accountId: 'apex-50k', instrument: 'NQ', direction: 'short' };
  const nqLong: Exposure = { ...nqShort, direction: 'long' };
  const nvdaLong: Exposure = { accountId: 'vest-instant', instrument: 'NVDA', direction: 'long' };

  it('hedge detection fires on NQ short + NVDA long, before the second order, with the firm clause', () => {
    const v = detectHedges([nqShort], nvdaLong, RULES, CORR);
    expect(v.length).toBe(1);
    expect(HedgeViolation.safeParse(v[0]).success).toBe(true);
    expect(v[0]).toMatchObject({ accountA: 'apex-50k', accountB: 'vest-instant', instrumentA: 'NQ', instrumentB: 'NVDA' });
    expect(v[0]!.correlation).toBe(CORR.NQ!.NVDA);
    expect(v[0]!.clause).toContain('Vest: coordinating accounts incl. opposite positions is prohibited.');
    expect(v[0]!.clause).toContain('Apex');
    expect(v[0]!.text).toBe(`Blocked: long NVDA on Vest Instant offsets short NQ on Apex 50K, correlation ${CORR.NQ!.NVDA!.toFixed(2)} over 60 days. Vest: coordinating accounts incl. opposite positions is prohibited.`);
  });

  it('does not fire on NQ long + NVDA long', () => {
    expect(detectHedges([nqLong], nvdaLong, RULES, CORR)).toEqual([]);
  });

  it('opposite positions on two Vest accounts fire as the same underlying', () => {
    const v = detectHedges([{ accountId: 'vest-instant', instrument: 'NQ-PERP', direction: 'long' }], { accountId: 'vest-eval', instrument: 'NQ-PERP', direction: 'short' }, RULES, {});
    expect(v.length).toBe(1);
    expect(v[0]!.correlation).toBe(1);
    expect(v[0]!.text).toBe('Blocked: short NQ-PERP on Vest Evaluation offsets long NQ-PERP on Vest Instant, same underlying. Vest: coordinating accounts incl. opposite positions is prohibited.');
    // MNQ on a CME firm against the Vest perp is the same underlying too.
    expect(detectHedges([{ accountId: 'lucid-25k', instrument: 'MNQ', direction: 'short' }], { accountId: 'vest-instant', instrument: 'NQ-PERP', direction: 'long' }, RULES, {}).length).toBe(1);
  });

  it('ignores the same account, weak correlations and unknown pairs; audits open positions with no pending order', () => {
    expect(detectHedges([nqShort], { accountId: 'apex-50k', instrument: 'MNQ', direction: 'long' }, RULES, CORR)).toEqual([]);
    expect(detectHedges([nqShort], { accountId: 'vest-instant', instrument: 'BTC', direction: 'long' }, RULES, CORR)).toEqual([]);
    expect(detectHedges([nqShort], { accountId: 'vest-instant', instrument: 'TTWO', direction: 'long' }, RULES, CORR)).toEqual([]);
    const audit = detectHedges([nqShort, nvdaLong], null, RULES, CORR);
    expect(audit.length).toBe(1);
    expect(audit[0]!.text).toMatch(/^Rule violation: /);
    // A strongly negative correlation makes same-direction positions the offsetting pair (synthetic matrix).
    const synthetic = { NQ: { GC: -0.8 } };
    expect(detectHedges([nqLong], { accountId: 'lucid-25k', instrument: 'GC', direction: 'long' }, RULES, synthetic).length).toBe(1);
    expect(detectHedges([nqLong], { accountId: 'lucid-25k', instrument: 'GC', direction: 'short' }, RULES, synthetic)).toEqual([]);
    // Threshold is a parameter.
    expect(detectHedges([nqShort], nvdaLong, RULES, CORR, 0.95)).toEqual([]);
  });
});
