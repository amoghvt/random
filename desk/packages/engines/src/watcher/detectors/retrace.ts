/** Retrace quality: the counter-move as a fraction of the prior leg. A bounce that puts in a lower high under 50% has stalled (bear flag); mirrored for dips. */
import type { StructureEvent } from '@desk/contracts';
import { meanVolume, type Leg, type Pivot } from '../candles';
import { PARAMS, mkEvent, pct, px, when, type TfContext } from '../core';

export interface RetraceObs {
  leg: Leg; kind: 'stalled' | 'through_50';
  /** Candle whose close confirms the observation. */
  idx: number;
  /** Retrace extreme and its fraction of the leg. */
  extreme: number; fraction: number; pivot?: Pivot;
  /** How many times the retrace has stalled under 50% on this leg, this one included. */
  stallCount: number; half: number;
}

/**
 * For every impulse leg (>= 3 ATR between alternating fractals), follow the counter-move:
 *  - 'stalled': a fractal forms against the leg, it is the furthest the retrace has reached, and it is under 50% of the leg;
 *  - 'through_50': a candle closes beyond the 50% level.
 * The leg stops being tracked when price extends it, when the retrace closes through 50%, or after PARAMS.retraceWatch candles.
 */
export function retraceObservations(ctx: TfContext): RetraceObs[] {
  const out: RetraceObs[] = [];
  const { c, n } = ctx;
  for (const leg of ctx.legs) {
    if (leg.atrMult < PARAMS.impulseAtr || leg.to.i + PARAMS.retraceWatch < ctx.scanFrom) continue;
    const s = leg.dir === -1 ? 1 : -1; // direction of the retrace
    const end = leg.to.level;
    const half = end + s * PARAMS.retraceMax * leg.size;
    const known = leg.to.confirmedI;
    let reach = end, stallCount = 0;
    for (let j = leg.to.i + 1; j < Math.min(n, leg.to.i + 1 + PARAMS.retraceWatch); j++) {
      const k = c[j]!;
      if (s === 1 ? k.l < end : k.h > end) break;
      reach = s === 1 ? Math.max(reach, k.h) : Math.min(reach, k.l);
      const p = ctx.pivotAt(s === 1 ? 'high' : 'low', j - PARAMS.fractalN);
      if (p && p.i > leg.to.i && p.level === reach) {
        const fraction = Math.abs(p.level - end) / leg.size;
        if (fraction < PARAMS.retraceMax) {
          stallCount++;
          out.push({ leg, kind: 'stalled', idx: j, extreme: p.level, fraction, pivot: p, stallCount, half });
        }
      }
      if (s * (k.c - half) > 0) {
        const idx = Math.max(j, known);
        if (idx < n) out.push({ leg, kind: 'through_50', idx, extreme: reach, fraction: Math.abs(reach - end) / leg.size, stallCount, half });
        break;
      }
    }
  }
  return out.filter((o) => o.idx >= ctx.scanFrom);
}

export function detectRetrace(ctx: TfContext): StructureEvent[] {
  return retraceObservations(ctx).map((o) => {
    const { leg } = o;
    const down = leg.dir === -1;
    const ref = ctx.c[o.idx]!.t;
    const legName = `${when(ctx.tf, leg.from.t, ref)} ${down ? 'drop' : 'rally'}`;
    const span = `${px(leg.from.level)} to ${px(leg.to.level)}`;
    const impulse = meanVolume(ctx.c, leg.from.i + 1, leg.to.i);
    const retrace = o.pivot ? meanVolume(ctx.c, leg.to.i + 1, o.pivot.i) : meanVolume(ctx.c, leg.to.i + 1, o.idx);
    const volPct = impulse.mean && retrace.mean ? retrace.mean / impulse.mean : null;
    const data = {
      legFromT: leg.from.t, legToT: leg.to.t, legFrom: leg.from.level, legTo: leg.to.level, legPts: leg.size, legAtr: leg.atrMult,
      retraceExtreme: o.extreme, retracePct: o.fraction * 100, halfLevel: o.half, stallCount: o.stallCount,
      retraceVolumePctOfImpulse: volPct == null ? null : volPct * 100, direction: down ? 'bounce' : 'dip',
    };
    const legKey = `${ctx.tf}|${leg.from.t}|${leg.to.t}`;
    if (o.kind === 'stalled') {
      return mkEvent(ctx, 'retrace_quality', o.idx, {
        kind: down ? 'bounce_stalled_under_50' : 'dip_stalled_under_50', level: o.extreme, levelHi: o.half, bias: down ? -1 : 1,
        confidence: 0.65, anchor: [leg.from.t, leg.to.t, o.pivot!.t], obsKey: `retrace_stalled|${legKey}`, severity: o.stallCount,
        text: `${ctx.instrument} ${ctx.tf} ${down ? 'bounce' : 'dip'} stalled at ${pct(o.fraction)} of the ${legName} (${span}): ${down ? 'lower high' : 'higher low'} ${px(o.extreme)} at ${when(ctx.tf, o.pivot!.t, ref)} ET, 50% is ${px(o.half)}. ${down ? 'Bounce stalled under 50%: bear flag' : 'Dip held above 50%: bull flag'} until ${px(o.half)} ${down ? 'is reclaimed' : 'gives way'}.`,
        short: `${ctx.tf} ${down ? 'bounce' : 'dip'} stalled at ${pct(o.fraction)} of the ${legName}, 50% is ${px(o.half)}`,
        data,
      });
    }
    return mkEvent(ctx, 'retrace_quality', o.idx, {
      kind: down ? 'bounce_through_50' : 'dip_through_50', level: o.half, bias: down ? 1 : -1, confidence: 0.55,
      anchor: [leg.from.t, leg.to.t], obsKey: `retrace_through|${legKey}`, severity: 1,
      text: `${ctx.instrument} ${ctx.tf} ${down ? 'bounce' : 'dip'} now ${pct(o.fraction)} of the ${legName} (${span}): closed ${px(ctx.c[o.idx]!.c)}, through the 50% level ${px(o.half)}. No longer a ${down ? 'bear' : 'bull'} flag.`,
      short: `${ctx.tf} ${down ? 'bounce' : 'dip'} now ${pct(o.fraction)} of the ${legName}`,
      data,
    });
  });
}
