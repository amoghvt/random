import { COLLECTION_KEYS, type CollectionName, type Collections, type IndexKeys } from '@desk/contracts';

/** Canonical UTC ISO string; throws on an unparseable time rather than storing it. */
export function isoOf(t: string | number): string {
  const n = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(n)) throw new Error(`Invalid timestamp: ${String(t)}`);
  return new Date(n).toISOString();
}

/** Last write wins inside one batch, so a batch behaves like the same rows written one by one. */
export function dedupeLast<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

export function assertCollection(c: string): asserts c is CollectionName {
  if (!Object.hasOwn(COLLECTION_KEYS, c)) throw new Error(`Unknown collection: ${c}`);
}

export function indexKeys<K extends CollectionName>(c: K, doc: Collections[K]): IndexKeys {
  assertCollection(c);
  const k = COLLECTION_KEYS[c](doc);
  if (!k.id) throw new Error(`Document in ${c} has no id`);
  return { id: k.id, ts: isoOf(k.ts), instrument: k.instrument, status: k.status };
}

/** JSON round-trip: what a jsonb column gives back (undefined dropped, no shared references). */
export const jsonClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
