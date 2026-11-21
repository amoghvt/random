/**
 * The Store contract as executable tests. Run against MemoryStore always and PgStore when
 * DATABASE_URL is set, so the two cannot drift. All rows here are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTION_NAMES, type Candle, type Datum, type Headline, type Notification, type Quote, type Store } from '@desk/contracts';

const T0 = Date.parse('2026-11-16T14:30:00.000Z');
const MIN = 60_000;
const syntheticCandle = (i: number, over: Partial<Candle> = {}): Candle =>
  ({ symbol: 'SYN', tf: '1m', t: T0 + i * MIN, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 * i, source: 'synthetic', ...over });
const syntheticDatum = (i: number, over: Partial<Datum> = {}): Datum =>
  ({ key: 'syn.rate', value: 4 + i / 100, source: 'synthetic', asOf: new Date(T0 + i * MIN).toISOString(), cadenceSec: 60, ...over });
const syntheticQuote = (symbol: string, price: number, i: number): Quote =>
  ({ symbol, price, prevClose: 100, changePct: price - 100, asOf: new Date(T0 + i * MIN).toISOString(), source: 'synthetic', cadenceSec: 60 });
const syntheticHeadline = (id: string, i: number, over: Partial<Headline> = {}): Headline =>
  ({ id, ts: new Date(T0 + i * MIN).toISOString(), source: 'synthetic', title: `synthetic headline ${id}`, category: 'macro', impact: 1, direction: 0, symbols: ['SYN'], classifier: 'rules', dedupeKey: id, ...over });
const syntheticNotification = (id: string, i: number): Notification => ({
  id, class: 'P2', reason: 'synthetic', instrument: null, lines: ['synthetic line'], deepLink: '/', dedupeKey: id,
  ts: new Date(T0 + i * MIN).toISOString(), decision: 'sent', suppressedBy: null, channels: ['feed'], tappedAt: null,
});

export function storeConformance(name: string, make: () => Promise<Store>, dispose?: (s: Store) => Promise<void>): void {
  describe(`Store conformance: ${name}`, () => {
    let store: Store;
    beforeAll(async () => { store = await make(); });
    afterAll(async () => { await (dispose ? dispose(store) : store.close()); });

    it('candles: ascending read, upsert by (symbol, tf, t), last write wins inside a batch', async () => {
      await store.upsertCandles([syntheticCandle(2), syntheticCandle(0), syntheticCandle(1), syntheticCandle(1, { c: 555 })]);
      await store.upsertCandles([syntheticCandle(0, { c: 777, source: 'synthetic:2' }), syntheticCandle(0, { tf: '5m' }), syntheticCandle(0, { symbol: 'SYN2' })]);
      const got = await store.getCandles('SYN', '1m');
      expect(got.map((c) => c.t)).toEqual([T0, T0 + MIN, T0 + 2 * MIN]);
      expect(got[0]).toEqual(syntheticCandle(0, { c: 777, source: 'synthetic:2' }));
      expect(got[1]!.c).toBe(555);
      expect(await store.getCandles('SYN', '5m')).toHaveLength(1);
      expect(await store.getCandles('NOPE', '1m')).toEqual([]);
      await store.upsertCandles([]);
    });

    it('candles: from and to are inclusive, limit keeps the most recent N in ascending order', async () => {
      await store.upsertCandles(Array.from({ length: 10 }, (_, i) => syntheticCandle(i, { symbol: 'RNG' })));
      const t = async (opts: { from?: number; to?: number; limit?: number }): Promise<number[]> =>
        (await store.getCandles('RNG', '1m', opts)).map((c) => (c.t - T0) / MIN);
      expect(await t({ from: T0 + 3 * MIN, to: T0 + 5 * MIN })).toEqual([3, 4, 5]);
      expect(await t({ limit: 3 })).toEqual([7, 8, 9]);
      expect(await t({ to: T0 + 5 * MIN, limit: 2 })).toEqual([4, 5]);
      expect(await t({ from: T0 + 8 * MIN, limit: 5 })).toEqual([8, 9]);
      expect(await t({ from: T0 + 3 * MIN + 1, to: T0 + 5 * MIN - 1 })).toEqual([4]);
      expect(await t({ limit: 0 })).toEqual([]);
    });

    it('data: latest, history ascending and inclusive, upsert by (key, asOf), meta round-trips', async () => {
      await store.putData([syntheticDatum(2), syntheticDatum(0), syntheticDatum(1, { meta: { days: 1, note: 'synthetic' } }), syntheticDatum(5, { key: 'syn.other', value: 9 })]);
      await store.putData([syntheticDatum(2, { value: 42 })]);
      expect(await store.latestDatum('syn.rate')).toEqual(syntheticDatum(2, { value: 42 }));
      expect(await store.latestDatum('syn.missing')).toBeNull();
      const hist = await store.dataHistory('syn.rate', T0);
      expect(hist.map((d) => d.asOf)).toEqual([0, 1, 2].map((i) => syntheticDatum(i).asOf));
      expect(hist[1]!.meta).toEqual({ days: 1, note: 'synthetic' });
      expect(hist[0]!.meta).toBeUndefined();
      expect((await store.dataHistory('syn.rate', T0 + MIN, T0 + MIN)).map((d) => d.value)).toEqual([4.01]);
      expect(await store.dataHistory('syn.rate', T0 + 3 * MIN)).toEqual([]);
      const latest = await store.latestData(['syn.rate', 'syn.other', 'syn.missing']);
      expect(Object.keys(latest).sort()).toEqual(['syn.other', 'syn.rate']);
      expect(latest['syn.other']!.value).toBe(9);
      expect(await store.latestData([])).toEqual({});
    });

    it('data: as-of times are normalized to UTC ISO', async () => {
      await store.putData([syntheticDatum(0, { key: 'syn.tz', asOf: '2026-11-16T09:30:00-05:00' })]);
      expect((await store.latestDatum('syn.tz'))!.asOf).toBe('2026-11-16T14:30:00.000Z');
      await expect(store.putData([syntheticDatum(0, { asOf: 'not a time at all' })])).rejects.toThrow(/Invalid timestamp/);
    });

    it('quotes: one row per symbol, the newest as-of wins', async () => {
      await store.putQuotes([syntheticQuote('SYN', 101, 1), syntheticQuote('SYN2', 50, 1)]);
      await store.putQuotes([syntheticQuote('SYN', 99, 0)]);
      expect((await store.latestQuotes(['SYN']))['SYN']).toEqual(syntheticQuote('SYN', 101, 1));
      await store.putQuotes([syntheticQuote('SYN', 103, 2), { ...syntheticQuote('SYN3', 7, 2), prevClose: null, changePct: null }]);
      const all = await store.latestQuotes();
      expect(all['SYN']!.price).toBe(103);
      expect(all['SYN3']).toEqual({ ...syntheticQuote('SYN3', 7, 2), prevClose: null, changePct: null });
      expect(Object.keys(await store.latestQuotes(['SYN2', 'NOPE']))).toEqual(['SYN2']);
    });

    it('documents: put upserts by id, get returns a copy, remove deletes', async () => {
      const h = syntheticHeadline('h_a', 0);
      await store.put('headlines', [h]);
      const got = await store.get('headlines', 'h_a');
      expect(got).toEqual(h);
      got!.title = 'mutated';
      expect((await store.get('headlines', 'h_a'))!.title).toBe(h.title);
      await store.put('headlines', [{ ...h, title: 'first' }, { ...h, title: 'second' }]);
      expect((await store.get('headlines', 'h_a'))!.title).toBe('second');
      expect(await store.list('headlines')).toHaveLength(1);
      await store.remove('headlines', 'h_a');
      expect(await store.get('headlines', 'h_a')).toBeNull();
      await store.remove('headlines', 'h_a');
      await store.put('headlines', []);
    });

    it('documents: list filters on ts, instrument and status, newest first by default', async () => {
      await store.put('headlines', [
        syntheticHeadline('l_0', 0), syntheticHeadline('l_1', 1, { impact: 3 }), syntheticHeadline('l_2', 2, { symbols: ['OTHER'] }),
        syntheticHeadline('l_3', 3, { impact: 2 }), syntheticHeadline('l_4', 4, { symbols: [] }),
      ]);
      const ids = async (opts?: Parameters<Store['list']>[1]): Promise<string[]> => (await store.list('headlines', opts)).map((d) => d.id);
      const at = (i: number): string => new Date(T0 + i * MIN).toISOString();
      expect(await ids()).toEqual(['l_4', 'l_3', 'l_2', 'l_1', 'l_0']);
      expect(await ids({ order: 'asc', limit: 2 })).toEqual(['l_0', 'l_1']);
      expect(await ids({ limit: 2 })).toEqual(['l_4', 'l_3']);
      expect(await ids({ since: at(1), until: at(3) })).toEqual(['l_2', 'l_1']);
      expect(await ids({ instrument: 'SYN' })).toEqual(['l_3', 'l_1', 'l_0']);
      expect(await ids({ status: '3' })).toEqual(['l_1']);
      expect(await ids({ status: ['2', '3'] })).toEqual(['l_3', 'l_1']);
      expect(await ids({ instrument: 'SYN', status: '1', since: at(0) })).toEqual(['l_0']);
      expect(await ids({ status: [] })).toEqual([]);
      // Re-putting a document moves it in the indexes.
      await store.put('headlines', [syntheticHeadline('l_0', 9, { symbols: ['OTHER'] })]);
      expect(await ids({ instrument: 'OTHER' })).toEqual(['l_0', 'l_2']);
      expect(await ids({ instrument: 'SYN' })).toEqual(['l_3', 'l_1']);
    });

    it('documents: equal timestamps order by id, collections are separate', async () => {
      await store.put('notifications', [syntheticNotification('n_b', 0), syntheticNotification('n_a', 0), syntheticNotification('n_c', 0)]);
      expect((await store.list('notifications')).map((d) => d.id)).toEqual(['n_c', 'n_b', 'n_a']);
      expect((await store.list('notifications', { order: 'asc' })).map((d) => d.id)).toEqual(['n_a', 'n_b', 'n_c']);
      expect(await store.get('headlines', 'n_a')).toBeNull();
      expect((await store.list('notifications', { status: 'P2' }))).toHaveLength(3);
    });

    it('documents: every collection in the contract is readable, unknown ones are refused', async () => {
      for (const c of COLLECTION_NAMES) expect(await store.list(c, { limit: 1 })).toBeInstanceOf(Array);
      await expect(store.list('nope; DROP TABLE kv' as 'headlines')).rejects.toThrow(/Unknown collection/);
    });

    it('kv: json round-trip, overwrite, null when absent', async () => {
      expect(await store.kvGet('syn.absent')).toBeNull();
      await store.kvSet('syn.flag', true);
      expect(await store.kvGet<boolean>('syn.flag')).toBe(true);
      await store.kvSet('syn.flag', false);
      expect(await store.kvGet<boolean>('syn.flag')).toBe(false);
      const v = { a: 1, nested: { list: [1, 'two', null] }, s: 'text' };
      await store.kvSet('syn.obj', v);
      const got = await store.kvGet<typeof v>('syn.obj');
      expect(got).toEqual(v);
      got!.nested.list.push(4);
      expect(await store.kvGet('syn.obj')).toEqual(v);
      await store.kvSet('syn.str', 'plain');
      expect(await store.kvGet('syn.str')).toBe('plain');
      await store.kvSet('syn.arr', [1, 2]);
      expect(await store.kvGet('syn.arr')).toEqual([1, 2]);
    });
  });
}
