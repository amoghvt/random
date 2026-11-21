/** Test helpers: recorded candles into the shape snapshotFromHistory reads. Filesystem access lives here, not in the engine. */
import { loadRecordedCandles, hasRecorded } from '@desk/feeds/recorded.ts';
import type { Candle, Timeframe } from '@desk/contracts';
import { candleKey } from './history';
import { PEER_SYMBOLS } from './types';

const cache = new Map<string, Record<string, Candle[]>>();
export function recordedCandlesByKey(symbols: string[] = ['NQ', ...PEER_SYMBOLS], tfs: Timeframe[] = ['1m', '15m', '1h', '1d']): Record<string, Candle[]> {
  const id = `${symbols.join(',')}|${tfs.join(',')}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const out: Record<string, Candle[]> = {};
  for (const s of symbols) for (const tf of tfs) if (hasRecorded(s, tf)) out[candleKey(s, tf)] = loadRecordedCandles(s, tf);
  cache.set(id, out);
  return out;
}
