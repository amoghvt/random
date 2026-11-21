/** Divergence: NQ vs ES, NQ vs SOX (swing highs/lows that the peer does or does not confirm) and index vs 10Y. */
import { INSTRUMENTS, type Candle, type StructureEvent } from '@desk/contracts';
import { atr } from '../candles';
import { PARAMS, mkEvent, px, when, type TfContext } from '../core';

/** Peer extreme within two candles either side of `t`; null when the peer did not trade there. */
function peerExtreme(peer: Candle[], t: number, span: number, type: 'high' | 'low'): number | null {
  let v: number | null = null;
  for (const k of peer) {
    if (k.t < t - span) continue;
    if (k.t > t + span) break;
    v = v == null ? (type === 'high' ? k.h : k.l) : type === 'high' ? Math.max(v, k.h) : Math.min(v, k.l);
  }
  return v;
}

function swingDivergence(ctx: TfContext, sym: string, peer: Candle[]): StructureEvent[] {
  const out: StructureEvent[] = [];
  for (const type of ['high', 'low'] as const) {
    const ps = ctx.pivots.filter((p) => p.type === type);
    for (let x = 1; x < ps.length; x++) {
      const a = ps[x - 1]!, b = ps[x]!;
      if (b.confirmedI < ctx.scanFrom) continue;
      const span = PARAMS.fractalN * ctx.tfMs;
      const pa = peerExtreme(peer, a.t, span, type), pb = peerExtreme(peer, b.t, span, type);
      // The peer extreme near b must also be known by the time b is confirmed.
      if (pa == null || pb == null || b.level === a.level || pb === pa) continue;
      const mine = b.level > a.level ? 'higher' : 'lower', theirs = pb > pa ? 'higher' : 'lower';
      const agree = mine === theirs;
      const bias = agree ? (mine === 'higher' ? 1 : -1) : 0;
      const ref = ctx.c[b.confirmedI]!.t;
      out.push(mkEvent(ctx, 'divergence', b.confirmedI, {
        kind: agree ? `both_${mine}_${type}s` : `${type}s_diverge`, level: b.level, bias, confidence: agree ? 0.5 : 0.55,
        anchor: [sym, a.t, b.t], obsKey: `divergence|${ctx.tf}|${sym}|${type}|${agree ? mine : 'diverge'}`, severity: b.t,
        text: `${ctx.instrument} ${ctx.tf} ${mine} ${type} ${px(b.level)} at ${when(ctx.tf, b.t, ref)} ET vs ${px(a.level)}; ${sym} ${theirs} ${type} ${px(pb)} vs ${px(pa)}. ${agree ? (mine === 'lower' ? 'Both lower: broad weakness, not rotation.' : 'Both higher: broad strength.') : `${sym} does not confirm: rotation, not a broad move.`}`,
        short: agree ? `${sym} ${theirs} ${type}s too` : `${sym} ${theirs} ${type} while ${ctx.instrument} ${mine}`,
        data: { peer: sym, swing: type, instrumentMade: `${mine}_${type}`, peerMade: `${theirs}_${type}`, levels: [a.level, b.level], peerLevels: [pa, pb], agree },
      }));
    }
  }
  return out;
}

/** Index and yield moving the same way by 3 ATR each over the window: the index move is running against rates. */
function ratesDivergence(ctx: TfContext, sym: string, peer: Candle[]): StructureEvent[] {
  const last = ctx.n - 1, back = last - PARAMS.divergenceWindow;
  const a = ctx.atr[last];
  if (back < 0 || a == null) return [];
  const pAtr = atr(peer, PARAMS.atrPeriod);
  const at = (t: number): number => {
    let i = -1;
    for (let k = 0; k < peer.length && peer[k]!.t <= t; k++) i = k;
    return i;
  };
  const i1 = at(ctx.c[last]!.t), i0 = at(ctx.c[back]!.t);
  const stale = 4 * ctx.tfMs;
  if (i1 < 0 || i0 < 0 || i1 === i0 || pAtr[i1] == null) return [];
  if (ctx.c[last]!.t - peer[i1]!.t > stale || ctx.c[back]!.t - peer[i0]!.t > stale) return [];
  const dI = ctx.c[last]!.c - ctx.c[back]!.c, dY = peer[i1]!.c - peer[i0]!.c;
  if (Math.abs(dI) < PARAMS.impulseAtr * a || Math.abs(dY) < PARAMS.impulseAtr * pAtr[i1]! || Math.sign(dI) !== Math.sign(dY)) return [];
  const up = dI > 0;
  const day = new Date(ctx.c[last]!.t).toISOString().slice(0, 10);
  return [mkEvent(ctx, 'divergence', last, {
    kind: up ? 'index_up_yields_up' : 'index_down_yields_down', level: ctx.c[last]!.c, bias: up ? -1 : 1, confidence: 0.5,
    anchor: [sym, day], obsKey: `divergence|${ctx.tf}|${sym}|rates|${up ? 'up' : 'down'}|${day}`,
    text: `${ctx.instrument} ${ctx.tf} ${up ? '+' : '-'}${px(Math.abs(dI))} pts over ${PARAMS.divergenceWindow} candles while ${sym} moved ${dY > 0 ? '+' : '-'}${(Math.abs(dY) * 100).toFixed(1)} bp to ${peer[i1]!.c.toFixed(3)}. ${up ? 'Rally against rising yields.' : 'Selling into falling yields: not a rates move.'}`,
    short: `${sym} ${dY > 0 ? '+' : '-'}${(Math.abs(dY) * 100).toFixed(1)} bp with the index ${up ? 'up' : 'down'}`,
    data: { peer: sym, indexMovePts: dI, yieldMove: dY, yieldLevel: peer[i1]!.c, windowCandles: PARAMS.divergenceWindow },
  })];
}

/** `peer` must be closed candles on the same timeframe as `ctx`. */
export function detectDivergence(ctx: TfContext, sym: string, peer: Candle[]): StructureEvent[] {
  if (!peer.length) return [];
  return INSTRUMENTS[sym]?.kind === 'rate' ? ratesDivergence(ctx, sym, peer) : swingDivergence(ctx, sym, peer);
}
