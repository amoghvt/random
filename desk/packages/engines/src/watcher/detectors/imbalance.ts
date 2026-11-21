/** Fair value gaps (three-candle imbalance) and order blocks (last opposing candle before an impulse), with fill/mitigation state. */
import type { StructureEvent } from '@desk/contracts';
import { PARAMS, mkEvent, when, type TfContext } from '../core';

export function detectFvgs(ctx: TfContext): StructureEvent[] {
  const out: StructureEvent[] = [];
  const { c, n } = ctx;
  for (let i = Math.max(1, ctx.scanFrom); i < n - 1; i++) {
    const a = ctx.atr[i];
    if (a == null) continue;
    const bull = c[i + 1]!.l > c[i - 1]!.h, bear = c[i + 1]!.h < c[i - 1]!.l;
    if (!bull && !bear) continue;
    const lo = bull ? c[i - 1]!.h : c[i + 1]!.h, hi = bull ? c[i + 1]!.l : c[i - 1]!.l;
    if (hi - lo < PARAMS.fvgMinAtr * a) continue;
    // State: open until price trades into the gap (mitigated) or through it (filled).
    let state: 'open' | 'mitigated' | 'filled' = 'open', at = i + 1, depth = 0;
    for (let j = i + 2; j < n; j++) {
      const into = bull ? hi - c[j]!.l : c[j]!.h - lo;
      if (into <= depth) continue;
      depth = into;
      if (state === 'open') { state = 'mitigated'; at = j; }
      if (depth >= hi - lo) { state = 'filled'; at = j; break; }
    }
    const filledPct = Math.min(1, depth / (hi - lo));
    const dir = bull ? 'bull' : 'bear';
    out.push(mkEvent(ctx, 'fvg', at, {
      kind: `fvg_${dir}_${state}`, level: lo, levelHi: hi, bias: state === 'filled' ? 0 : bull ? 1 : -1,
      confidence: state === 'filled' ? 0.4 : Math.min(0.6, 0.45 + 0.05 * ((hi - lo) / a)), anchor: [c[i]!.t],
      obsKey: `fvg|${ctx.tf}|${c[i]!.t}`, severity: state === 'open' ? 1 : state === 'mitigated' ? 2 : 3,
      text: `${ctx.instrument} ${ctx.tf} ${bull ? 'bullish' : 'bearish'} FVG ${ctx.px(lo)}-${ctx.px(hi)} (${ctx.px(hi - lo)} pts) from ${when(ctx.tf, c[i]!.t, c[n - 1]!.t)} ET: ${state === 'open' ? 'open, untested' : state === 'mitigated' ? `${Math.round(filledPct * 100)}% filled` : 'filled'}.`,
      short: `${ctx.tf} ${dir} FVG ${ctx.px(lo)}-${ctx.px(hi)} ${state}`,
      data: { direction: dir, state, formedT: c[i]!.t, sizePts: hi - lo, sizeAtr: (hi - lo) / a, filledPct },
    }));
  }
  return out;
}

export interface Impulse { start: number; end: number; dir: 1 | -1; net: number; atrMult: number }

/** Impulse: a run of same-direction closes covering at least 3 ATR at an average of at least 1 ATR per candle. */
export function findImpulses(ctx: TfContext, from = 1): Impulse[] {
  const out: Impulse[] = [];
  const { c, n } = ctx;
  let i = Math.max(1, from);
  while (i < n) {
    const dir = Math.sign(c[i]!.c - c[i - 1]!.c);
    if (dir === 0) { i++; continue; }
    let end = i;
    while (end + 1 < n && Math.sign(c[end + 1]!.c - c[end]!.c) === dir) end++;
    const a = ctx.atr[i - 1];
    const net = Math.abs(c[end]!.c - c[i - 1]!.c);
    if (a != null && a > 0 && net >= PARAMS.impulseAtr * a && net / (end - i + 1) >= a) out.push({ start: i, end, dir: dir as 1 | -1, net, atrMult: net / a });
    i = end + 1;
  }
  return out;
}

export function detectOrderBlocks(ctx: TfContext): StructureEvent[] {
  const out: StructureEvent[] = [];
  const { c, n } = ctx;
  for (const imp of findImpulses(ctx, Math.max(1, ctx.scanFrom - PARAMS.obLookback))) {
    if (imp.end < ctx.scanFrom) continue;
    const bull = imp.dir === 1;
    let b = -1;
    for (let k = imp.start - 1; k >= Math.max(0, imp.start - PARAMS.obLookback); k--) {
      if (bull ? c[k]!.c < c[k]!.o : c[k]!.c > c[k]!.o) { b = k; break; }
    }
    if (b < 0) continue;
    const lo = c[b]!.l, hi = c[b]!.h;
    let state: 'fresh' | 'mitigated' | 'invalidated' = 'fresh', at = imp.end;
    for (let j = imp.end + 1; j < n; j++) {
      if (bull ? c[j]!.c < lo : c[j]!.c > hi) { state = 'invalidated'; at = j; break; }
      if (state === 'fresh' && (bull ? c[j]!.l <= hi : c[j]!.h >= lo)) { state = 'mitigated'; at = j; }
    }
    const dir = bull ? 'bull' : 'bear';
    out.push(mkEvent(ctx, 'order_block', at, {
      kind: `ob_${dir}_${state}`, level: lo, levelHi: hi, bias: state === 'invalidated' ? 0 : bull ? 1 : -1,
      confidence: state === 'invalidated' ? 0.4 : 0.5, anchor: [c[b]!.t],
      obsKey: `ob|${ctx.tf}|${c[b]!.t}`, severity: state === 'fresh' ? 1 : state === 'mitigated' ? 2 : 3,
      text: `${ctx.instrument} ${ctx.tf} ${bull ? 'bullish' : 'bearish'} order block ${ctx.px(lo)}-${ctx.px(hi)}: last ${bull ? 'down' : 'up'} candle (${when(ctx.tf, c[b]!.t, c[n - 1]!.t)} ET) before a ${ctx.px(imp.net)}-pt, ${imp.atrMult.toFixed(1)} ATR impulse. ${state === 'fresh' ? 'Untested.' : state === 'mitigated' ? 'Retested, holding.' : `Invalidated by a close ${bull ? 'below' : 'above'} it.`}`,
      short: `${ctx.tf} ${dir} order block ${ctx.px(lo)}-${ctx.px(hi)} ${state}`,
      data: { direction: dir, state, blockT: c[b]!.t, impulsePts: imp.net, impulseAtr: imp.atrMult },
    }));
  }
  return out;
}
