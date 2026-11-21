import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { COLLECTION_NAMES } from '@desk/contracts';
import { storeConformance } from './conformance';
import { createStore, PgStore } from './index';

const url = process.env.DATABASE_URL;
const isolated = (): PgStore => new PgStore({ connectionString: url!, schema: `t_${randomBytes(6).toString('hex')}`, max: 4 });

describe.skipIf(!url)('PgStore (DATABASE_URL)', () => {
  storeConformance('PgStore', async () => {
    const s = isolated();
    await s.migrate();
    return s;
  }, async (s) => {
    await (s as PgStore).dropSchema();
    await s.close();
  });

  it('migrate is idempotent and creates every contract table with its three indexes', async () => {
    const s = isolated();
    try {
      expect(await s.migrate()).toEqual(['001_init.sql', '002_timescale.sql']);
      expect(await s.migrate()).toEqual([]);
      const tables = await s.pool.query<{ table_name: string }>('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()');
      const names = new Set(tables.rows.map((r) => r.table_name));
      for (const t of ['candles', 'data', 'quotes', 'kv', 'schema_migrations', ...COLLECTION_NAMES]) expect(names.has(t), t).toBe(true);
      const idx = await s.pool.query<{ indexname: string }>('SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()');
      const indexes = new Set(idx.rows.map((r) => r.indexname));
      for (const c of COLLECTION_NAMES) for (const suffix of ['ts_idx', 'instrument_ts_idx', 'status_ts_idx']) expect(indexes.has(`${c}_${suffix}`), `${c}_${suffix}`).toBe(true);
    } finally {
      await s.dropSchema();
      await s.close();
    }
  });

  it('concurrent migrate calls apply each file once', async () => {
    const s = isolated();
    try {
      await s.pool.query(`CREATE SCHEMA IF NOT EXISTS ${(await s.pool.query<{ s: string }>("SELECT split_part(current_setting('search_path'), ',', 1) AS s")).rows[0]!.s}`);
      const runs = await Promise.all([s.migrate(), s.migrate(), s.migrate()]);
      expect(runs.flat().sort()).toEqual(['001_init.sql', '002_timescale.sql']);
    } finally {
      await s.dropSchema();
      await s.close();
    }
  });

  it('createStore returns a PgStore when DATABASE_URL is set', async () => {
    const s = createStore({ DATABASE_URL: url });
    expect(s).toBeInstanceOf(PgStore);
    await s.close();
  });
});
