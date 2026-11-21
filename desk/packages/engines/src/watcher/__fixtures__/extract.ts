/**
 * Extracts the recorded Nov 16 and Nov 17 2026 sessions into a compact fixture so the watcher tests do not read data/recorded.
 * Run from the repo root: npx tsx packages/engines/src/watcher/__fixtures__/extract.ts
 * Values are copied from the recording unchanged (prices rounded to 2 dp). Nothing is synthesized or filled.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZoned, type Candle, type Timeframe } from '@desk/contracts';
import { loadRecordedCandles } from '@desk/feeds';

const FROM = fromZoned(2026, 11, 15, 18, 0); // Globex open for the Nov 16 trade date
const TO = fromZoned(2026, 11, 18, 0, 0); // end of the Nov 17 ET calendar day
const HISTORY_FROM = fromZoned(2026, 10, 26, 0, 0);
const r2 = (x: number): number => Math.round(x * 100) / 100;
const rows = (cs: Candle[]): number[][] => cs.map((k) => [k.t / 1000, r2(k.o), r2(k.h), r2(k.l), r2(k.c), k.v]);
const load = (sym: string, tf: Timeframe, from: number, to: number): number[][] => rows(loadRecordedCandles(sym, tf, { from, to }));

const fixture = {
  meta: {
    source: 'data/recorded (Yahoo v8 chart, delayed, unofficial), via loadRecordedCandles',
    extractedBy: 'packages/engines/src/watcher/__fixtures__/extract.ts',
    columns: ['t (epoch s, candle open)', 'o', 'h', 'l', 'c', 'v'],
    m1Range: { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() },
    historyRange: { from: new Date(HISTORY_FROM).toISOString(), to: new Date(FROM).toISOString() },
    note: 'm1 = recorded 1m candles for the Nov 16 and Nov 17 2026 ET sessions. m15History and d1History are recorded 15m/1d candles before them, used only to warm EMAs.',
  },
  m1: { NQ: load('NQ', '1m', FROM, TO), ES: load('ES', '1m', FROM, TO) },
  m15History: { NQ: load('NQ', '15m', HISTORY_FROM, FROM), ES: load('ES', '15m', HISTORY_FROM, FROM) },
  d1History: { NQ: load('NQ', '1d', fromZoned(2025, 9, 1), fromZoned(2026, 11, 14)) },
};
const out = join(dirname(fileURLToPath(import.meta.url)), 'nq-es-2026-11-16_17.json');
writeFileSync(out, JSON.stringify(fixture));
console.log(out, Object.fromEntries(Object.entries(fixture).filter(([k]) => k !== 'meta').map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([s, r]) => [s, (r as number[][]).length]))])));
