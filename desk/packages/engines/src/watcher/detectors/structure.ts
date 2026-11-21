/** Market structure shift (close beyond the last lower-high / higher-low) and break of structure (continuation). */
import type { StructureEvent } from '@desk/contracts';
import type { Pivot } from '../candles';
import { mkEvent, when, type TfContext } from '../core';

export function detectStructure(ctx: TfContext): StructureEvent[] {
  const out: StructureEvent[] = [];
  const byConfirm = new Map<number, Pivot[]>();
  for (const p of ctx.pivots) byConfirm.set(p.confirmedI, [...(byConfirm.get(p.confirmedI) ?? []), p]);
  let lastHigh: Pivot | undefined, prevHigh: Pivot | undefined, lastLow: Pivot | undefined, prevLow: Pivot | undefined;
  let highBroken = false, lowBroken = false;
  let trend: -1 | 0 | 1 = 0;
  for (let j = 0; j < ctx.n; j++) {
    const k = ctx.c[j]!;
    const a = ctx.atr[j];
    for (const up of [true, false]) {
      const pivot = up ? lastHigh : lastLow, prev = up ? prevHigh : prevLow;
      if (!pivot || (up ? highBroken : lowBroken)) continue;
      if (up ? k.c <= pivot.level : k.c >= pivot.level) continue;
      // Against the trend, or through a lower-high / higher-low, the break is a shift; with the trend it is continuation.
      const counter = up ? pivot.level < (prev?.level ?? -Infinity) : pivot.level > (prev?.level ?? Infinity);
      const shift = trend === (up ? -1 : 1) || counter;
      if (up) highBroken = true; else lowBroken = true;
      trend = up ? 1 : -1;
      if (j < ctx.scanFrom) continue;
      const beyond = Math.abs(k.c - pivot.level);
      const displaced = a != null && beyond >= 0.5 * a;
      const what = up ? (counter ? 'lower high' : 'swing high') : (counter ? 'higher low' : 'swing low');
      out.push(mkEvent(ctx, shift ? 'mss' : 'bos', j, {
        kind: `${shift ? 'mss' : 'bos'}_${up ? 'bullish' : 'bearish'}`, level: pivot.level, bias: up ? 1 : -1,
        confidence: (shift ? 0.6 : 0.55) + (displaced ? 0.1 : 0), anchor: [pivot.t, k.t],
        text: `${ctx.instrument} ${ctx.tf} closed ${ctx.px(k.c)}, ${ctx.px(beyond)} pts ${up ? 'above' : 'below'} the ${when(ctx.tf, pivot.t, k.t)} ${what} ${ctx.px(pivot.level)}. ${shift ? `MSS ${up ? 'up' : 'down'}: structure shifted.` : `BOS ${up ? 'up' : 'down'}: trend continues.`}`,
        short: `${ctx.tf} ${shift ? 'MSS' : 'BOS'} ${up ? 'up' : 'down'} through ${ctx.px(pivot.level)}`,
        data: { brokenLevel: pivot.level, brokenPivotT: pivot.t, close: k.c, beyondPts: beyond, beyondAtr: a ? beyond / a : null, priorTrend: shift ? (up ? 'down' : 'up') : (up ? 'up' : 'down') },
      }));
    }
    for (const p of byConfirm.get(j) ?? []) {
      if (p.type === 'high') { prevHigh = lastHigh; lastHigh = p; highBroken = false; }
      else { prevLow = lastLow; lastLow = p; lowBroken = false; }
    }
  }
  return out;
}
