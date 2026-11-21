import { describe, expect, it } from 'vitest';
import { buildHistory, buildRateHistory, canonicalEvents, reactionFor } from './history';
import { candlesAsOf, recordedEvents } from './recorded.testkit';
import type { HistoricalReactionEx } from './types';

const events = recordedEvents();
const nq = candlesAsOf('NQ');
const NOW = Date.parse('2026-11-21T18:00:00Z');

const table = (name: string, rows: HistoricalReactionEx[]): string =>
  [`${name} on NQ`, 'date        actual  cons   surprise  m5%     h1%     close%  reversed  res', ...rows.map((r) =>
    [r.date, String(r.actual).padStart(6), String(r.consensus).padStart(5), String(r.surprise).padStart(8), String(r.m5Pct).padStart(7), String(r.h1Pct).padStart(7), String(r.closePct).padStart(7), String(r.firstMoveReversed).padStart(8), r.resolution].join('  '))].join('\n');

describe('historical reaction table', () => {
  it('History table for CPI/NFP/FOMC computed from recorded candles has 8 rows with real numbers', () => {
    for (const [name, code] of [['CPI (core MoM)', 'CORE_CPI'], ['NFP', 'NFP'], ['FOMC', 'FOMC']] as const) {
      const rows = buildHistory(code, events, nq, 8, NOW);
      console.log(table(name, rows));
      expect(rows).toHaveLength(8);
      for (const r of rows) {
        expect(r.actual).not.toBeNull();
        // 2026-04-03 payrolls printed on Good Friday: the recorded NQ candles stop at 03:00Z that day, so the row is null, not filled.
        if (code === 'NFP' && r.date === '2026-04-03') { expect([r.h1Pct, r.closePct, r.resolution]).toEqual([null, null, null]); continue; }
        expect(Number.isFinite(r.h1Pct)).toBe(true);
        expect(Number.isFinite(r.closePct)).toBe(true);
        expect(Math.abs(r.closePct as number)).toBeLessThan(10);
        if (r.resolution === '5m') expect(r.m5Pct).not.toBeNull();
        if (r.resolution === '1h') { expect(r.m5Pct).toBeNull(); expect(r.firstMoveReversed).toBeNull(); }
      }
      expect(new Set(rows.map((r) => r.time)).size).toBe(8);
    }
  });

  it('measures the 2026-11-10 CPI on 5m bars exactly as defined', () => {
    const e = canonicalEvents(events, 'CORE_CPI').find((x) => x.time.startsWith('2026-11-10'))!;
    expect(e.name).toBe('Core Inflation Rate MoM');
    const r = reactionFor(e, nq);
    // P0 = 13:25Z bar close 27929.75; 13:30Z bar close 27705.
    expect(r.resolution).toBe('5m');
    expect(r.m5Pct).toBeCloseTo((27705 / 27929.75 - 1) * 100, 3);
    expect(r.surprise).toBeCloseTo(0.1, 6);
    expect(r.firstMoveReversed).toBe(false);
  });

  it('returns nulls when no candle covers the date', () => {
    const r = reactionFor({ time: '2019-01-11T13:30:00.000Z', actual: 0.2, consensus: 0.2 }, nq);
    expect([r.m5Pct, r.h1Pct, r.closePct, r.firstMoveReversed, r.resolution]).toEqual([null, null, null, null, null]);
  });

  it('flags a reversed first move on synthetic bars', () => {
    const T = Date.parse('2026-03-03T13:30:00Z');
    const bar = (t: number, o: number, c: number) => ({ symbol: 'NQ', tf: '5m' as const, t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1, source: 'synthetic' });
    const synthetic = [bar(T - 300_000, 100, 100), bar(T, 100, 99), ...Array.from({ length: 90 }, (_, i) => bar(T + (i + 1) * 300_000, 101, 101))];
    const r = reactionFor({ time: new Date(T).toISOString(), actual: 1, consensus: 1 }, { '5m': synthetic });
    expect(r.m5Pct).toBe(-1);
    expect(r.firstMoveReversed).toBe(true);
  });

  it('builds the 10Y table in bp from recorded US10Y candles', () => {
    const rows = buildRateHistory('CORE_CPI', events, candlesAsOf('US10Y'), 8, NOW);
    expect(rows).toHaveLength(8);
    const nov = rows.find((r) => r.date === '2026-11-10')!;
    expect(nov.h1Bp).not.toBeNull();
    expect(nov.h1Bp as number).toBeGreaterThan(0);
  });
});
