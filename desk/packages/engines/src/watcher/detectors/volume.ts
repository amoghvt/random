/**
 * Volume context: impulse volume vs. bounce volume, and squeeze candles.
 * A spike through a moving average that is rejected within a few candles is reported as
 * "spike, rejected, volume N% of the impulse". It is never reported as buying.
 */
import type { StructureEvent } from '@desk/contracts';
import { meanVolume, sessionOf, type Leg } from '../candles';
import { PARAMS, mkEvent, when, type TfContext } from '../core';
import { retraceObservations } from './retrace';

const PERIODS = [200, 50, 20] as const;

/** Most recent impulse leg in direction `dir` that ended at or before candle `before` and was confirmed by candle `knownBy`. */
function priorImpulse(ctx: TfContext, dir: 1 | -1, before: number, knownBy: number): Leg | undefined {
  let best: Leg | undefined;
  for (const leg of ctx.legs) {
    if (leg.dir !== dir || leg.atrMult < PARAMS.impulseAtr || leg.to.i > before || leg.to.confirmedI > knownBy) continue;
    if (!best || leg.to.i > best.to.i || (leg.to.i === best.to.i && leg.size > best.size)) best = leg;
  }
  return best;
}

export function detectSpikes(ctx: TfContext): StructureEvent[] {
  const out: StructureEvent[] = [];
  const { c, n } = ctx;
  for (let i = Math.max(1, ctx.scanFrom - PARAMS.rejectWithin); i < n; i++) {
    for (const up of [true, false]) {
      const ext = up ? c[i]!.h : c[i]!.l;
      // Smallest run (1 to 3 candles) from a base close to this extreme that covers 3 ATR.
      let k = 0, move = 0;
      for (let len = 1; len <= PARAMS.spikeMaxCandles && i - len >= 0; len++) {
        const a = ctx.atr[i - len];
        const isExtreme = up ? c[i - len + 1]!.h <= ext : c[i - len + 1]!.l >= ext;
        if (!isExtreme) break;
        const m = up ? ext - c[i - len]!.c : c[i - len]!.c - ext;
        if (a != null && a > 0 && m >= PARAMS.impulseAtr * a) { k = len; move = m; break; }
      }
      if (!k) continue;
      const base = i - k;
      const pierced = PERIODS.filter((p) => {
        const eb = ctx.ema[p][base], ei = ctx.ema[p][i];
        return eb != null && ei != null && (up ? c[base]!.c < eb && ext > ei : c[base]!.c > eb && ext < ei);
      });
      if (!pierced.length) continue;
      // Rejected: within a few candles a close is back through a pierced EMA, or has given back half the spike.
      let rej = -1, via: 'ema' | 'giveback' = 'giveback', viaPeriod: number | null = null;
      for (let j = i; j <= Math.min(n - 1, i + PARAMS.rejectWithin); j++) {
        if (j > i && (up ? c[j]!.h > ext : c[j]!.l < ext)) break;
        const p = pierced.find((q) => (up ? c[j]!.c < ctx.ema[q][j]! : c[j]!.c > ctx.ema[q][j]!));
        const gave = up ? c[j]!.c <= ext - PARAMS.rejectGiveback * move : c[j]!.c >= ext + PARAMS.rejectGiveback * move;
        if (p !== undefined || gave) { rej = j; via = p !== undefined ? 'ema' : 'giveback'; viaPeriod = p ?? null; break; }
      }
      if (rej < 0 || rej < ctx.scanFrom) continue;
      const spikeVol = meanVolume(c, base + 1, i);
      const leg = priorImpulse(ctx, up ? -1 : 1, base, rej);
      const impVol = leg ? meanVolume(c, leg.from.i + 1, leg.to.i) : null;
      const ratio = spikeVol.mean != null && impVol?.mean != null ? spikeVol.mean / impVol.mean : null;
      const suffix = ratio == null ? '_volume_unknown' : ratio < 1 ? '' : '_volume_at_impulse';
      const ema = pierced[0]!;
      const within = rej - i;
      const impName = leg ? `${when(ctx.tf, leg.from.t, c[rej]!.t)} impulse` : 'impulse';
      const volText = ratio == null
        ? (spikeVol.mean == null ? 'volume not reported for the spike candles' : 'no prior impulse in view to compare volume')
        : `volume ${Math.round(ratio * 100)}% of the ${impName}`;
      const crossSession = leg ? sessionOf(leg.to.t) !== sessionOf(c[i]!.t) : false;
      const pts = `${up ? '+' : '-'}${ctx.px(move)} pts`;
      out.push(mkEvent(ctx, 'volume_context', rej, {
        kind: `${up ? 'spike_rejected' : 'flush_reclaimed'}${suffix}`, level: ext, bias: ratio != null && ratio < 1 ? (up ? -1 : 1) : 0,
        confidence: ratio == null ? 0.55 : ratio < 1 ? 0.7 : 0.55, anchor: [c[i]!.t], obsKey: `spike|${ctx.tf}|${c[i]!.t}`, severity: 1,
        text: `${ctx.instrument} ${ctx.tf} ${pts} to ${ctx.px(ext)} at ${when(ctx.tf, c[i]!.t, c[rej]!.t)} ET through the ${ema} EMA (${ctx.px(ctx.ema[ema][i]!)}), ${up ? 'rejected' : 'reclaimed'} ${within === 0 ? 'inside the same candle' : `within ${within} candle${within > 1 ? 's' : ''}`}: close ${ctx.px(c[rej]!.c)}. ${up ? 'Spike' : 'Flush'}, ${up ? 'rejected' : 'reclaimed'}, ${volText}${crossSession ? ' (different session: overnight volume runs lighter)' : ''}.${up && ratio != null && ratio < 1 ? ' Covering, not accumulation.' : ''}`,
        short: `${ctx.tf} ${up ? 'spike' : 'flush'} ${pts} to ${ctx.px(ext)}, ${up ? 'rejected' : 'reclaimed'}, ${volText}`,
        data: {
          direction: up ? 'up' : 'down', points: move, extreme: ext, extremeT: c[i]!.t, baseClose: c[base]!.c, runCandles: k,
          emaPierced: pierced, emaLevel: ctx.ema[ema][i], rejectedVia: via, rejectedViaEma: viaPeriod, rejectedWithinCandles: within,
          rejectedWithinMin: ((c[rej]!.t + ctx.tfMs) - c[i]!.t) / 60_000, rejectionClose: c[rej]!.c,
          volumePctOfImpulse: ratio == null ? null : ratio * 100, spikeVolPerCandle: spikeVol.mean, impulseVolPerCandle: impVol?.mean ?? null,
          zeroVolumeCandles: spikeVol.zero, impulseLabel: leg ? when(ctx.tf, leg.from.t, c[rej]!.t) : null, impulseFromT: leg?.from.t ?? null, impulseToT: leg?.to.t ?? null, impulsePts: leg?.size ?? null, crossSession,
        },
      }));
    }
  }
  return out;
}

/** Bounce (or dip) volume against the impulse it retraces, stated when the retrace first stalls under 50%. */
export function detectRetraceVolume(ctx: TfContext): StructureEvent[] {
  const out: StructureEvent[] = [];
  for (const o of retraceObservations(ctx)) {
    if (o.kind !== 'stalled' || o.stallCount !== 1 || !o.pivot) continue;
    const { leg } = o;
    const imp = meanVolume(ctx.c, leg.from.i + 1, leg.to.i), ret = meanVolume(ctx.c, leg.to.i + 1, o.pivot.i);
    if (imp.mean == null || ret.mean == null) continue;
    const ratio = ret.mean / imp.mean;
    const down = leg.dir === -1;
    const name = down ? 'bounce' : 'dip';
    out.push(mkEvent(ctx, 'volume_context', o.idx, {
      kind: `${name}_volume_${ratio < 1 ? 'below' : 'above'}_impulse`, level: o.extreme, bias: ratio < 1 ? (down ? -1 : 1) : 0, confidence: 0.5,
      anchor: [leg.from.t, leg.to.t], obsKey: `retrace_volume|${ctx.tf}|${leg.from.t}|${leg.to.t}`,
      text: `${ctx.instrument} ${ctx.tf} ${name} volume ${Math.round(ratio * 100)}% of the ${when(ctx.tf, leg.from.t, ctx.c[o.idx]!.t)} ${down ? 'drop' : 'rally'} per candle (${Math.round(ret.mean)} vs ${Math.round(imp.mean)}). ${ratio < 1 ? (down ? 'Covering, not accumulation.' : 'Profit-taking, not distribution.') : 'Volume matches the impulse.'}`,
      short: `${ctx.tf} ${name} volume ${Math.round(ratio * 100)}% of the impulse`,
      data: { volumePctOfImpulse: ratio * 100, retraceVolPerCandle: ret.mean, impulseVolPerCandle: imp.mean, legFromT: leg.from.t, legToT: leg.to.t, zeroVolumeCandles: imp.zero + ret.zero },
    }));
  }
  return out;
}
