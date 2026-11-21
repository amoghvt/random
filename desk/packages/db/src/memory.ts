import type { Candle, CollectionName, Collections, Datum, IndexKeys, ListOpts, Quote, Store, Timeframe } from '@desk/contracts';
import { assertCollection, dedupeLast, indexKeys, isoOf, jsonClone } from './util';

interface DocRow { keys: IndexKeys; tsMs: number; doc: unknown }
interface DatumRow { ms: number; d: Datum }

/** First index whose key is >= x in an ascending array. */
function lowerBound<T>(xs: T[], x: number, key: (r: T) => number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(xs[mid]!) < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function upsertSorted<T>(xs: T[], row: T, key: (r: T) => number): void {
  const k = key(row);
  const last = xs[xs.length - 1];
  if (last === undefined || key(last) < k) { xs.push(row); return; }
  const i = lowerBound(xs, k, key);
  if (i < xs.length && key(xs[i]!) === k) xs[i] = row; else xs.splice(i, 0, row);
}
const candleT = (c: Candle): number => c.t;
const datumT = (r: DatumRow): number => r.ms;

/** In-process Store with the same semantics as PgStore. Used by tests, the replay and no-database dev. */
export class MemoryStore implements Store {
  private candles = new Map<string, Candle[]>();
  private data = new Map<string, DatumRow[]>();
  private quotes = new Map<string, Quote>();
  private docs = new Map<string, Map<string, DocRow>>();
  private kv = new Map<string, string>();

  async upsertCandles(candles: Candle[]): Promise<void> {
    for (const c of candles) {
      if (!Number.isFinite(c.t)) throw new Error(`Invalid candle time for ${c.symbol} ${c.tf}`);
      const k = `${c.symbol}|${c.tf}`;
      let series = this.candles.get(k);
      if (!series) this.candles.set(k, (series = []));
      upsertSorted(series, { symbol: c.symbol, tf: c.tf, t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, source: c.source }, candleT);
    }
  }

  async getCandles(symbol: string, tf: Timeframe, opts: { from?: number; to?: number; limit?: number } = {}): Promise<Candle[]> {
    const series = this.candles.get(`${symbol}|${tf}`) ?? [];
    const a = opts.from === undefined ? 0 : lowerBound(series, opts.from, candleT);
    const b = opts.to === undefined ? series.length : lowerBound(series, opts.to + 1, candleT);
    const start = opts.limit === undefined ? a : Math.max(a, b - Math.max(0, opts.limit));
    return series.slice(start, b).map((c) => ({ ...c }));
  }

  async putData(data: Datum[]): Promise<void> {
    for (const d of data) {
      const asOf = isoOf(d.asOf);
      let series = this.data.get(d.key);
      if (!series) this.data.set(d.key, (series = []));
      upsertSorted(series, { ms: Date.parse(asOf), d: jsonClone({ ...d, asOf }) }, datumT);
    }
  }

  async latestDatum(key: string): Promise<Datum | null> {
    const series = this.data.get(key);
    const last = series?.[series.length - 1];
    return last ? jsonClone(last.d) : null;
  }

  async latestData(keys: string[]): Promise<Record<string, Datum>> {
    const out: Record<string, Datum> = {};
    for (const k of keys) {
      const d = await this.latestDatum(k);
      if (d) out[k] = d;
    }
    return out;
  }

  async dataHistory(key: string, sinceMs: number, untilMs?: number): Promise<Datum[]> {
    const series = this.data.get(key) ?? [];
    const a = lowerBound(series, sinceMs, datumT);
    const b = untilMs === undefined ? series.length : lowerBound(series, untilMs + 1, datumT);
    return series.slice(a, b).map((r) => jsonClone(r.d));
  }

  async putQuotes(quotes: Quote[]): Promise<void> {
    for (const q of quotes) {
      const asOf = isoOf(q.asOf);
      const prev = this.quotes.get(q.symbol);
      if (prev && Date.parse(prev.asOf) > Date.parse(asOf)) continue;
      this.quotes.set(q.symbol, { symbol: q.symbol, price: q.price, prevClose: q.prevClose ?? null, changePct: q.changePct ?? null, asOf, source: q.source, cadenceSec: q.cadenceSec });
    }
  }

  async latestQuotes(symbols?: string[]): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    for (const s of symbols ?? this.quotes.keys()) {
      const q = this.quotes.get(s);
      if (q) out[s] = { ...q };
    }
    return out;
  }

  private table(c: string): Map<string, DocRow> {
    assertCollection(c);
    let t = this.docs.get(c);
    if (!t) this.docs.set(c, (t = new Map()));
    return t;
  }

  async put<K extends CollectionName>(c: K, docs: Array<Collections[K]>): Promise<void> {
    const t = this.table(c);
    const rows = dedupeLast(docs.map((doc) => ({ keys: indexKeys(c, doc), doc })), (r) => r.keys.id);
    for (const r of rows) t.set(r.keys.id, { keys: r.keys, tsMs: Date.parse(r.keys.ts), doc: jsonClone(r.doc) });
  }

  async get<K extends CollectionName>(c: K, id: string): Promise<Collections[K] | null> {
    const row = this.table(c).get(id);
    return row ? (jsonClone(row.doc) as Collections[K]) : null;
  }

  async list<K extends CollectionName>(c: K, opts: ListOpts = {}): Promise<Array<Collections[K]>> {
    const since = opts.since === undefined ? -Infinity : Date.parse(isoOf(opts.since));
    const until = opts.until === undefined ? Infinity : Date.parse(isoOf(opts.until));
    const statuses = opts.status === undefined ? null : new Set(Array.isArray(opts.status) ? opts.status : [opts.status]);
    const dir = opts.order === 'asc' ? 1 : -1;
    const rows = [...this.table(c).values()]
      .filter((r) => r.tsMs >= since && r.tsMs < until
        && (opts.instrument === undefined || r.keys.instrument === opts.instrument)
        && (statuses === null || (r.keys.status !== null && statuses.has(r.keys.status))))
      .sort((x, y) => dir * (x.tsMs - y.tsMs || (x.keys.id < y.keys.id ? -1 : x.keys.id > y.keys.id ? 1 : 0)));
    const limited = opts.limit === undefined ? rows : rows.slice(0, Math.max(0, opts.limit));
    return limited.map((r) => jsonClone(r.doc) as Collections[K]);
  }

  async remove<K extends CollectionName>(c: K, id: string): Promise<void> {
    this.table(c).delete(id);
  }

  async kvGet<T>(key: string): Promise<T | null> {
    const v = this.kv.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }

  async kvSet<T>(key: string, value: T): Promise<void> {
    this.kv.set(key, JSON.stringify(value ?? null));
  }

  async close(): Promise<void> { /* nothing to release */ }
}
