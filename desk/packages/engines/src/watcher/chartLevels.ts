/** What the chart draws: resting liquidity, live FVGs, live order blocks and the EMAs. Selection only; the detectors did the work. */
import type { StructureEvent, Timeframe } from '@desk/contracts';

export interface ChartLine { price: number; tf: Timeframe; label: string; eventId: string; asOf: string }
export interface ChartZone { lo: number; hi: number; tf: Timeframe; direction: 'bull' | 'bear'; state: string; label: string; eventId: string; asOf: string }
export interface ChartLevels {
  liquidity: Array<ChartLine & { side: 'buy' | 'sell'; touches: number }>;
  fvgs: ChartZone[]; orderBlocks: ChartZone[];
  emas: Array<ChartLine & { period: 20 | 50 | 200 }>;
  setups: ChartLine[];
}

const zone = (e: StructureEvent): ChartZone => ({
  lo: e.level!, hi: e.levelHi!, tf: e.tf, direction: e.data.direction === 'bear' ? 'bear' : 'bull', state: String(e.data.state), label: String(e.data.short ?? e.kind), eventId: e.id, asOf: e.ts,
});

/** `maxPerKind` keeps the most recent zones per timeframe-agnostic list (default 8) so a phone chart stays readable. */
export function chartLevels(events: StructureEvent[], opts: { maxPerKind?: number } = {}): ChartLevels {
  const max = opts.maxPerKind ?? 8;
  const recent = <T extends { asOf: string }>(xs: T[]): T[] => xs.sort((a, b) => (a.asOf < b.asOf ? 1 : -1)).slice(0, max);
  const out: ChartLevels = { liquidity: [], fvgs: [], orderBlocks: [], emas: [], setups: [] };
  const seenLiq = new Set<string>();
  const latestPosture = new Map<Timeframe, StructureEvent>();
  for (const e of events) {
    if (e.detector === 'liquidity_pool' && e.level != null) {
      const side = e.kind === 'equal_highs' || e.kind === 'buy_side_liquidity' ? 'buy' : 'sell';
      const price = side === 'buy' ? (e.levelHi ?? e.level) : e.level;
      const key = `${e.tf}|${side}|${price}`;
      if (seenLiq.has(key)) continue;
      seenLiq.add(key);
      const touches = typeof e.data.touches === 'number' ? e.data.touches : 1;
      out.liquidity.push({ price, tf: e.tf, side, touches, label: `${side === 'buy' ? 'Buy' : 'Sell'} stops${touches > 1 ? ` x${touches}` : ''}`, eventId: e.id, asOf: e.ts });
    } else if (e.detector === 'fvg' && e.data.state !== 'filled' && e.level != null && e.levelHi != null) out.fvgs.push(zone(e));
    else if (e.detector === 'order_block' && e.data.state !== 'invalidated' && e.level != null && e.levelHi != null) out.orderBlocks.push(zone(e));
    else if (e.detector === 'ema_posture' && e.kind.startsWith('ema_')) {
      const cur = latestPosture.get(e.tf);
      if (!cur || Number(cur.data.asOfT) <= Number(e.data.asOfT)) latestPosture.set(e.tf, e);
    } else if (e.confirmedSetup && e.level != null) out.setups.push({ price: e.level, tf: e.tf, label: String(e.data.short ?? e.kind), eventId: e.id, asOf: e.ts });
  }
  for (const e of latestPosture.values()) {
    for (const period of [20, 50, 200] as const) {
      const v = e.data[`ema${period}`];
      if (typeof v === 'number') out.emas.push({ price: v, tf: e.tf, period, label: `${e.tf} ${period} EMA`, eventId: e.id, asOf: new Date(Number(e.data.asOfT)).toISOString() });
    }
  }
  out.liquidity = recent(out.liquidity); out.fvgs = recent(out.fvgs); out.orderBlocks = recent(out.orderBlocks); out.setups = recent(out.setups);
  return out;
}
