import pg from 'pg';
import type { Candle, CollectionName, Collections, Datum, ListOpts, Quote, Store, Timeframe } from '@desk/contracts';
import { migrate } from './migrate';
import { assertCollection, dedupeLast, indexKeys, isoOf } from './util';

export interface PgStoreOptions {
  connectionString: string;
  /** Put every table in this schema instead of `public` (test isolation). Created by `migrate()`. */
  schema?: string;
  max?: number;
}

const CHUNK = 5000;
function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
}
const col = <T, V>(rows: T[], f: (r: T) => V): V[] => rows.map(f);

interface CandleRow { symbol: string; tf: Timeframe; t: number; o: number; h: number; l: number; c: number; v: number; source: string }
interface DatumRow { key: string; as_of: Date; value: number; source: string; cadence_sec: number; meta: Record<string, unknown> | null }
interface QuoteRow { symbol: string; price: number; prev_close: number | null; change_pct: number | null; as_of: Date; source: string; cadence_sec: number }

const toDatum = (r: DatumRow): Datum => ({ key: r.key, value: r.value, source: r.source, asOf: r.as_of.toISOString(), cadenceSec: r.cadence_sec, ...(r.meta ? { meta: r.meta } : {}) });
const CANDLE_COLS = 'symbol, tf, (extract(epoch from t) * 1000)::float8 AS t, o, h, l, c, v, source';
const DATUM_COLS = 'key, as_of, value, source, cadence_sec, meta';

/** Postgres (TimescaleDB when available) implementation of the Store contract. */
export class PgStore implements Store {
  readonly pool: pg.Pool;
  private readonly schema: string | undefined;

  constructor(opts: PgStoreOptions) {
    if (opts.schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error(`Invalid schema name: ${opts.schema}`);
    this.schema = opts.schema;
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      ...(opts.schema ? { options: `-c search_path=${opts.schema},public` } : {}),
    });
  }

  /** Creates the schema if one was requested, then applies pending migrations. Returns the names applied. */
  async migrate(): Promise<string[]> {
    if (this.schema) await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    return migrate(this.pool);
  }

  async upsertCandles(candles: Candle[]): Promise<void> {
    const rows = dedupeLast(candles, (c) => `${c.symbol}|${c.tf}|${c.t}`);
    for (const b of chunks(rows)) {
      await this.pool.query(
        `INSERT INTO candles (symbol, tf, t, o, h, l, c, v, source)
         SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::text[])
         ON CONFLICT (symbol, tf, t) DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v, source = EXCLUDED.source`,
        [col(b, (c) => c.symbol), col(b, (c) => c.tf), col(b, (c) => isoOf(c.t)), col(b, (c) => c.o), col(b, (c) => c.h), col(b, (c) => c.l), col(b, (c) => c.c), col(b, (c) => c.v), col(b, (c) => c.source)],
      );
    }
  }

  async getCandles(symbol: string, tf: Timeframe, opts: { from?: number; to?: number; limit?: number } = {}): Promise<Candle[]> {
    const where = ['symbol = $1', 'tf = $2'];
    const args: unknown[] = [symbol, tf];
    if (opts.from !== undefined) { args.push(isoOf(opts.from)); where.push(`t >= $${args.length}`); }
    if (opts.to !== undefined) { args.push(isoOf(opts.to)); where.push(`t <= $${args.length}`); }
    let sql = `SELECT ${CANDLE_COLS} FROM candles WHERE ${where.join(' AND ')} ORDER BY candles.t`;
    if (opts.limit !== undefined) {
      args.push(Math.max(0, Math.floor(opts.limit)));
      sql = `SELECT * FROM (SELECT ${CANDLE_COLS} FROM candles WHERE ${where.join(' AND ')} ORDER BY candles.t DESC LIMIT $${args.length}) recent ORDER BY t`;
    }
    const { rows } = await this.pool.query<CandleRow>(sql, args);
    return rows.map((r) => ({ symbol: r.symbol, tf: r.tf, t: Math.round(r.t), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, source: r.source }));
  }

  async putData(data: Datum[]): Promise<void> {
    const rows = dedupeLast(data.map((d) => ({ ...d, asOf: isoOf(d.asOf) })), (d) => `${d.key}|${d.asOf}`);
    for (const b of chunks(rows)) {
      await this.pool.query(
        `INSERT INTO data (key, as_of, value, source, cadence_sec, meta)
         SELECT k, a, v, s, c, m::jsonb FROM unnest($1::text[], $2::timestamptz[], $3::float8[], $4::text[], $5::float8[], $6::text[]) AS u(k, a, v, s, c, m)
         ON CONFLICT (key, as_of) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, cadence_sec = EXCLUDED.cadence_sec, meta = EXCLUDED.meta`,
        [col(b, (d) => d.key), col(b, (d) => d.asOf), col(b, (d) => d.value), col(b, (d) => d.source), col(b, (d) => d.cadenceSec), col(b, (d) => (d.meta === undefined ? null : JSON.stringify(d.meta)))],
      );
    }
  }

  async latestDatum(key: string): Promise<Datum | null> {
    const { rows } = await this.pool.query<DatumRow>(`SELECT ${DATUM_COLS} FROM data WHERE key = $1 ORDER BY as_of DESC LIMIT 1`, [key]);
    return rows[0] ? toDatum(rows[0]) : null;
  }

  async latestData(keys: string[]): Promise<Record<string, Datum>> {
    if (keys.length === 0) return {};
    const { rows } = await this.pool.query<DatumRow>(`SELECT DISTINCT ON (key) ${DATUM_COLS} FROM data WHERE key = ANY($1::text[]) ORDER BY key, as_of DESC`, [keys]);
    return Object.fromEntries(rows.map((r) => [r.key, toDatum(r)]));
  }

  async dataHistory(key: string, sinceMs: number, untilMs?: number): Promise<Datum[]> {
    const args: unknown[] = [key, isoOf(sinceMs)];
    let sql = `SELECT ${DATUM_COLS} FROM data WHERE key = $1 AND as_of >= $2`;
    if (untilMs !== undefined) { args.push(isoOf(untilMs)); sql += ' AND as_of <= $3'; }
    const { rows } = await this.pool.query<DatumRow>(`${sql} ORDER BY as_of`, args);
    return rows.map(toDatum);
  }

  async putQuotes(quotes: Quote[]): Promise<void> {
    // Newest as-of wins, inside the batch and against what is stored: a slow feed never overwrites a fresher quote.
    const newest = new Map<string, Quote>();
    for (const q of quotes) {
      const n = { ...q, asOf: isoOf(q.asOf) };
      const prev = newest.get(q.symbol);
      if (!prev || Date.parse(prev.asOf) <= Date.parse(n.asOf)) newest.set(q.symbol, n);
    }
    const b = [...newest.values()];
    if (b.length === 0) return;
    await this.pool.query(
      `INSERT INTO quotes (symbol, price, prev_close, change_pct, as_of, source, cadence_sec)
       SELECT * FROM unnest($1::text[], $2::float8[], $3::float8[], $4::float8[], $5::timestamptz[], $6::text[], $7::float8[])
       ON CONFLICT (symbol) DO UPDATE SET price = EXCLUDED.price, prev_close = EXCLUDED.prev_close, change_pct = EXCLUDED.change_pct,
         as_of = EXCLUDED.as_of, source = EXCLUDED.source, cadence_sec = EXCLUDED.cadence_sec
       WHERE quotes.as_of <= EXCLUDED.as_of`,
      [col(b, (q) => q.symbol), col(b, (q) => q.price), col(b, (q) => q.prevClose ?? null), col(b, (q) => q.changePct ?? null), col(b, (q) => q.asOf), col(b, (q) => q.source), col(b, (q) => q.cadenceSec)],
    );
  }

  async latestQuotes(symbols?: string[]): Promise<Record<string, Quote>> {
    const { rows } = symbols
      ? await this.pool.query<QuoteRow>('SELECT * FROM quotes WHERE symbol = ANY($1::text[])', [symbols])
      : await this.pool.query<QuoteRow>('SELECT * FROM quotes');
    return Object.fromEntries(rows.map((r) => [r.symbol, { symbol: r.symbol, price: r.price, prevClose: r.prev_close, changePct: r.change_pct, asOf: r.as_of.toISOString(), source: r.source, cadenceSec: r.cadence_sec }]));
  }

  async put<K extends CollectionName>(c: K, docs: Array<Collections[K]>): Promise<void> {
    assertCollection(c);
    const rows = dedupeLast(docs.map((doc) => ({ k: indexKeys(c, doc), doc: JSON.stringify(doc) })), (r) => r.k.id);
    for (const b of chunks(rows)) {
      await this.pool.query(
        `INSERT INTO ${c} (id, ts, instrument, status, doc)
         SELECT i, t, n, s, d::jsonb FROM unnest($1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::text[]) AS u(i, t, n, s, d)
         ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, instrument = EXCLUDED.instrument, status = EXCLUDED.status, doc = EXCLUDED.doc`,
        [col(b, (r) => r.k.id), col(b, (r) => r.k.ts), col(b, (r) => r.k.instrument), col(b, (r) => r.k.status), col(b, (r) => r.doc)],
      );
    }
  }

  async get<K extends CollectionName>(c: K, id: string): Promise<Collections[K] | null> {
    assertCollection(c);
    const { rows } = await this.pool.query<{ doc: Collections[K] }>(`SELECT doc FROM ${c} WHERE id = $1`, [id]);
    return rows[0]?.doc ?? null;
  }

  async list<K extends CollectionName>(c: K, opts: ListOpts = {}): Promise<Array<Collections[K]>> {
    assertCollection(c);
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (clause: string, v: unknown): void => { args.push(v); where.push(clause.replace('?', `$${args.length}`)); };
    if (opts.since !== undefined) add('ts >= ?', isoOf(opts.since));
    if (opts.until !== undefined) add('ts < ?', isoOf(opts.until));
    if (opts.instrument !== undefined) add('instrument = ?', opts.instrument);
    if (opts.status !== undefined) add('status = ANY(?::text[])', Array.isArray(opts.status) ? opts.status : [opts.status]);
    const dir = opts.order === 'asc' ? 'ASC' : 'DESC';
    let sql = `SELECT doc FROM ${c}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts ${dir}, id COLLATE "C" ${dir}`;
    if (opts.limit !== undefined) { args.push(Math.max(0, Math.floor(opts.limit))); sql += ` LIMIT $${args.length}`; }
    const { rows } = await this.pool.query<{ doc: Collections[K] }>(sql, args);
    return rows.map((r) => r.doc);
  }

  async remove<K extends CollectionName>(c: K, id: string): Promise<void> {
    assertCollection(c);
    await this.pool.query(`DELETE FROM ${c} WHERE id = $1`, [id]);
  }

  async kvGet<T>(key: string): Promise<T | null> {
    const { rows } = await this.pool.query<{ value: T | null }>('SELECT value FROM kv WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async kvSet<T>(key: string, value: T): Promise<void> {
    await this.pool.query(
      'INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [key, JSON.stringify(value ?? null)],
    );
  }

  /** Drops the isolated schema (tests only; refuses when the store uses `public`). */
  async dropSchema(): Promise<void> {
    if (!this.schema) throw new Error('dropSchema needs a store created with a schema');
    await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
