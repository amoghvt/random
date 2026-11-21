/**
 * Minimal in-memory Store for the feeds tests and the smoke script: only the methods the feed layer calls
 * are real. `@desk/db` MemoryStore is the full implementation.
 */
import { COLLECTION_KEYS, type CollectionName, type Collections, type Candle, type Datum, type ListOpts, type Quote, type Store, type Timeframe } from '@desk/contracts';

export class FakeStore implements Store {
  readonly candles = new Map<string, Map<number, Candle>>();
  readonly data = new Map<string, Datum[]>();
  readonly quotes = new Map<string, Quote>();
  readonly docs = new Map<string, Map<string, unknown>>();
  readonly kv = new Map<string, unknown>();

  async upsertCandles(candles: Candle[]): Promise<void> {
    for (const c of candles) {
      const k = `${c.symbol}|${c.tf}`;
      if (!this.candles.has(k)) this.candles.set(k, new Map());
      this.candles.get(k)!.set(c.t, c);
    }
  }
  async getCandles(symbol: string, tf: Timeframe, opts: { from?: number; to?: number; limit?: number } = {}): Promise<Candle[]> {
    const all = [...(this.candles.get(`${symbol}|${tf}`)?.values() ?? [])].filter((c) => (opts.from === undefined || c.t >= opts.from) && (opts.to === undefined || c.t < opts.to)).sort((a, b) => a.t - b.t);
    return opts.limit ? all.slice(-opts.limit) : all;
  }
  async putData(data: Datum[]): Promise<void> {
    for (const d of data) {
      const xs = (this.data.get(d.key) ?? []).filter((x) => x.asOf !== d.asOf);
      xs.push(d);
      this.data.set(d.key, xs.sort((a, b) => a.asOf.localeCompare(b.asOf)));
    }
  }
  async latestDatum(key: string): Promise<Datum | null> { return this.data.get(key)?.at(-1) ?? null; }
  async latestData(keys: string[]): Promise<Record<string, Datum>> {
    const out: Record<string, Datum> = {};
    for (const k of keys) { const d = this.data.get(k)?.at(-1); if (d) out[k] = d; }
    return out;
  }
  async dataHistory(key: string, sinceMs: number, untilMs?: number): Promise<Datum[]> {
    return (this.data.get(key) ?? []).filter((d) => Date.parse(d.asOf) >= sinceMs && (untilMs === undefined || Date.parse(d.asOf) < untilMs));
  }
  async putQuotes(quotes: Quote[]): Promise<void> { for (const q of quotes) this.quotes.set(q.symbol, q); }
  async latestQuotes(symbols?: string[]): Promise<Record<string, Quote>> {
    return Object.fromEntries([...this.quotes].filter(([s]) => !symbols || symbols.includes(s)));
  }
  async put<K extends CollectionName>(c: K, docs: Array<Collections[K]>): Promise<void> {
    if (!this.docs.has(c)) this.docs.set(c, new Map());
    for (const d of docs) this.docs.get(c)!.set(COLLECTION_KEYS[c](d).id, d);
  }
  async get<K extends CollectionName>(c: K, id: string): Promise<Collections[K] | null> { return (this.docs.get(c)?.get(id) as Collections[K] | undefined) ?? null; }
  async list<K extends CollectionName>(c: K, opts: ListOpts = {}): Promise<Array<Collections[K]>> {
    const status = opts.status === undefined ? null : Array.isArray(opts.status) ? opts.status : [opts.status];
    const rows = ([...(this.docs.get(c)?.values() ?? [])] as Array<Collections[K]>).map((d) => ({ d, k: COLLECTION_KEYS[c](d) }))
      .filter(({ k }) => (!opts.since || k.ts >= opts.since) && (!opts.until || k.ts < opts.until) && (!opts.instrument || k.instrument === opts.instrument) && (!status || (k.status !== null && status.includes(k.status))))
      .sort((a, b) => (opts.order === 'asc' ? a.k.ts.localeCompare(b.k.ts) : b.k.ts.localeCompare(a.k.ts)));
    return (opts.limit ? rows.slice(0, opts.limit) : rows).map((r) => r.d);
  }
  async remove<K extends CollectionName>(c: K, id: string): Promise<void> { this.docs.get(c)?.delete(id); }
  async kvGet<T>(key: string): Promise<T | null> { return (this.kv.get(key) as T | undefined) ?? null; }
  async kvSet<T>(key: string, value: T): Promise<void> { this.kv.set(key, structuredClone(value)); }
  async close(): Promise<void> { /* nothing to release */ }
}
