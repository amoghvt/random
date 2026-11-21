import type { Store } from '@desk/contracts';
import { MemoryStore } from './memory';
import { PgStore } from './pg';

export { MemoryStore } from './memory';
export { PgStore, type PgStoreOptions } from './pg';
export { migrate, MIGRATIONS_DIR } from './migrate';

/** PgStore when `DATABASE_URL` is set, MemoryStore otherwise. Call `migrateStore` before first use. */
export function createStore(env: { DATABASE_URL?: string | undefined } = process.env): Store {
  return env.DATABASE_URL ? new PgStore({ connectionString: env.DATABASE_URL }) : new MemoryStore();
}

/** Applies pending migrations when the store is Postgres; a no-op for MemoryStore. Returns the names applied. */
export async function migrateStore(store: Store): Promise<string[]> {
  return store instanceof PgStore ? store.migrate() : [];
}
