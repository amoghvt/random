/** EMA posture (20/50/200) and first-touch behaviour: rejection vs. reclaim-and-hold. */
import type { StructureEvent } from '@desk/contracts';
import { PARAMS, mkEvent, px, when, type TfContext } from '../core';

const PERIODS = [20, 50, 200] as const;
type Stack = 'ema_stack_bull' | 'ema_stack_bear' | 'ema_mixed';

function stackAt(ctx: TfContext, i: number): Stack | null {
  const e20 = ctx.ema[20][i], e50 = ctx.ema[50][i], e200 = ctx.ema[200][i];
  if (e20 == null || e50 == null) return null;
  const p = ctx.c[i]!.c;
  // Without 200 candles of history the stack is judged on 20/50 and says so.
  if (p > e20 && e20 > e50 && (e200 == null || e50 > e200)) return 'ema_stack_bull';
  if (p < e20 && e20 < e50 && (e200 == null || e50 < e200)) return 'ema_stack_bear';
  return 'ema_mixed';
}

export function detectEmaPosture(ctx: TfContext): StructureEvent[] {
  const out: StructureEvent[] = [];
  const { c, n } = ctx;
  const last = n - 1;
  const state = last >= 0 ? stackAt(ctx, last) : null;
  if (state) {
    let start = last;
    while (start > 0 && stackAt(ctx, start - 1) === state) start--;
    const e20 = ctx.ema[20][last]!, e50 = ctx.ema[50][last]!, e200 = ctx.ema[200][last] ?? null;
    const back = ctx.ema[200][last - PARAMS.emaSlopeLookback] ?? null;
    const slope200 = e200 != null && back != null ? e200 - back : null;
    const where = state === 'ema_stack_bull' ? 'above' : state === 'ema_stack_bear' ? 'below' : 'between';
    out.push(mkEvent(ctx, 'ema_posture', start, {
      kind: state, level: e20, bias: state === 'ema_stack_bull' ? 1 : state === 'ema_stack_bear' ? -1 : 0, confidence: state === 'ema_mixed' ? 0.4 : 0.5,
      anchor: [c[start]!.t],
      text: `${ctx.instrument} ${ctx.tf} ${px(c[last]!.c)}: ${where} the 20/50/200 EMA (${px(e20)} / ${px(e50)} / ${e200 == null ? `needs 200 candles, have ${n}` : px(e200)})${state === 'ema_mixed' ? ', no stack' : `, stacked ${state === 'ema_stack_bull' ? 'bullish' : 'bearish'} since ${when(ctx.tf, c[start]!.t, c[last]!.t)} ET`}.${slope200 == null ? '' : ` 200 ${slope200 < 0 ? 'declining' : 'rising'}.`}`,
      short: `${ctx.tf} ${where} the 20/50/200 EMA`,
      data: { ema20: e20, ema50: e50, ema200: e200, slope200, since: c[start]!.t, asOfT: c[last]!.t, price: c[last]!.c },
    }));
  }
  for (const period of PERIODS) {
    const e = ctx.ema[period];
    for (let i = Math.max(PARAMS.emaAway, ctx.scanFrom - PARAMS.emaReclaimWithin - PARAMS.emaHold); i < n; i++) {
      if (e[i] == null || e[i - PARAMS.emaAway] == null) continue;
      for (const fromBelow of [true, false]) {
        const touched = fromBelow ? c[i]!.h >= e[i]! : c[i]!.l <= e[i]!;
        if (!touched) continue;
        let away = true;
        for (let j = i - PARAMS.emaAway; j < i && away; j++) away = fromBelow ? c[j]!.h < e[j]! : c[j]!.l > e[j]!;
        if (!away) continue;
        const back = e[i - PARAMS.emaSlopeLookback];
        const slope = back != null ? e[i]! - back : 0;
        const trend = slope < 0 ? 'declining' : 'rising';
        const beyond = (j: number): boolean => (fromBelow ? c[j]!.c > e[j]! : c[j]!.c < e[j]!);
        const run = (s: number, want: boolean): boolean => {
          for (let j = s; j < s + PARAMS.emaHold; j++) if (j >= n || beyond(j) !== want) return false;
          return true;
        };
        const common = { period, emaAtTouch: e[i]!, touchT: c[i]!.t, touchExtreme: fromBelow ? c[i]!.h : c[i]!.l, slope, declining: slope < 0, side: fromBelow ? 'from_below' : 'from_above' };
        const at = `${when(ctx.tf, c[i]!.t, c[n - 1]!.t)} ET`;
        // Three closes back on the original side: the first touch was rejected (or, from above, held as support).
        const rejI = i + PARAMS.emaHold - 1;
        if (run(i, false) && rejI >= ctx.scanFrom) {
          out.push(mkEvent(ctx, 'ema_posture', rejI, {
            kind: fromBelow ? 'first_touch_rejection' : 'first_touch_support', level: e[i]!, bias: fromBelow ? -1 : 1, confidence: period === 200 ? 0.6 : 0.5,
            anchor: [period, c[i]!.t], obsKey: `ema_touch|${ctx.tf}|${period}|${c[i]!.t}`, severity: 1,
            text: `${ctx.instrument} ${ctx.tf} first touch of the ${trend} ${period} EMA ${px(e[i]!)} at ${at}: ${fromBelow ? 'high' : 'low'} ${px(common.touchExtreme)}, ${PARAMS.emaHold} closes back ${fromBelow ? 'under' : 'over'}. First-touch ${fromBelow ? 'rejection' : 'support'}, not a trend change.`,
            short: `${ctx.tf} first touch of the ${trend} ${period} EMA ${px(e[i]!)} ${fromBelow ? 'rejected' : 'held'}`,
            data: common,
          }));
        }
        // Three consecutive closes through it, starting within five candles of the touch: reclaimed (or lost) and held.
        for (let s = i; s <= i + PARAMS.emaReclaimWithin && s + PARAMS.emaHold - 1 < n; s++) {
          if (!run(s, true)) continue;
          const holdI = s + PARAMS.emaHold - 1;
          if (holdI >= ctx.scanFrom) {
            out.push(mkEvent(ctx, 'ema_posture', holdI, {
              kind: fromBelow ? 'reclaim_and_hold' : 'lost_and_held_below', level: e[holdI]!, bias: fromBelow ? 1 : -1, confidence: period === 200 ? 0.6 : 0.5,
              anchor: [period, c[i]!.t], obsKey: `ema_touch|${ctx.tf}|${period}|${c[i]!.t}`, severity: 2,
              text: `${ctx.instrument} ${ctx.tf} ${fromBelow ? 'reclaimed' : 'lost'} the ${trend} ${period} EMA ${px(e[holdI]!)}: first touch ${at}, ${PARAMS.emaHold} straight closes ${fromBelow ? 'above' : 'below'}, last ${px(c[holdI]!.c)}. ${fromBelow ? 'Reclaim-and-hold' : 'Lost and held below'}.`,
              short: `${ctx.tf} ${fromBelow ? 'reclaimed' : 'lost'} the ${period} EMA ${px(e[holdI]!)}, ${PARAMS.emaHold} closes ${fromBelow ? 'above' : 'below'}`,
              data: { ...common, holdFromT: c[s]!.t },
            }));
          }
          break;
        }
      }
    }
  }
  return out;
}
