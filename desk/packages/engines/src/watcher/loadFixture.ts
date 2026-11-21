/** Fixture loader for tests and replays. Reads the filesystem, so it is kept out of index.ts and out of the engine paths. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, Timeframe } from '@desk/contracts';

interface Raw { meta: Record<string, unknown>; m1: Record<string, number[][]>; m15History: Record<string, number[][]>; d1History: Record<string, number[][]> }
export interface SessionFixture { meta: Record<string, unknown>; m1: Record<string, Candle[]>; m15History: Record<string, Candle[]>; d1History: Record<string, Candle[]> }

const toCandles = (symbol: string, tf: Timeframe, rows: number[][]): Candle[] =>
  rows.map((r) => ({ symbol, tf, t: r[0]! * 1000, o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]!, v: r[5]!, source: 'yahoo:recorded' }));
const group = (tf: Timeframe, g: Record<string, number[][]>): Record<string, Candle[]> =>
  Object.fromEntries(Object.entries(g).map(([s, rows]) => [s, toCandles(s, tf, rows)]));

/** Recorded NQ and ES candles for the Nov 16 and Nov 17 2026 ET sessions, plus 15m/1d history to warm the EMAs. */
export function loadSessionFixture(): SessionFixture {
  const raw = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'nq-es-2026-11-16_17.json'), 'utf8')) as Raw;
  return { meta: raw.meta, m1: group('1m', raw.m1), m15History: group('15m', raw.m15History), d1History: group('1d', raw.d1History) };
}
