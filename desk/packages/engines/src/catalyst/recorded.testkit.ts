/**
 * Test-only helpers over data/recorded. Not exported from index.ts: the engine itself never touches the filesystem.
 * The title map covers only the handful of recorded TradingView titles the tests need; the Feeds mapper is the production one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AccountRules, Profile, TF_MS, hashId } from '@desk/contracts';
import type { CalendarEvent, Candle, EventCode, Timeframe } from '@desk/contracts';
import { loadRecordedCalendar, loadRecordedCandles } from '@desk/feeds/recorded.ts';
import type { CandlesByTf, Regime } from './types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const TITLE_CODES: Record<string, EventCode> = {
  'Core Inflation Rate MoM': 'CORE_CPI', 'Core Inflation Rate YoY': 'CORE_CPI', 'Inflation Rate MoM': 'CPI', 'Inflation Rate YoY': 'CPI',
  'PPI MoM': 'PPI', 'Core PPI MoM': 'CORE_PPI', 'Non Farm Payrolls': 'NFP', 'Unemployment Rate': 'UNEMPLOYMENT', 'Interest Rate': 'FOMC',
  'ISM Manufacturing PMI': 'ISM_MFG', 'Initial Jobless Claims': 'CLAIMS', '10-Year Note Auction': 'TREASURY_AUCTION',
};

/** Recorded calendar rows as CalendarEvents. `asOf` is the release time: the row's actual was not known before it. */
export function recordedEvents(): CalendarEvent[] {
  return loadRecordedCalendar().filter((r) => TITLE_CODES[r.title] !== undefined).map((r) => ({
    id: hashId('ev', r.id), code: TITLE_CODES[r.title]!, name: r.title, time: r.date,
    consensus: r.forecast, prior: r.previous, actual: r.actual,
    unit: r.unit ?? r.scale, importance: r.importance, source: 'tradingview:recorded', asOf: r.date,
  }));
}

/** The calendar as it stood at `now`: nothing released at or after `now` has an actual. */
export const asKnownAt = (events: CalendarEvent[], now: number): CalendarEvent[] => events.map((e) => (Date.parse(e.time) >= now ? { ...e, actual: null } : e));

const cache = new Map<string, Candle[]>();
export function recorded(symbol: string, tf: Timeframe): Candle[] {
  const k = `${symbol}.${tf}`;
  if (!cache.has(k)) cache.set(k, loadRecordedCandles(symbol, tf));
  return cache.get(k)!;
}
/** Candles fully closed by `now` (all of them when `now` is omitted). */
export function candlesAsOf(symbol: string, now?: number, tfs: Timeframe[] = ['5m', '1h', '1d']): CandlesByTf {
  return Object.fromEntries(tfs.map((tf) => [tf, recorded(symbol, tf).filter((c) => now === undefined || c.t + TF_MS[tf] <= now)]));
}

export const loadProfile = (): Profile => Profile.parse(parse(readFileSync(join(ROOT, 'profile.yaml'), 'utf8')));
export const loadAccount = (id: string): AccountRules => AccountRules.parse(parse(readFileSync(join(ROOT, 'accounts', `${id}.yaml`), 'utf8')));

/**
 * Regime from recorded data only, as of `now`. Fed stance = direction of the last change in the recorded "Interest Rate"
 * rows within the last three decisions (else hold). Hike and cut odds are not recorded, so they are null, not guessed.
 * Trend = last daily NQ close vs its 50-day mean and the drawdown from the 60-day high. Round level = nearest 0.50%.
 */
export function regimeAsOf(now: number, events: CalendarEvent[]): Regime {
  const fed = events.filter((e) => e.code === 'FOMC' && e.actual !== null && e.prior !== null && Date.parse(e.time) < now).slice(-3);
  const change = [...fed].reverse().find((e) => e.actual !== e.prior);
  const daily = recorded('NQ', '1d').filter((c) => c.t + TF_MS['1d'] <= now);
  const last = daily[daily.length - 1]!.c;
  const sma50 = daily.slice(-50).reduce((a, c) => a + c.c, 0) / Math.min(50, daily.length);
  const dd = (last / Math.max(...daily.slice(-60).map((c) => c.h)) - 1) * 100;
  const y = recorded('US10Y', '1d').filter((c) => c.t + TF_MS['1d'] <= now);
  const y10 = y[y.length - 1]!.c;
  return {
    fedStance: change ? ((change.actual as number) > (change.prior as number) ? 'hiking' : 'cutting') : 'hold',
    hikeProb: null, cutProb: null,
    trend: last > sma50 && dd > -5 ? 'uptrend' : last < sma50 && dd <= -10 ? 'downtrend' : 'correction',
    y10, y10RoundLevelDistanceBp: Math.round((Math.round(y10 * 2) / 2 - y10) * 1000) / 10,
  };
}

/** Last recorded close at or before `now` on the finest timeframe that has one. */
export function lastPrice(symbol: string, now: number): number {
  for (const tf of ['1m', '5m', '1h', '1d'] as const) {
    const cs = recorded(symbol, tf).filter((c) => c.t + TF_MS[tf] <= now);
    const c = cs[cs.length - 1];
    if (c && now - (c.t + TF_MS[tf]) < 4 * 86_400_000) return c.c;
  }
  throw new Error(`No recorded ${symbol} price before ${new Date(now).toISOString()}`);
}
