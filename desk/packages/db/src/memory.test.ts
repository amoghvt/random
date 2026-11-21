import { expect, it } from 'vitest';
import { storeConformance } from './conformance';
import { createStore, MemoryStore, migrateStore } from './index';

storeConformance('MemoryStore', async () => new MemoryStore());

it('createStore returns a MemoryStore when DATABASE_URL is not set, and migrating it is a no-op', async () => {
  const store = createStore({});
  expect(store).toBeInstanceOf(MemoryStore);
  expect(await migrateStore(store)).toEqual([]);
});
