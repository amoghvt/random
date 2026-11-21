/**
 * Prints the watcher base rates measured on the recorded NQ 15m and 1h candles.
 * Run from the repo root: npx tsx packages/engines/src/watcher/__fixtures__/baseRates.report.ts [SYMBOL]
 */
import { loadRecordedCandles } from '@desk/feeds';
import { baseRateText, computeBaseRates } from '../baseRates';

const symbol = process.argv[2] ?? 'NQ';
const m15 = loadRecordedCandles(symbol, '15m'), h1 = loadRecordedCandles(symbol, '1h');
const now = Math.max(m15[m15.length - 1]!.t, h1[h1.length - 1]!.t) + 3_600_000;
for (const r of computeBaseRates({ '15m': m15, '1h': h1 }, now)) console.log(`${r.instrument} ${r.tf} | ${baseRateText(r)} | hitRate ${r.hitRate} n ${r.n} window ${r.windowDays}d as of ${r.asOf}`);
