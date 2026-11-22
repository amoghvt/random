/**
 * The in-memory store the replay walks on. It is a MemoryStore with one read made cheaper: `dataHistory` over a long
 * span returns every reading of the last four UTC days and, before that, the last reading of each UTC day.
 *
 * Why that is safe here: the only long-span reader on the replay's path is the bias snapshot, which itself keeps
 * "everything in the last 3 days, then the last reading of each UTC day" (bias/history `thin`), so it receives exactly
 * the rows it would have kept. The other readers (the 10Y since a release, the freshest datum) look at the last hours
 * or the last row only. Without this, each step would clone some hundred thousand 5m readings it then throws away.
 */
import { DAY, type Datum } from '@desk/contracts';
import { MemoryStore } from '@desk/db';

interface Row { ms: number; d: Datum }
/** Readings newer than this many UTC days before `until` are returned in full. */
export const FULL_RESOLUTION_DAYS = 4;

export class ViewStore extends MemoryStore {
  private readonly series = new Map<string, Row[]>();

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
