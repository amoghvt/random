/**
 * Loader for data/recorded (raw provider payloads captured by scripts/record.py).
 * Used by the 90-day replay, engine fixtures and base-rate computation. Nothing here is synthetic.
 */
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, type Candle, type Timeframe } from '@desk/contracts';

export const RECORDED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../data/recorded');

interface YahooChart { chart: { result: Array<{ timestamp?: number[]; indicators: { quote: Array<{ open: Array<number | null>; high: Array<number | null>; low: Array<number | null>; close: Array<number | null>; volume: Array<number | null> }> } }> } }

const fileFor = (yahoo: string, tf: Timeframe): string => join(RECORDED_DIR, 'candles', `${yahoo.replace(/\^/g, '_').replace(/=/g, '_')}.${tf}.json.gz`);

/** Yahoo symbol for a desk symbol ("NQ" -> "NQ=F"); passes Yahoo symbols through. */
export function yahooSymbol(symbol: string): string {
  return INSTRUMENTS[symbol]?.yahoo || symbol;
}

export function hasRecorded(symbol: string, tf: Timeframe): boolean {
  return existsSync(fileFor(yahooSymbol(symbol), tf));
}

/** Recorded candles, ascending, null bars dropped. `symbol` is the desk symbol (NQ, US10Y, NVDA...). */
export function loadRecordedCandles(symbol: string, tf: Timeframe, range?: { from?: number; to?: number }): Candle[] {
  const raw = JSON.parse(gunzipSync(readFileSync(fileFor(yahooSymbol(symbol), tf))).toString('utf8')) as YahooChart;
  const r = raw.chart.result[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators.quote[0];
  const out: Candle[] = [];
  if (!q) return out;
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    const t = ts[i]! * 1000;
    if (range?.from !== undefined && t < range.from) continue;
    if (range?.to !== undefined && t >= range.to) continue;
    out.push({ symbol, tf, t, o, h, l, c, v: q.volume[i] ?? 0, source: 'yahoo:recorded' });
  }
  return out;
}

export interface RecordedCalendarRow {
  id: string; title: string; country: string; indicator: string; category?: string; period?: string; date: string;
  actual: number | null; forecast: number | null; previous: number | null; importance: number; unit?: string; scale?: string; source?: string;
}
/** Raw TradingView economic-calendar rows for the US, 2024-07 onward, ascending by date. */
export function loadRecordedCalendar(): RecordedCalendarRow[] {
  return JSON.parse(gunzipSync(readFileSync(join(RECORDED_DIR, 'calendar', 'us_events.json.gz'))).toString('utf8')) as RecordedCalendarRow[];
}
