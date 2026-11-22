/**
 * The in-memory store the replay walks on: a MemoryStore with two reads made cheaper.
 *
 * 1. Bias calls and structure events are kept deep-frozen and handed out by reference instead of being cloned on every
 *    read (a call carries about 23 kB of inputs and the loop lists the open ones every step). A reader that tried to
 *    change one would throw, and the replay would report that step as failed; nothing can be changed silently.
 * 2. `dataHistory` over a long span returns every reading of the last four UTC days and, before that, the last reading
 *    of each UTC day.
 *
 * Why the second is safe here: the only long-span reader on the replay's path is the bias snapshot, which itself keeps
 * "everything in the last 3 days, then the last reading of each UTC day" (bias/history `thin`), so it receives exactly
 * the rows it would have kept. The other readers (the 10Y since a release, the freshest datum) look at the last hours
 * or the last row only. Without this, each step would clone some hundred thousand 5m readings it then throws away.
 */
import { COLLECTION_KEYS, DAY, type CollectionName, type Collections, type Datum, type IndexKeys, type ListOpts } from '@desk/contracts';
import { MemoryStore } from '@desk/db';

type Shared = 'bias_calls' | 'structure_events';
const SHARED: ReadonlySet<CollectionName> = new Set<Shared>(['bias_calls', 'structure_events']);
interface SharedRow { keys: IndexKeys; tsMs: number; doc: Collections[Shared] }

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

interface Row { ms: number; d: Datum }
/** Readings newer than this many UTC days before `until` are returned in full. */
export const FULL_RESOLUTION_DAYS = 4;

export class ViewStore extends MemoryStore {
  private readonly series = new Map<string, Row[]>();
  private readonly shared = new Map<CollectionName, Map<string, SharedRow>>();

  private rows(c: CollectionName): Map<string, SharedRow> {
    let t = this.shared.get(c);
    if (!t) this.shared.set(c, (t = new Map()));
    return t;
  }

  override async put<K extends CollectionName>(c: K, docs: Array<Collections[K]>): Promise<void> {
    if (!SHARED.has(c)) return super.put(c, docs);
    const t = this.rows(c);
    for (const doc of docs) {
      const keys = COLLECTION_KEYS[c](doc);
      const tsMs = Date.parse(keys.ts);
      if (!keys.id || !Number.isFinite(tsMs)) throw new Error(`Document in ${c} has no id or no valid time`);
      // A JSON round trip first, as a jsonb column would give it back; an already frozen doc was stored that way before.
      const stored = Object.isFrozen(doc) ? doc : deepFreeze(JSON.parse(JSON.stringify(doc)) as Collections[K]);
      t.set(keys.id, { keys, tsMs, doc: stored as Collections[Shared] });
    }
  }

  override async get<K extends CollectionName>(c: K, id: string): Promise<Collections[K] | null> {
    if (!SHARED.has(c)) return super.get(c, id);
    return (this.rows(c).get(id)?.doc as Collections[K] | undefined) ?? null;
  }

  override async list<K extends CollectionName>(c: K, opts: ListOpts = {}): Promise<Array<Collections[K]>> {
    if (!SHARED.has(c)) return super.list(c, opts);
    const since = opts.since === undefined ? -Infinity : Date.parse(opts.since), until = opts.until === undefined ? Infinity : Date.parse(opts.until);
    const statuses = opts.status === undefined ? null : new Set(Array.isArray(opts.status) ? opts.status : [opts.status]);
    const dir = opts.order === 'asc' ? 1 : -1;
    const rows = [...this.rows(c).values()]
      .filter((r) => r.tsMs >= since && r.tsMs < until
        && (opts.instrument === undefined || r.keys.instrument === opts.instrument)
        && (statuses === null || (r.keys.status !== null && statuses.has(r.keys.status))))
      .sort((x, y) => dir * (x.tsMs - y.tsMs || (x.keys.id < y.keys.id ? -1 : x.keys.id > y.keys.id ? 1 : 0)));
    return (opts.limit === undefined ? rows : rows.slice(0, Math.max(0, opts.limit))).map((r) => r.doc as Collections[K]);
  }

  override async remove<K extends CollectionName>(c: K, id: string): Promise<void> {
    if (!SHARED.has(c)) return super.remove(c, id);
    this.rows(c).delete(id);
  }

  override async putData(data: Datum[]): Promise<void> {
    await super.putData(data);
    for (const d of data) {
      const ms = Date.parse(d.asOf);
      let rows = this.series.get(d.key);
      if (!rows) this.series.set(d.key, (rows = []));
      const row: Row = { ms, d: { ...d, asOf: new Date(ms).toISOString() } };
      const last = rows.at(-1);
      if (!last || last.ms < ms) { rows.push(row); continue; }
      const i = rows.findIndex((r) => r.ms >= ms);
      if (rows[i]!.ms === ms) rows[i] = row; else rows.splice(i, 0, row);
    }
  }

  override async dataHistory(key: string, sinceMs: number, untilMs?: number): Promise<Datum[]> {
    if (untilMs === undefined) return super.dataHistory(key, sinceMs);
    const rows = this.series.get(key) ?? [];
    const full = Math.floor((untilMs - FULL_RESOLUTION_DAYS * DAY) / DAY) * DAY;
    const out: Datum[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.ms < sinceMs) continue;
      if (r.ms > untilMs) break;
      if (r.ms < full) {
        // Last reading of its UTC day: the next row is on a later day, or past the thinned span.
        const next = rows[i + 1];
        if (next && next.ms < full && Math.floor(next.ms / DAY) === Math.floor(r.ms / DAY)) continue;
      }
      out.push({ ...r.d, ...(r.d.meta ? { meta: { ...r.d.meta } } : {}) });
    }
    return out;
  }
}
