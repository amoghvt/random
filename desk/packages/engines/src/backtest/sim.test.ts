import { describe, expect, it } from 'vitest';
import { iso, type BiasCall, type Candle, type TradePlan } from '@desk/contracts';
import { simulate, stitch, type SimAccount } from './sim';

/** Synthetic minute bars from a list of [o,h,l,c] starting at T0. */
const T0 = Date.parse('2026-11-17T15:00:00Z');
const bars = (rows: Array<[number, number, number, number]>, start = T0): Candle[] =>
  rows.map(([o, h, l, c], i) => ({ symbol: 'NQ', tf: '1m', t: start + i * 60_000, o, h, l, c, v: 100, source: 'synthetic' }));

function call(id: string, dir: 'long' | 'short', at: number, plan: Partial<TradePlan> = {}, horizon: BiasCall['horizon'] = 'intraday'): BiasCall {
  const s = dir === 'long' ? 1 : -1;
  const trade: TradePlan = {
    instrument: 'NQ', direction: dir, referencePrice: 1000,
    entry: { kind: 'condition', text: 'synthetic entry' },
    targets: [{ price: 1000 + 10 * s, fraction: 1 / 3 }, { price: 1000 + 20 * s, fraction: 1 / 3 }, { price: 1000 + 30 * s, fraction: 1 / 3 }],
    invalidation: { price: 1000 - 10 * s, reason: 'synthetic invalidation' },
    timeStop: { at: iso(at + 60 * 60_000), text: 'synthetic' },
    ...plan,
  };
  return {
    id, instrument: 'NQ', horizon, call: dir === 'long' ? 'lean_long' : 'lean_short', probability: 0.6, score: 0.5,
    factors: [], facts: [], trade, killCondition: { text: 'synthetic' }, nextCatalyst: null,
    expiresAt: iso(at + 2 * 60 * 60_000), createdAt: iso(at), trigger: { kind: 'initial', ref: 'synthetic' },
    firstMoveUntrusted: false, referencePrice: 1000, inputs: {},
  };
}

const ACCT: SimAccount = { balance: 10_000, leverage: 10, drawdownPct: 6, dailyLossPct: null, feeUsd: 400, slippagePts: 0 };

describe('backtest simulate', () => {
  it('a long that runs through all three targets claims the profit', () => {
    const c = bars([[1000, 1001, 999.5, 1000], [1000, 1012, 999.5, 1011], [1011, 1025, 1010, 1024], [1024, 1035, 1023, 1034]]);
    const r = simulate([call('a', 'long', T0 - 1)], c, { kind: 'daily', horizons: ['intraday'] }, ACCT);
    // 100k notional; +1%, +2%, +3% on thirds = 1000/3 + 2000/3 + 3000/3 = 2,000.
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.exit).toBe('target');
    expect(r.trades[0]!.pnlUsd).toBeCloseTo(2000, 0);
    expect(r.stats.claimedUsd).toBeCloseTo(2000, 0);
    expect(r.stats.netUsd).toBeCloseTo(1600, 0);
  });

  it('a bar touching the stop and the target counts as the stop', () => {
    const c = bars([[1000, 1000.5, 999.5, 1000], [1000, 1015, 985, 1000]]);
    // 5x on 10k: the 6% floor fails at -1.2% (988), so the -1% stop (990) is hit first: -$500.
    const r = simulate([call('b', 'long', T0 - 1)], c, { kind: 'daily', horizons: ['intraday'] }, { ...ACCT, leverage: 5 });
    expect(r.trades[0]!.exit).toBe('stop');
    expect(r.trades[0]!.pnlUsd).toBeCloseTo(-500, 0);
    expect(r.stats.accountsBlown).toBe(0);
  });

  it('full port at 50x with a 6% floor blows on a 0.12% adverse move and costs a second fee', () => {
    const c = bars([[1000, 1000.2, 999.9, 1000], [1000, 1000.1, 998.5, 999]]);
    const r = simulate([call('c', 'long', T0 - 1)], c, { kind: 'daily', horizons: ['intraday'] }, { ...ACCT, leverage: 50 });
    expect(r.trades[0]!.failPrice).toBeCloseTo(998.8, 1);
    expect(r.trades[0]!.blown).toBe(true);
    expect(r.trades[0]!.pnlUsd).toBe(-600);
    expect(r.stats.accountsBought).toBe(2);
    expect(r.stats.netUsd).toBe(-800);
  });

  it('a daily loss limit nearer than the floor sets the fail price', () => {
    const c = bars([[1000, 1000.2, 999.9, 1000], [1000, 1000.1, 999.3, 999.5]]);
    const r = simulate([call('d', 'long', T0 - 1)], c, { kind: 'daily', horizons: ['intraday'] }, { ...ACCT, leverage: 50, dailyLossPct: 3 });
    // 3% of 10k = 300 room on 500k notional = 0.06%.
    expect(r.trades[0]!.failPrice).toBeCloseTo(999.4, 1);
    expect(r.trades[0]!.blown).toBe(true);
  });

  it('the asymmetric strategy targets a multiple of the fee and has no stop inside the fail price', () => {
    // 10x on 10k = 100k notional; 5 x 400 = 2,000 target = +2% = 1020.
    const c = bars([[1000, 1001, 995, 996], [996, 1010, 995, 1009], [1009, 1021, 1008, 1020]]);
    const r = simulate([call('e', 'long', T0 - 1, {}, 'swing')], c, { kind: 'asymmetric', horizons: ['swing'], targetFeeMultiple: 5 }, ACCT);
    expect(r.trades[0]!.exit).toBe('target');
    expect(r.trades[0]!.pnlUsd).toBeCloseTo(2000, 0);
  });

  it('takes one position at a time and skips a call that arrives while one is open', () => {
    const c = bars([[1000, 1001, 999.5, 1000], [1000, 1005, 999.5, 1004], [1004, 1006, 1003, 1005], [1005, 1012, 1004, 1011]]);
    const r = simulate([call('f1', 'long', T0 - 1), call('f2', 'long', T0 + 60_000)], c, { kind: 'daily', horizons: ['intraday'] }, ACCT);
    expect(r.trades.map((t) => t.callId)).toEqual(['f1']);
  });

  it('a price trigger that never trades does not fill', () => {
    const c = bars([[1000, 1001, 999.5, 1000], [1000, 1002, 999.5, 1001]]);
    const r = simulate([call('g', 'long', T0 - 1, { entry: { kind: 'price', text: 'synthetic limit 990', price: 990 } })], c, { kind: 'daily', horizons: ['intraday'] }, ACCT);
    expect(r.trades).toHaveLength(0);
    expect(r.stats.netUsd).toBe(-400);
  });

  it('stitch replaces coarse bars with finer ones from the first fine bar on', () => {
    const coarse = bars([[1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]], T0);
    const fine = bars([[9, 9, 9, 9]], T0 + 60_000);
    expect(stitch([coarse, fine]).map((c) => c.o)).toEqual([1, 9]);
  });
});
