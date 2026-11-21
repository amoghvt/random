import { describe, expect, it } from 'vitest';
import { DAY, DATUM_KEYS, HOUR, MIN, fromZoned } from '@desk/contracts';
import { isTradingDay, opexDay, thanksgiving, usMarketHolidays, horizonEnd, tradingAgeMs } from './calendar';
import { extractInputs } from './extract';
import { SCORERS, scoreFactors } from './factors';
import { snapshotFromHistory } from './history';
import { effectiveWeights } from './scoring';
import { recordedCandlesByKey, syntheticCandles, syntheticCatalyst, syntheticDatum, syntheticEvent, syntheticHeadline, syntheticSet, syntheticSnapshot } from './testkit';
import type { BiasSnapshot } from './types';
import type { FactorName } from '@desk/contracts';

const by = recordedCandlesByKey();
const real = (now: number, horizon: BiasSnapshot['horizon'] = 'swing'): BiasSnapshot =>
  snapshotFromHistory({ now, instrument: 'NQ', horizon, candlesByKey: by, dataHistory: {}, catalysts: [], structure: [], headlines: [] });
const score = (f: FactorName, s: BiasSnapshot) => SCORERS[f](extractInputs(s));
const NOV20 = fromZoned(2026, 11, 20, 17, 0);
const T = fromZoned(2026, 11, 18, 11, 0); // a Wednesday, cash session, for synthetic cases

describe('calendar derived from the date', () => {
  it('knows the 2026 holidays, OpEx and session ends', () => {
    expect(thanksgiving(2026)).toBe('2026-11-26');
    expect(usMarketHolidays(2026).has('2026-04-03')).toBe(true); // Good Friday
    expect(usMarketHolidays(2026).has('2026-07-03')).toBe(true); // July 4 on a Saturday
    expect(opexDay(2026, 11)).toBe('2026-11-20');
    expect(isTradingDay('2026-11-26')).toBe(false);
    expect(horizonEnd(fromZoned(2026, 11, 20, 10, 0), 'intraday')).toBe(fromZoned(2026, 11, 20, 16, 0));
    expect(horizonEnd(fromZoned(2026, 11, 20, 17, 0), 'intraday')).toBe(fromZoned(2026, 11, 23, 16, 0));
    // 3 trading days after Mon Nov 23 skips Thanksgiving and lands on the 13:00 early close.
    expect(horizonEnd(fromZoned(2026, 11, 23, 10, 0), 'swing')).toBe(fromZoned(2026, 11, 27, 13, 0));
    expect(tradingAgeMs(fromZoned(2026, 11, 20, 20, 0), fromZoned(2026, 11, 23, 2, 0))).toBe(6 * HOUR);
  });
});

describe('factor scorers on recorded candles', () => {
  it('regime on NQ daily as of 2026-11-20, after the week\'s ~10% drop', () => {
    const inp = extractInputs(real(NOV20));
    const d = inp.regime.d1!;
    const f = SCORERS.regime(inp);
    console.log(`regime NQ swing as of 2026-11-20 17:00 ET: score ${f.score} | ${f.evidence}`);
    expect(d.close).toBeGreaterThan(25000);
    expect(d.close).toBeLessThan(25400);
    expect(d.ret5Pct!).toBeLessThan(-9);
    expect(d.ret5Pct!).toBeGreaterThan(-12);
    expect(d.close).toBeLessThan(d.ema200!);
    expect(d.ema200SlopePct!).toBeLessThan(0);
    expect(f.score).toBeLessThanOrEqual(-1.5);
    expect(f.evidence).toContain('bounces are sold');
    expect(f.stale).toBe(false);
  });
  it('rates on 2026-11-20: the 10Y fell about 14 bp through 5.00% while NQ fell', () => {
    const inp = extractInputs(real(NOV20));
    const f = SCORERS.rates(inp);
    console.log(`rates: ${f.score} | ${f.evidence}`);
    expect(inp.rates.y10!.level).toBeCloseTo(4.91, 1);
    expect(inp.rates.y10!.chg1dBp!).toBeLessThan(-10);
    expect(f.score).toBeGreaterThan(0);
    expect(f.evidence).toContain('down through 5.00%');
    expect(f.evidence).toContain('haven bid');
  });
  it('breadth, positioning and cross-asset on 2026-11-20 read risk-off, with the fade on VIX', () => {
    const inp = extractInputs(real(NOV20));
    const b = SCORERS.breadth(inp), p = SCORERS.positioning(inp), x = SCORERS.cross_asset(inp);
    console.log(`breadth: ${b.score} | ${b.evidence}\npositioning: ${p.score} | ${p.evidence}\ncross: ${x.score} | ${x.evidence}`);
    expect(inp.breadth.sox!).toBeLessThan(inp.breadth.index!);
    expect(b.score).toBeLessThan(-0.5);
    expect(inp.positioning.vix!.pctile1y!).toBeGreaterThan(0.95);
    expect(p.score).toBeGreaterThan(0);
    expect(x.evidence).toContain('regime-change flag');
  });
  it('calendar for the session of 2026-11-23: Thanksgiving week, small', () => {
    const inp = extractInputs(real(NOV20));
    const f = SCORERS.calendar(inp);
    expect(inp.calendar.sessionDay).toBe('2026-11-23');
    expect(inp.calendar.thanksgivingWeek).toBe(true);
    expect(f.score).toBeGreaterThan(0);
    expect(f.score).toBeLessThanOrEqual(0.75);
    expect(f.evidence).toContain('spec prior');
  });
  it('every factor stays inside -2..+2 with an evidence line and an as-of', () => {
    for (const now of [NOV20, fromZoned(2026, 11, 16, 11, 0), fromZoned(2026, 10, 14, 10, 30)]) {
      for (const h of ['intraday', 'swing', 'position'] as const) {
        const fs = scoreFactors(extractInputs(real(now, h)));
        expect(fs).toHaveLength(10);
        for (const f of fs) {
          expect(Math.abs(f.score)).toBeLessThanOrEqual(2);
          expect(f.evidence.length).toBeGreaterThan(3);
          expect(Date.parse(f.asOf)).toBeLessThanOrEqual(now);
        }
      }
    }
  });
});

describe('factor scorers on synthetic cases, for sign', () => {
  it('regime: synthetic uptrend is positive, synthetic downtrend negative', () => {
    expect(score('regime', syntheticSnapshot(T, { candles: syntheticSet('NQ', T, 25000, 0.25) })).score).toBeGreaterThan(1);
    expect(score('regime', syntheticSnapshot(T, { candles: syntheticSet('NQ', T, 25000, -0.25) })).score).toBeLessThan(-1);
  });
  it('rates: yields up through 5.00% with stocks down is negative; yields down with stocks up is positive', () => {
    const k = DATUM_KEYS.rate('US10Y');
    const up = syntheticSnapshot(T, {
      candles: syntheticSet('NQ', T, 25000, -1), data: { [k]: syntheticDatum(k, 5.03, T - MIN) },
      dataHistory: { [k]: [syntheticDatum(k, 4.9, T - DAY - MIN), syntheticDatum(k, 4.97, T - HOUR - MIN), syntheticDatum(k, 5.03, T - MIN)] },
    });
    const f = score('rates', up);
    expect(f.score).toBeLessThanOrEqual(-1.5);
    expect(f.evidence).toContain('up through 5.00%');
    const down = syntheticSnapshot(T, {
      candles: syntheticSet('NQ', T, 25000, 1), data: { [k]: syntheticDatum(k, 4.84, T - MIN) },
      dataHistory: { [k]: [syntheticDatum(k, 4.95, T - DAY - MIN), syntheticDatum(k, 4.89, T - HOUR - MIN), syntheticDatum(k, 4.84, T - MIN)] },
    });
    expect(score('rates', down).score).toBeGreaterThanOrEqual(1.5);
  });
  it('rates: a stale datum is flagged and not used', () => {
    const k = DATUM_KEYS.rate('US10Y');
    const f = score('rates', syntheticSnapshot(T, { data: { [k]: syntheticDatum(k, 5.03, T - 10 * MIN, 60) } }));
    expect(f.stale).toBe(true);
    expect(f.score).toBe(0);
    expect(f.evidence).toMatch(/^stale, not used: 10Y 5\.03% as of 10m ago/);
  });
  it('fed: hike odds rising is negative, a dovish shift positive', () => {
    const mk = (hike: [number, number], cut: [number, number]): BiasSnapshot => syntheticSnapshot(T, {
      data: { [DATUM_KEYS.fedHike]: syntheticDatum(DATUM_KEYS.fedHike, hike[1], T - MIN, 3600), [DATUM_KEYS.fedCut]: syntheticDatum(DATUM_KEYS.fedCut, cut[1], T - MIN, 3600) },
      dataHistory: {
        [DATUM_KEYS.fedHike]: [syntheticDatum(DATUM_KEYS.fedHike, hike[0], T - DAY - HOUR, 3600)],
        [DATUM_KEYS.fedCut]: [syntheticDatum(DATUM_KEYS.fedCut, cut[0], T - DAY - HOUR, 3600)],
      },
    });
    const hawk = score('fed', mk([0.3, 0.45], [0.1, 0.1]));
    expect(hawk.score).toBeCloseTo(-1.5, 5);
    expect(hawk.evidence).toContain('Hike odds +15 pts to 45%');
    expect(score('fed', mk([0.3, 0.3], [0.1, 0.3])).score).toBe(2);
    expect(score('fed', syntheticSnapshot(T)).evidence).toBe('no data');
  });
  it('catalyst: a resolved branch sets the sign and fades after 2 hours; an upcoming one scores its skew', () => {
    const cat = (resolvedAgo: number, branch: string) => syntheticSnapshot(T, { catalysts: [syntheticCatalyst(T - resolvedAgo, T - DAY, { at: T - resolvedAgo, branchId: branch })] });
    const hot = score('catalyst', cat(30 * MIN, 'hot'));
    expect(hot.score).toBe(-2);
    expect(hot.evidence).toContain('branch "hot" (p 0.30)');
    expect(score('catalyst', cat(30 * MIN, 'cool')).score).toBeGreaterThan(1.5);
    const later = score('catalyst', cat(5 * HOUR, 'hot')).score;
    expect(later).toBeLessThan(0);
    expect(later).toBeGreaterThan(-1.5);
    const upcoming = score('catalyst', syntheticSnapshot(T, { catalysts: [syntheticCatalyst(T + 2 * HOUR, T - DAY, null)] }));
    expect(upcoming.score).toBeCloseTo(0.4, 5); // 0.7 cool - 0.3 hot
    expect(score('catalyst', syntheticSnapshot(T)).missing).toBe(true);
  });
  it('breadth: chips leading is positive; defensives bid with the index flat is negative', () => {
    const peers = (sox: number, def: number) => ({ SOX: syntheticSet('SOX', T, 5000, sox), QQQ: syntheticSet('QQQ', T, 600, 0), XLP: syntheticSet('XLP', T, 80, def), XLU: syntheticSet('XLU', T, 80, def) });
    expect(score('breadth', syntheticSnapshot(T, { peers: peers(2, -0.5) })).score).toBeGreaterThan(1);
    expect(score('breadth', syntheticSnapshot(T, { peers: peers(0, 1.5) })).score).toBeLessThan(-0.5);
  });
  it('positioning: crowded long by CFTC z-score is faded, at full weight only after a catalyst', () => {
    const k = DATUM_KEYS.cftc('NQ');
    const hist = Array.from({ length: 30 }, (_, i) => syntheticDatum(k, 1000 + (i % 5) * 100, T - (31 - i) * 7 * DAY, 7 * 86400));
    const base = { data: { [k]: syntheticDatum(k, 3000, T - DAY, 7 * 86400) }, dataHistory: { [k]: hist } };
    const before = score('positioning', syntheticSnapshot(T, base));
    const after = score('positioning', syntheticSnapshot(T, { ...base, catalysts: [syntheticCatalyst(T - HOUR, T - DAY, { at: T - HOUR, branchId: 'cool' })] }));
    expect(before.score).toBe(-1);
    expect(after.score).toBe(-2);
    expect(after.evidence).toContain('crowded long');
  });
  it('news: three negative impact-3 headlines in a day is negative', () => {
    const f = score('news', syntheticSnapshot(T, { headlines: [1, 2, 3].map((i) => syntheticHeadline(`h${i}`, T - i * HOUR, 3, -1)) }));
    expect(f.score).toBe(-2);
    expect(f.evidence).toContain('3 negative impact-3 headlines in 24h');
    expect(score('news', syntheticSnapshot(T, { headlines: [syntheticHeadline('p', T - HOUR, 2, 1)] })).score).toBe(0.5);
  });
  it('structure: a bounce stalled under 50% is negative, a bullish MSS positive, liquidity alone is no direction', () => {
    const stalled = syntheticEvent('e1', T - 30 * MIN, { detector: 'retrace_quality', kind: 'bounce_stalled_under_50', bias: -1, level: 25200, text: 'Bounce 38% of the drop, stalled under 25,200' });
    const f = score('structure', syntheticSnapshot(T, { structure: [stalled] }));
    expect(f.score).toBeLessThan(-0.5);
    expect(f.evidence).toContain('bounce_stalled_under_50');
    expect(score('structure', syntheticSnapshot(T, { structure: [syntheticEvent('e2', T - 30 * MIN)] })).score).toBeGreaterThan(0.5);
    const pools = [syntheticEvent('p1', T - HOUR, { detector: 'liquidity_pool', kind: 'equal_highs', bias: 0, level: 25300 }), syntheticEvent('p2', T - HOUR, { detector: 'liquidity_pool', kind: 'equal_lows', bias: 0, level: 24700 })];
    const liq = score('structure', syntheticSnapshot(T, { structure: pools }));
    expect(liq.score).toBe(0);
    expect(liq.evidence).toContain('25,300 above / 24,700 below');
  });
  it('cross-asset: oil spiking with yields up is negative', () => {
    const y = syntheticCandles('US10Y', '1d', 60, T, 5.1, 0.2);
    const f = score('cross_asset', syntheticSnapshot(T, { peers: { CL: syntheticSet('CL', T, 80, 3), US10Y: { m15: [], h1: [], d1: y } } }));
    expect(f.score).toBeLessThan(-1);
    expect(f.evidence).toContain('oil spiking');
  });
});

describe('missing data', () => {
  it('scores 0 with "no data" and its weight is redistributed', () => {
    const s = real(NOV20);
    const raw = scoreFactors(extractInputs(s));
    const missing = raw.filter((r) => r.missing).map((r) => r.factor);
    expect(missing).toEqual(expect.arrayContaining(['catalyst', 'fed', 'news', 'structure']));
    for (const r of raw.filter((x) => x.missing)) { expect(r.score).toBe(0); expect(r.evidence).toMatch(/^no data/); }
    const w = effectiveWeights(raw, s.weights, s.horizon, false);
    for (const f of missing) expect(w[f]).toBe(0);
    expect(Object.values(w).reduce((a, x) => a + x, 0)).toBeCloseTo(1, 9);
    // rates was 0.20 of 1.05; with four factors gone it carries more.
    expect(w.rates).toBeGreaterThan(0.3);
  });
});
