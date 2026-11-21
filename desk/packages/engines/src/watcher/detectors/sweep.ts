/** Sweep and reclaim: price trades through a swing and closes back inside within N candles. */
import type { StructureEvent } from '@desk/contracts';
import { PARAMS, mkEvent, when, type TfContext } from '../core';

/** Only swings this recent are tracked for sweeps, to bound the work on long histories. */
const SWING_MAX_AGE = 300;

export function detectSweeps(ctx: TfContext): StructureEvent[] {
  const out: StructureEvent[] = [];
  const { c, n } = ctx;
  for (const p of ctx.pivots) {
    const low = p.type === 'low';
    if (p.i + SWING_MAX_AGE < ctx.scanFrom) continue;
    // First trade through the level after the swing is confirmed.
    let j = -1;
    for (let k = p.confirmedI + 1; k < Math.min(n, p.i + SWING_MAX_AGE); k++) {
      if (low ? c[k]!.l < p.level : c[k]!.h > p.level) { j = k; break; }
    }
    if (j < 0) continue;
    let extreme = low ? c[j]!.l : c[j]!.h;
    for (let k = j; k < Math.min(n, j + PARAMS.reclaimWithin); k++) {
      extreme = low ? Math.min(extreme, c[k]!.l) : Math.max(extreme, c[k]!.h);
      const inside = low ? c[k]!.c > p.level : c[k]!.c < p.level;
      if (!inside) continue;
      if (k < ctx.scanFrom) break;
      const a = ctx.atr[k];
      const pool = ctx.pivots.some((q) => q !== p && q.type === p.type && q.i < j && Math.abs(q.level - p.level) <= PARAMS.equalPct * p.level);
      const depth = Math.abs(extreme - p.level);
      const candles = k - j + 1;
      out.push(mkEvent(ctx, 'sweep_reclaim', k, {
        kind: low ? 'sweep_reclaim_low' : 'sweep_reclaim_high', level: p.level, bias: low ? 1 : -1,
        confidence: 0.55 + (pool ? 0.1 : 0) + (candles === 1 ? 0.05 : 0), anchor: [p.t, c[j]!.t],
        text: `${ctx.instrument} ${ctx.tf} swept the ${when(ctx.tf, p.t, c[k]!.t)} swing ${p.type} ${ctx.px(p.level)} by ${ctx.px(depth)} pts to ${ctx.px(extreme)}, closed back ${low ? 'above' : 'below'} at ${ctx.px(c[k]!.c)} within ${candles} candle${candles > 1 ? 's' : ''}. Sweep and reclaim; not a setup until an MSS ${low ? 'up' : 'down'}.`,
        short: `${ctx.tf} swept ${ctx.px(p.level)} and reclaimed`,
        data: { sweptLevel: p.level, sweptPivotT: p.t, sweepT: c[j]!.t, extreme, depthPts: depth, depthAtr: a ? depth / a : null, candlesToReclaim: candles, pool, direction: low ? 'long' : 'short' },
      }));
      break;
    }
  }
  return out;
}

/**
 * The one setup a ticket may reference: a sweep and reclaim followed by an MSS in the reclaim direction
 * within PARAMS.setupWithin candles, with the sweep extreme still intact.
 */
export function confirmSetups(ctx: TfContext, sweeps: StructureEvent[], shifts: StructureEvent[]): StructureEvent[] {
  const byMss = new Map<string, { k: number; e: StructureEvent }>();
  const at = new Map<number, number>();
  ctx.c.forEach((k, i) => at.set(k.t, i));
  for (const s of sweeps) {
    const k = at.get(s.data.candleT as number);
    if (k === undefined) continue;
    const long = s.bias === 1;
    const extreme = s.data.extreme as number;
    const mss = shifts
      .filter((m) => m.detector === 'mss' && m.bias === s.bias)
      .map((m) => ({ m, i: at.get(m.data.candleT as number) }))
      .filter((x): x is { m: StructureEvent; i: number } => x.i !== undefined && x.i >= k && x.i <= k + PARAMS.setupWithin)
      .sort((a, b) => a.i - b.i)[0];
    if (!mss) continue;
    let intact = true;
    for (let j = k + 1; j <= mss.i && intact; j++) intact = long ? ctx.c[j]!.l >= extreme : ctx.c[j]!.h <= extreme;
    if (!intact) continue;
    const cur = byMss.get(mss.m.id);
    if (cur && cur.k >= k) continue;
    byMss.set(mss.m.id, { k, e: mkEvent(ctx, 'sweep_reclaim', mss.i, {
      kind: long ? 'sweep_reclaim_mss_long' : 'sweep_reclaim_mss_short', level: mss.m.level, bias: s.bias, confidence: 0.75,
      anchor: [mss.m.id], confirmedSetup: true,
      text: `${ctx.instrument} ${ctx.tf} swept ${ctx.px(s.level ?? 0)} to ${ctx.px(extreme)}, reclaimed, then closed ${long ? 'above' : 'below'} ${ctx.px(mss.m.level ?? 0)} (MSS) ${mss.i - k} candle${mss.i - k === 1 ? '' : 's'} later. Confirmed setup ${long ? 'long' : 'short'}; invalid ${long ? 'below' : 'above'} ${ctx.px(extreme)}.`,
      short: `${ctx.tf} sweep of ${ctx.px(s.level ?? 0)} + MSS ${long ? 'up' : 'down'} through ${ctx.px(mss.m.level ?? 0)}: confirmed setup`,
      data: { sweepEventId: s.id, mssEventId: mss.m.id, sweptLevel: s.level, mssLevel: mss.m.level, invalidation: extreme, direction: long ? 'long' : 'short', candlesFromReclaim: mss.i - k },
    }) });
  }
  return [...byMss.values()].map((x) => x.e);
}
