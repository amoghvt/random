/** `pnpm migrate`: applies pending SQL migrations to DATABASE_URL and exits. */
import { createStore, migrateStore, PgStore } from '@desk/db';
import { parseEnv } from '../env';

const env = parseEnv();
const store = createStore(env);
try {
  if (!(store instanceof PgStore)) {
    console.error('DATABASE_URL is not set; nothing to migrate.');
    process.exitCode = 1;
  } else {
    const applied = await migrateStore(store);
    console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Up to date.');
  }
} finally {
  await store.close();
}
