/** The chart view: candles, the three EMAs the trader uses, the watcher's levels and the fail price of anything open. */
import { DAY, INSTRUMENTS, KV, TF_MS, freshness, iso, type ChartView, type PositionStatus, type StructureEvent, type Timeframe } from '@desk/contracts';
import { watcher as w } from '@desk/engines';
import type { DeskDeps } from './context';
import { priceSymbolOf } from './market';

export const CHART_BARS = 500;
/** Bars read ahead of the visible window so the 200 EMA has settled by the first bar drawn. */
const EMA_WARMUP = 600;
const TF_ORDER: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];
/** How far back a level can have formed and still be drawn, by the chart's timeframe. */
const LEVEL_LOOKBACK_MS: Record<Timeframe, number> = { '1m': 2 * DAY, '5m': 5 * DAY, '15m': 10 * DAY, '1h': 30 * DAY, '1d': 120 * DAY };

export const knownSymbol = (symbol: string): boolean => INSTRUMENTS[symbol] !== undefined;

export async function chartView(deps: DeskDeps, symbol: string, tf: Timeframe, now: number): Promise<ChartView> {
  const series = priceSymbolOf(symbol);
  const [all, events, positions, statuses] = await Promise.all([
    deps.store.getCandles(series, tf, { to: now, limit: CHART_BARS + EMA_WARMUP }),
    deps.store.list('structure_events', { instrument: series, since: iso(now - LEVEL_LOOKBACK_MS[tf]), until: iso(now + 1) }),
    deps.store.list('positions'), deps.store.kvGet<Record<string, PositionStatus>>(KV.positionStatus),
  ]);
  const closes = all.map((c) => c.c);
  const from = Math.max(0, all.length - CHART_BARS);
  const line = (period: number): Array<{ t: number; v: number }> => {
    const values = w.ema(closes, period);
    return all.slice(from).flatMap((c, i) => { const v = values[from + i]; return v == null ? [] : [{ t: c.t, v: Math.round(v * 100) / 100 }]; });
  };

  // Levels from this timeframe and the ones above it: an hourly pool matters on a 15m chart, a 1m gap does not.
  const drawn = events.filter((e) => TF_ORDER.indexOf(e.tf) >= TF_ORDER.indexOf(tf));
  const picked = w.chartLevels(drawn);
  const ids = new Set([...picked.liquidity, ...picked.fvgs, ...picked.orderBlocks, ...picked.setups].map((l) => l.eventId));
  const levels: StructureEvent[] = drawn.filter((e) => ids.has(e.id));

  const failPrices = positions.filter((p) => priceSymbolOf(p.instrument) === series).flatMap((p) => {
    // The monitor's fail price when it has marked the position; otherwise the venue's liquidation price as the trader entered it.
    const price = statuses?.[p.id]?.failPrice ?? p.liquidationPrice;
    return price === null || price === undefined ? [] : [{ positionId: p.id, accountId: p.accountId, price }];
  });

  const last = all.at(-1);
  const asOf = last ? iso(Math.min(last.t + TF_MS[tf], now)) : null;
  return {
    symbol, tf, asOf, stale: asOf === null || freshness({ asOf, cadenceSec: TF_MS[tf] / 1000 }, now) === 'stale',
    candles: all.slice(from), ema: { e20: line(20), e50: line(50), e200: line(200) }, levels, failPrices,
  };
}
