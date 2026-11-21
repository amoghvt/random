import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MIN, TF_MS, fromZoned, iso, type Candle } from '@desk/contracts';
import { decideCall } from './decide';
import { extractInputs } from './extract';
import { snapshotFromHistory, type HistoryArgs } from './history';
import { recordedCandlesByKey, syntheticCatalyst, syntheticDatum, syntheticEvent, syntheticHeadline } from './testkit';
import type { CandleSet } from './types';

const by = recordedCandlesByKey();
const INSTANTS = [fromZoned(2026, 11, 17, 10, 37), fromZoned(2026, 11, 16, 15, 5), fromZoned(2026, 11, 19, 3, 20), fromZoned(2026, 10, 30, 12, 0)];

function args(now: number): HistoryArgs {
  const at = now + 30 * MIN;
  return {
    now, instrument: 'NQ', horizon: 'intraday', candlesByKey: by,
    dataHistory: { 'rate.US10Y': [syntheticDatum('rate.US10Y', 5.1, now - HOUR), syntheticDatum('rate.US10Y', 5.08, now - MIN), syntheticDatum('rate.US10Y', 4.5, now + MIN)] },
    // Resolves 30 minutes after `now`.
    catalysts: [{ ...syntheticCatalyst(at, now - DAY, { at, branchId: 'hot' }), reaction: { m5Pct: -0.8, m15Pct: -1.4, verdict: 'extreme', text: 'future reaction' } }],
    structure: [syntheticEvent('past', now - 10 * MIN), syntheticEvent('future', now + 10 * MIN, { bias: -1 })],
    headlines: [syntheticHeadline('past', now - HOUR, 3, -1), syntheticHeadline('future', now + MIN, 3, 1), syntheticHeadline('old', now - 2 * DAY, 3, 1)],
  };
}
/** The same history with everything stamped or closing after `now` removed: what was knowable at `now`. */
function truncated(a: HistoryArgs): HistoryArgs {
  const candlesByKey: Record<string, Candle[]> = {};
  for (const [k, cs] of Object.entries(a.candlesByKey)) candlesByKey[k] = cs.filter((c) => c.t + TF_MS[c.tf] <= a.now);
  return {
    ...a, candlesByKey,
    dataHistory: Object.fromEntries(Object.entries(a.dataHistory).map(([k, h]) => [k, h.filter((d) => Date.parse(d.asOf) <= a.now)])),
    catalysts: a.catalysts.map((c) => ({ ...c, status: 'upcoming' as const, resolution: null, reaction: null })),
    structure: a.structure.filter((e) => Date.parse(e.ts) <= a.now), headlines: a.headlines.filter((h) => Date.parse(h.ts) <= a.now),
  };
}

describe('snapshotFromHistory', () => {
  it('has no look-ahead: the future changes nothing', () => {
    for (const now of INSTANTS) {
      const full = snapshotFromHistory(args(now)), known = snapshotFromHistory(truncated(args(now)));
      expect(full).toEqual(known);
      expect(decideCall(full, null)).toEqual(decideCall(known, null));
      const sets: CandleSet[] = [full.candles, ...Object.values(full.peers)];
      for (const set of sets) for (const series of [set.m15, set.h1, set.d1]) {
        series.forEach((c, i) => {
          expect(c.t).toBeLessThanOrEqual(now);
          // Only the last bar may be in progress, and then it was rebuilt from closed finer bars.
          if (c.t + TF_MS[c.tf] > now) { expect(i).toBe(series.length - 1); expect(c.source).toMatch(/^partial:/); }
        });
      }
      expect(Date.parse(full.data['rate.US10Y']!.asOf)).toBeLessThanOrEqual(now);
      expect(full.data['rate.US10Y']!.value).toBe(5.08);
      expect(full.catalysts[0]).toMatchObject({ status: 'upcoming', resolution: null, reaction: null });
      expect(full.structure.map((e) => e.id)).toEqual(['past']);
      expect(full.headlines.map((h) => h.id)).toEqual(['past']);
    }
  });
  it('the in-progress daily bar is what had traded, not the recorded day', () => {
    const now = fromZoned(2026, 11, 20, 10, 0); // NQ closed the day at 25,126.50 after a 24,976.50 low
    const snap = snapshotFromHistory({ ...args(now), catalysts: [], structure: [], headlines: [], dataHistory: {} });
    const today = snap.candles.d1.at(-1)!;
    const recorded = by['NQ.1d']!.at(-1)!;
    console.log(`2026-11-20 10:00 ET: price ${snap.price}, partial daily bar low ${today.l} close ${today.c}; recorded day low ${recorded.l} close ${recorded.c}`);
    expect(today.source).toMatch(/^partial:/);
    expect(today.c).toBe(snap.price);
    expect(today.l).toBeGreaterThan(recorded.l);
    expect(snap.price).toBeGreaterThan(recorded.c + 300);
    expect(extractInputs(snap).regime.d1!.close).toBe(snap.price);
  });
  it('a catalyst is seen as resolved only after its resolution, and its reaction only when the clock has run', () => {
    const base = fromZoned(2026, 11, 17, 10, 0);
    const a = args(base); // resolves at 10:30
    const at = (t: number) => snapshotFromHistory({ ...a, now: t }).catalysts[0]!;
    expect(at(base + 29 * MIN).status).toBe('upcoming');
    expect(at(base + 31 * MIN)).toMatchObject({ status: 'resolved', reaction: { m5Pct: null, m15Pct: null, verdict: null } });
    expect(at(base + 36 * MIN).reaction).toMatchObject({ m5Pct: -0.8, m15Pct: null });
    expect(at(base + 46 * MIN).reaction).toMatchObject({ m5Pct: -0.8, m15Pct: -1.4, verdict: 'extreme' });
    expect(() => snapshotFromHistory({ ...a, now: Date.parse('2010-01-01T00:00:00Z') })).toThrow(/No NQ candles/);
    expect(iso(snapshotFromHistory(a).now)).toBe(iso(base));
  });
});
