import { describe, expect, it } from 'vitest';
import { DAY, HOUR, TF_MS, fromZoned } from '@desk/contracts';
import { candleReader, fineCandles, lastPrice, priceSymbolOf, quotesWithFallback, ratesStrip, sizingCandles } from './market';
import { desk, recorded, recordedDesk } from './recorded.testkit';

const NOW = fromZoned(2026, 11, 17, 11, 0);
const closedBy = (symbol: string, tf: '1m' | '5m' | '1d', t: number) => recorded(symbol, tf).filter((c) => c.t + TF_MS[tf] <= t);

describe('market service on recorded candles', () => {
  it('reads NQ for NQ, MNQ and NQ-PERP, at the last closed 1m bar, and flags it stale once it is', async () => {
    const d = await recordedDesk(NOW, { symbols: ['NQ', 'US10Y', 'US30Y'] });
    expect(['NQ', 'MNQ', 'NQ-PERP'].map(priceSymbolOf)).toEqual(['NQ', 'NQ', 'NQ']);
    const last = closedBy('NQ', '1m', NOW).at(-1)!;
    for (const s of ['NQ', 'MNQ', 'NQ-PERP']) {
      const p = await lastPrice(d.deps, s, NOW);
      expect(p).toMatchObject({ symbol: 'NQ', price: last.c, stale: false, source: 'yahoo:recorded 1m' });
      expect(Date.parse(p!.asOf)).toBe(last.t + TF_MS['1m']);
    }
    // Same store read ten minutes later with nothing new in it: the number is old and says so.
    expect(await lastPrice(d.deps, 'NQ', NOW + 10 * 60_000)).toMatchObject({ price: last.c, stale: true, age: '10m' });
    expect(await lastPrice(d.deps, 'NVDA', NOW)).toBeNull();
  }, 60_000);

  it('never returns a candle stamped after now, and closed() drops the bar in progress', async () => {
    const d = await recordedDesk(NOW + 3 * HOUR, { symbols: ['NQ'] });
    const reader = candleReader(d.deps, NOW);
    const h1 = await reader.get('NQ', '1h');
    expect(h1.at(-1)!.t).toBeLessThanOrEqual(NOW);
    const closed = await reader.closed('NQ', '1h');
    expect(closed.at(-1)!.t + HOUR).toBeLessThanOrEqual(NOW);
    const set = await sizingCandles(reader, 'MNQ');
    expect(set.m1.at(-1)!.symbol).toBe('NQ');
    expect(set.d1.length).toBeGreaterThan(250);
    // Nov 10 predates the 1m recording: the fine series falls back to the closed 5m bars.
    const cpi = fromZoned(2026, 11, 10, 8, 30);
    const fine = await fineCandles(d.deps, 'NQ', cpi - 15 * 60_000, cpi + 16 * 60_000);
    expect(new Set(fine.map((c) => c.tf))).toEqual(new Set(['5m']));
    expect(fine.at(-1)!.t + TF_MS['5m']).toBeLessThanOrEqual(cpi + 16 * 60_000);
  }, 60_000);

  it('rates strip: the 10Y with its 1h and 1d change from one source, and nothing invented for the 2Y or the Fed odds', async () => {
    const d = await recordedDesk(NOW, { symbols: ['NQ', 'US10Y', 'US30Y'], tfs: ['5m', '1d'] });
    const strip = await ratesStrip(d.deps, NOW);
    const y = closedBy('US10Y', '5m', NOW);
    const last = y.at(-1)!;
    const at = (t: number) => y.filter((c) => c.t + TF_MS['5m'] <= t).at(-1)!;
    expect(strip.y10).toMatchObject({ value: last.c, source: 'yahoo:recorded', stale: false });
    expect(strip.y10Chg1hBp).toBeCloseTo((last.c - at(last.t + TF_MS['5m'] - HOUR).c) * 100, 1);
    expect(strip.y10Chg1dBp).toBeCloseTo((last.c - at(last.t + TF_MS['5m'] - DAY).c) * 100, 1);
    expect(strip.y30.value).toBe(closedBy('US30Y', '5m', NOW).at(-1)!.c);
    expect(strip.y2).toEqual({ value: null, asOf: null, source: null, stale: true, age: null });
    expect(strip.y2Chg1hBp).toBeNull();
    expect(strip.spread2s10sBp).toBeNull();
    expect(strip.fed.hike.value).toBeNull();
    expect(strip.fed.meeting).toBeNull();
  }, 60_000);

  it('builds a quote from candles only where the quote feed has none, and says where it came from', async () => {
    const d = await recordedDesk(NOW, { symbols: ['NQ'] });
    await d.store.putQuotes([{ symbol: 'ES', price: 6000, prevClose: 5990, changePct: 0.17, asOf: new Date(NOW - 30_000).toISOString(), source: 'test:quote-feed', cadenceSec: 60 }]);
    const q = await quotesWithFallback(d.deps, NOW, ['NQ', 'ES', 'DXY']);
    const prev = closedBy('NQ', '1d', NOW).at(-1)!.c, last = closedBy('NQ', '1m', NOW).at(-1)!.c;
    expect(q.NQ).toMatchObject({ price: last, prevClose: prev, source: 'candles:yahoo:recorded 1m' });
    expect(q.NQ!.changePct).toBeCloseTo((last / prev - 1) * 100, 2);
    expect(q.ES!.source).toBe('test:quote-feed');
    expect(q.DXY).toBeUndefined();
  }, 60_000);

  it('an empty store gives nulls, not errors', async () => {
    const d = await desk(NOW);
    expect(await lastPrice(d.deps, 'NQ', NOW)).toBeNull();
    expect((await ratesStrip(d.deps, NOW)).y10.stale).toBe(true);
  });
});
