/**
 * The recording as it could be seen at one instant. `advance(store, now)` writes into a store only what had been
 * published by `now`: candles whose bar had closed, yield and vol readings from those closed bars, and calendar rows
 * with their actual only once the release time has passed. Everything is the real recording in data/recorded; nothing
 * is interpolated, and a series the recording lacks (2Y yield, Fed odds, options, headlines, earnings dates) stays absent.
 */
import { DATUM_KEYS, TF_MS, iso, type CalendarEvent, type Candle, type Datum, type Store, type Timeframe } from '@desk/contracts';
import { hasRecorded, loadRecordedCalendar, loadRecordedCandles, mapTvCalendarRow, volData, type RecordedCalendarRow } from '@desk/feeds';

export const RECORDED_SOURCE = 'yahoo:recorded';
export const RECORDED_CALENDAR_SOURCE = 'tradingview:recorded';
export const VIEW_TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];
/** Finest first: the order a period's resolution is chosen in. */
const INTRADAY: Timeframe[] = ['1m', '5m', '15m', '1h'];

/** Index series the live feeds store as data. Here they are the closes of the recorded bars of the same indices. */
const RATE_SERIES: Array<{ symbol: string; key: string }> = [
  { symbol: 'US10Y', key: DATUM_KEYS.rate('US10Y') }, { symbol: 'US30Y', key: DATUM_KEYS.rate('US30Y') },
  { symbol: 'US5Y', key: DATUM_KEYS.rate('US5Y') }, { symbol: 'US3M', key: DATUM_KEYS.rate('US3M') },
];
const DATUM_SYMBOLS = [...RATE_SERIES.map((s) => s.symbol), 'VIX', 'VIX3M'];
/** Data are taken from 5m closes where the recording has them and from 1h closes before that. */
const DATUM_TFS: Timeframe[] = ['5m', '1h'];

const candleCache = new Map<string, Candle[]>();
/** Recorded candles of one series, ascending; empty when the recording has no such file. Loaded once per process. */
export function recordedSeries(symbol: string, tf: Timeframe): Candle[] {
  const k = `${symbol}.${tf}`;
  let cs = candleCache.get(k);
  if (!cs) { cs = hasRecorded(symbol, tf) ? loadRecordedCandles(symbol, tf) : []; candleCache.set(k, cs); }
  return cs;
}
let calendarRows: RecordedCalendarRow[] | null = null;
const recordedCalendar = (): RecordedCalendarRow[] =>
  (calendarRows ??= [...loadRecordedCalendar()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)));

/** Close time of the last recorded intraday bar of `symbol`: the latest instant the recording can speak for. */
export function recordedEnd(symbol: string): number | null {
  let end: number | null = null;
  for (const tf of INTRADAY) { const c = recordedSeries(symbol, tf).at(-1); if (c) end = Math.max(end ?? 0, c.t + TF_MS[tf]); }
  return end;
}

/** The finest intraday timeframe of `symbol` whose recording has a closed bar by `now`; null before the recording starts. */
export function resolutionAt(symbol: string, now: number): Timeframe | null {
  for (const tf of INTRADAY) {
    const first = recordedSeries(symbol, tf)[0];
    if (first && first.t + TF_MS[tf] <= now) return tf;
  }
  return null;
}

/** A recorded calendar row as the feed would have shown it at `at`: no actual before its release time. */
export function calendarEventAt(r: RecordedCalendarRow, at: number): CalendarEvent {
  const released = Date.parse(r.date) <= at;
  return mapTvCalendarRow({ ...r, actual: released ? r.actual : null }, released ? new Date(r.date).toISOString() : iso(at), RECORDED_CALENDAR_SOURCE);
}

const closeOf = (c: Candle): number => c.t + TF_MS[c.tf];

export interface Advance {
  candles: number; data: number;
  /** Calendar rows whose release time passed in this advance. */
  released: number;
  /** Symbols with an intraday bar that closed in this advance. */
  closed: Set<string>;
}

interface Cursor { symbol: string; tf: Timeframe; bars: Candle[]; i: number }

export class RecordedView {
  private readonly cursors: Cursor[] = [];
  private readonly datumCursors: Array<{ symbol: string; tf: Timeframe; bars: Candle[]; i: number; until: number }> = [];
  private readonly calendar = recordedCalendar();
  private calendarAt = 0;
  private seeded = false;
  /** The instant of the last advance. */
  at = -Infinity;

  constructor(readonly symbols: string[]) {
    for (const symbol of symbols) for (const tf of VIEW_TFS) {
      const bars = recordedSeries(symbol, tf);
      if (bars.length) this.cursors.push({ symbol, tf, bars, i: 0 });
    }
    for (const symbol of DATUM_SYMBOLS) {
      // The coarser series stops where the finer one starts, so a reading never has two sources for one instant.
      let until = Infinity;
      for (const tf of DATUM_TFS) {
        const bars = recordedSeries(symbol, tf);
        if (bars.length === 0) continue;
        this.datumCursors.push({ symbol, tf, bars, i: 0, until });
        until = closeOf(bars[0]!);
      }
    }
  }

  /** Writes everything published in (previous advance, now]. The first call seeds the full history up to `now`. */
  async advance(store: Store, now: number): Promise<Advance> {
    if (now < this.at) throw new Error(`The recorded view only moves forward: ${iso(now)} is before ${iso(this.at)}`);
    const out: Advance = { candles: 0, data: 0, released: 0, closed: new Set() };
    const batch: Candle[] = [];
    for (const cur of this.cursors) {
      const start = cur.i;
      while (cur.i < cur.bars.length && closeOf(cur.bars[cur.i]!) <= now) cur.i++;
      if (cur.i === start) continue;
      for (let k = start; k < cur.i; k++) batch.push(cur.bars[k]!);
      if (cur.tf !== '1d') out.closed.add(cur.symbol);
    }
    if (batch.length) await store.upsertCandles(batch);
    out.candles = batch.length;

    const fresh: Record<string, Candle[]> = {};
    for (const cur of this.datumCursors) {
      while (cur.i < cur.bars.length && closeOf(cur.bars[cur.i]!) <= now) {
        const c = cur.bars[cur.i++]!;
        if (closeOf(c) < cur.until) (fresh[cur.symbol] ??= []).push(c);
      }
    }
    const data = datums(fresh);
    if (data.length) await store.putData(data);
    out.data = data.length;

    if (!this.seeded) {
      await store.put('calendar', this.calendar.map((r) => calendarEventAt(r, now)));
      while (this.calendarAt < this.calendar.length && Date.parse(this.calendar[this.calendarAt]!.date) <= now) this.calendarAt++;
      this.seeded = true;
    } else {
      const due: CalendarEvent[] = [];
      while (this.calendarAt < this.calendar.length && Date.parse(this.calendar[this.calendarAt]!.date) <= now) due.push(calendarEventAt(this.calendar[this.calendarAt++]!, now));
      if (due.length) await store.put('calendar', due);
      out.released = due.length;
    }
    this.at = now;
    return out;
  }
}

/** Rate and vol data from closed bars, stamped at the bar close with the bar's timeframe as the cadence. */
function datums(fresh: Record<string, Candle[]>): Datum[] {
  const out: Datum[] = [];
  const meta = (c: Candle): Record<string, unknown> => ({ tf: c.tf, bar: 'close' });
  for (const s of RATE_SERIES) {
    for (const c of fresh[s.symbol] ?? []) out.push({ key: s.key, value: c.c, source: RECORDED_SOURCE, asOf: iso(closeOf(c)), cadenceSec: TF_MS[c.tf] / 1000, meta: meta(c) });
  }
  const vix3m = new Map((fresh.VIX3M ?? []).map((c) => [`${c.tf}|${c.t}`, c]));
  const reading = (c: Candle): { value: number; asOf: string; source: string } => ({ value: c.c, asOf: iso(closeOf(c)), source: RECORDED_SOURCE });
  const paired = new Set<string>();
  for (const c of fresh.VIX ?? []) {
    const k = `${c.tf}|${c.t}`, far = vix3m.get(k);
    if (far) paired.add(k);
    // The same function the live vol feed uses: vol.VIX, vol.VIX3M and vol.term (VIX3M / VIX) from two index levels.
    out.push(...volData(reading(c), far ? reading(far) : undefined, TF_MS[c.tf] / 1000, meta(c)));
  }
  for (const [k, c] of vix3m) if (!paired.has(k)) out.push(...volData(undefined, reading(c), TF_MS[c.tf] / 1000, meta(c)));
  return out;
}
