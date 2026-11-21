/** Reads of the market state in the store: candles, last prices, quotes and the rates strip, each with its staleness. */
import {
  DATUM_KEYS, DAY, HOUR, INSTRUMENTS, TF_MS, ageLabel, freshness, iso,
  type Candle, type Datum, type Quote, type RatesStrip, type Timeframe,
} from '@desk/contracts';
import { changeBp, stamped } from '@desk/feeds';
import type { sizing } from '@desk/engines';
import type { DeskDeps } from './context';

/** The series an instrument is priced on: NQ-PERP and MNQ read NQ. */
export const priceSymbolOf = (instrument: string): string => INSTRUMENTS[instrument]?.priceSymbol ?? instrument;

const DEFAULT_LIMIT: Record<Timeframe, number> = { '1m': 1500, '5m': 1500, '15m': 1500, '1h': 1500, '1d': 900 };
export const TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];

/** Candle reads for one instant, memoized so a loop reads each series once. Nothing stamped after `now` is returned. */
export interface CandleReader {
  now: number;
  /** Ascending candles of the instrument's price series opened at or before `now`; the last may be in progress. */
  get(instrument: string, tf: Timeframe, limit?: number): Promise<Candle[]>;
  /** Only bars fully closed by `now`. */
  closed(instrument: string, tf: Timeframe, limit?: number): Promise<Candle[]>;
}
export function candleReader(deps: DeskDeps, now: number): CandleReader {
  const cache = new Map<string, Promise<Candle[]>>();
  const get = (instrument: string, tf: Timeframe, limit: number = DEFAULT_LIMIT[tf]): Promise<Candle[]> => {
    const symbol = priceSymbolOf(instrument);
    const key = `${symbol}|${tf}|${limit}`;
    let p = cache.get(key);
    if (!p) { p = deps.store.getCandles(symbol, tf, { to: now, limit }); cache.set(key, p); }
    return p;
  };
  return {
    now, get,
    closed: async (instrument, tf, limit) => (await get(instrument, tf, limit)).filter((c) => c.t + TF_MS[tf] <= now),
  };
}

export async function candlesByTf(reader: CandleReader, instrument: string, tfs: Timeframe[] = TFS, limits: Partial<Record<Timeframe, number>> = {}): Promise<Partial<Record<Timeframe, Candle[]>>> {
  const out: Partial<Record<Timeframe, Candle[]>> = {};
  for (const tf of tfs) { const cs = await reader.get(instrument, tf, limits[tf]); if (cs.length) out[tf] = cs; }
  return out;
}

/** The sizing engine's candle set: 1m for the ATR, 15m and 1h for the window p95 over 60 sessions, daily for weekend gaps. */
export async function sizingCandles(reader: CandleReader, instrument: string): Promise<sizing.CandleSet> {
  const [m1, m15, h1, d1] = await Promise.all([reader.closed(instrument, '1m', 600), reader.closed(instrument, '15m', 6000), reader.closed(instrument, '1h', 1500), reader.closed(instrument, '1d', 900)]);
  return { m1, m15, h1, d1 };
}

/**
 * Minute-resolution candles from `from` to `now` for clocks and deviation checks: 1m bars when the store has them
 * over the span, otherwise the closed 5m bars (each still carries its own timeframe, so nothing reads past its close).
 */
export async function fineCandles(deps: DeskDeps, instrument: string, from: number, now: number): Promise<Candle[]> {
  const symbol = priceSymbolOf(instrument);
  const m1 = (await deps.store.getCandles(symbol, '1m', { from: from - 10 * 60_000, to: now })).filter((c) => c.t + TF_MS['1m'] <= now);
  if (m1.length > 0 && m1[0]!.t <= from) return m1;
  const m5 = (await deps.store.getCandles(symbol, '5m', { from: from - 30 * 60_000, to: now })).filter((c) => c.t + TF_MS['5m'] <= now);
  return m5.length > 0 ? m5 : m1;
}

export interface PriceRead { symbol: string; price: number; asOf: string; source: string; cadenceSec: number; stale: boolean; age: string }

/** Latest price of the instrument's series: the fresher of the stored quote and the last candle on any timeframe. */
export async function lastPrice(deps: DeskDeps, instrument: string, now: number, reader: CandleReader = candleReader(deps, now)): Promise<PriceRead | null> {
  const symbol = priceSymbolOf(instrument);
  const cands: Array<{ price: number; asOf: string; source: string; cadenceSec: number }> = [];
  const q = (await deps.store.latestQuotes([symbol]))[symbol];
  if (q && Date.parse(q.asOf) <= now) cands.push({ price: q.price, asOf: q.asOf, source: q.source, cadenceSec: q.cadenceSec });
  for (const tf of TFS) {
    const c = (await reader.get(symbol, tf)).at(-1);
    if (c) cands.push({ price: c.c, asOf: iso(Math.min(c.t + TF_MS[tf], now)), source: `${c.source} ${tf}`, cadenceSec: TF_MS[tf] / 1000 });
  }
  // Latest reading wins; on a tie the finer series (listed first) is kept.
  let best: (typeof cands)[number] | null = null;
  for (const c of cands) if (!best || Date.parse(c.asOf) > Date.parse(best.asOf)) best = c;
  if (!best) return null;
  return { symbol, ...best, stale: freshness(best, now) === 'stale', age: ageLabel(best.asOf, now) };
}

export async function quotesView(deps: DeskDeps, now: number, symbols?: string[]): Promise<Record<string, Quote & { stale: boolean; age: string }>> {
  const quotes = await deps.store.latestQuotes(symbols);
  return Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, { ...q, stale: freshness(q, now) === 'stale', age: ageLabel(q.asOf, now) }]));
}

/**
 * Quotes for the symbols asked for. Where the quote feed has nothing for a symbol, one is built from the stored
 * candles (last price against the last closed daily bar) and says so in its source.
 */
export async function quotesWithFallback(deps: DeskDeps, now: number, symbols: string[], reader: CandleReader = candleReader(deps, now)): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = await deps.store.latestQuotes(symbols);
  for (const s of symbols) {
    if (out[s]) continue;
    const last = await lastPrice(deps, s, now, reader);
    if (!last) continue;
    const prev = (await reader.closed(s, '1d')).at(-1)?.c ?? null;
    out[s] = { symbol: s, price: last.price, prevClose: prev, changePct: prev ? Math.round((last.price / prev - 1) * 10000) / 100 : null, asOf: last.asOf, source: `candles:${last.source}`, cadenceSec: last.cadenceSec };
  }
  return out;
}

/** Weekends and holidays sit between a yield and its reading "one day ago". */
const DAY_TOLERANCE_MS = 4 * DAY;

/** 2Y / 10Y / 30Y with 1h and 1d changes in bp (never across sources), 2s10s and the Fed odds. */
export async function ratesStrip(deps: DeskDeps, now: number): Promise<RatesStrip> {
  const k2 = DATUM_KEYS.rate('US2Y'), k10 = DATUM_KEYS.rate('US10Y'), k30 = DATUM_KEYS.rate('US30Y');
  const keys = [k2, k10, k30, DATUM_KEYS.spread2s10s, DATUM_KEYS.fedHike, DATUM_KEYS.fedCut, DATUM_KEYS.fedHold];
  const latest: Record<string, Datum> = {};
  const hist: Record<string, Datum[]> = {};
  for (const key of [k2, k10]) {
    hist[key] = await deps.store.dataHistory(key, now - 6 * DAY, now);
    const last = hist[key].at(-1);
    if (last) latest[key] = last;
  }
  for (const key of keys) {
    if (latest[key]) continue;
    const d = (await deps.store.dataHistory(key, now - 30 * DAY, now)).at(-1);
    if (d) latest[key] = d;
  }
  const chg = (key: string, windowMs: number, tol?: number): number | null => changeBp(hist[key] ?? [], windowMs, tol)?.bp ?? null;
  const y2 = latest[k2], y10 = latest[k10], spread = latest[DATUM_KEYS.spread2s10s];
  const hike = latest[DATUM_KEYS.fedHike];
  const meeting = hike?.meta && typeof hike.meta.meeting === 'string' ? hike.meta.meeting : null;
  return {
    y2: stamped(y2, now), y10: stamped(y10, now), y30: stamped(latest[k30], now),
    y2Chg1hBp: chg(k2, HOUR), y10Chg1hBp: chg(k10, HOUR), y2Chg1dBp: chg(k2, DAY, DAY_TOLERANCE_MS), y10Chg1dBp: chg(k10, DAY, DAY_TOLERANCE_MS),
    spread2s10sBp: spread && freshness(spread, now) !== 'stale' ? spread.value : null,
    fed: { hike: stamped(hike, now), cut: stamped(latest[DATUM_KEYS.fedCut], now), hold: stamped(latest[DATUM_KEYS.fedHold], now), meeting },
  };
}

/** 10Y level now and its move since `since`, from one source; null when the store has no reading on both sides. */
export async function y10Since(deps: DeskDeps, since: number, now: number): Promise<{ y10: number; y10ChangeBp: number; pre: number } | null> {
  const h = await deps.store.dataHistory(DATUM_KEYS.rate('US10Y'), since - 2 * HOUR, now);
  const last = h.at(-1);
  if (!last || Date.parse(last.asOf) <= since) return null;
  const pre = h.filter((d) => Date.parse(d.asOf) <= since && d.source === last.source).at(-1);
  if (!pre) return null;
  return { y10: last.value, y10ChangeBp: Math.round((last.value - pre.value) * 1000) / 10, pre: pre.value };
}
