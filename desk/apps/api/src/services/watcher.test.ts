import { describe, expect, it } from 'vitest';
import { KV, MIN, TF_MS, fromZoned } from '@desk/contracts';
import type { watcher as w } from '@desk/engines';
import { desk, recorded, recordedDesk, RECORDED_SYMBOLS } from './recorded.testkit';
import { baseRatesDue, computeBaseRates, runWatcher, watchedSymbols } from './watcher';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);

describe('watcher service on the recorded Nov 17 2026 session', () => {
  it('the first tick is a baseline: events are stored, nothing is pushed; later ticks store only what is new', async () => {
    const at = et(17, 11, 0);
    const d = await recordedDesk(at);
    expect(await watchedSymbols(d.deps)).toEqual(expect.arrayContaining(RECORDED_SYMBOLS));
    const first = await runWatcher(d.deps, at);
    // The watchlist is wider than the recording: names with no candles in the store are passed over.
    expect(first.symbols).toBe(RECORDED_SYMBOLS.length);
    expect(first.updates).toEqual([]);
    expect(first.intents).toEqual([]);
    const stored = await d.store.list('structure_events', {});
    expect(stored.length).toBe(first.events.length);
    expect(stored.every((e) => Date.parse(e.ts) <= at)).toBe(true);
    const nq = stored.filter((e) => e.instrument === 'NQ');
    console.log(`[watcher] 11:00 ET baseline: ${stored.length} events, ${nq.length} on NQ, detectors ${[...new Set(nq.map((e) => e.detector))].sort().join(', ')}`);
    expect(nq.length).toBeGreaterThan(100);
    const state = await d.store.kvGet<w.WatcherState>(KV.watcherState('NQ'));
    expect(state?.eventIds.length).toBeGreaterThan(100);

    // Same instant again: every event is already known.
    const again = await runWatcher(d.deps, at);
    expect(again.events).toEqual([]);
    expect((await d.store.list('structure_events', {})).length).toBe(stored.length);

    // Five more recorded minutes: only events from the new bars are written, and updates are stored as they are generated.
    const later = at + 5 * MIN;
    for (const symbol of ['NQ', 'ES']) for (const tf of ['1m', '5m'] as const) {
      await d.store.upsertCandles(recorded(symbol, tf).filter((c) => c.t + TF_MS[tf] > at && c.t + TF_MS[tf] <= later));
    }
    d.clock.t = later;
    const next = await runWatcher(d.deps, later);
    expect(next.events.length).toBeGreaterThan(0);
    expect(next.events.every((e) => Date.parse(e.ts) <= later)).toBe(true);
    expect(next.updates.length).toBeLessThanOrEqual(8);
    expect(await d.store.list('watcher_updates')).toHaveLength(next.updates.length);
    for (const u of next.updates) console.log(`[watcher] 11:05 ET update: ${u.text}`);
  }, 60_000);

  it('skips symbols with no candles and returns nothing on an empty store', async () => {
    const d = await desk(et(17, 11, 0));
    expect(await runWatcher(d.deps, et(17, 11, 0))).toEqual({ events: [], updates: [], intents: [], symbols: 0 });
    expect(await computeBaseRates(d.deps, et(17, 11, 0))).toBe(0);
  });

  it('daily base rates are measured on the stored 15m and 1h candles and carry their sample count', async () => {
    const at = et(17, 17, 15);
    const d = await recordedDesk(at, { symbols: ['NQ'], tfs: ['15m', '1h'] });
    expect(await baseRatesDue(d.deps, at)).toBe(true);
    const n = await computeBaseRates(d.deps, at);
    expect(n).toBeGreaterThan(0);
    const rates = await d.store.list('base_rates', { instrument: 'NQ' });
    expect(rates).toHaveLength(n);
    const sweep = rates.find((r) => r.pattern === 'sweep_reclaim_follow_through' && r.tf === '1h')!;
    console.log(`[watcher] NQ 1h sweep-and-reclaim follow-through: ${sweep.hitRate} over n=${sweep.n}, ${sweep.windowDays} days`);
    expect(sweep.n).toBeGreaterThan(100);
    expect(sweep.hitRate).toBeGreaterThan(0.4);
    expect(sweep.hitRate).toBeLessThan(0.55);
    expect(rates.every((r) => r.asOf === new Date(at).toISOString() && r.definition.length > 0)).toBe(true);
    expect(await baseRatesDue(d.deps, at + 60 * MIN)).toBe(false);
    expect(await baseRatesDue(d.deps, at + 21 * 60 * MIN)).toBe(true);
  }, 60_000);
});
