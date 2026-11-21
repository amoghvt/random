/** Swing highs/lows (fractals) and liquidity pools. Both sides of the book are always reported. */
import type { StructureEvent } from '@desk/contracts';
import type { Pivot } from '../candles';
import { PARAMS, mkEvent, px, when, type TfContext } from '../core';

export function detectSwings(ctx: TfContext): StructureEvent[] {
  const out: StructureEvent[] = [];
  const ref = ctx.c[ctx.n - 1]?.t ?? 0;
  for (const p of ctx.pivots) {
    if (p.confirmedI < ctx.scanFrom) continue;
    const high = p.type === 'high';
    out.push(mkEvent(ctx, 'swing', p.confirmedI, {
      kind: high ? 'swing_high' : 'swing_low', level: p.level, bias: 0, confidence: 0.4, anchor: [p.t],
      text: `${ctx.instrument} ${ctx.tf} swing ${p.type} ${px(p.level)} at ${when(ctx.tf, p.t, ref)} ET.`,
      short: `${ctx.tf} swing ${p.type} ${px(p.level)}`,
      data: { pivotT: p.t },
    }));
  }
  return out;
}

interface Resting { level: number; levelLo: number; levelHi: number; touches: number; lastI: number; firstT: number; lastT: number }

/** Unswept resting levels on one side inside the scan window: single swings and pools of equal swings (within 0.1%). */
function resting(ctx: TfContext, type: Pivot['type']): Resting[] {
  const from = Math.max(0, ctx.scanFrom);
  const ps = ctx.pivots.filter((p) => p.type === type && p.i >= from).sort((a, b) => a.level - b.level);
  const groups: Pivot[][] = [];
  for (const p of ps) {
    const g = groups[groups.length - 1];
    if (g && p.level - g[0]!.level <= PARAMS.equalPct * g[0]!.level) g.push(p); else groups.push([p]);
  }
  const out: Resting[] = [];
  for (const g of groups) {
    const lo = g[0]!.level, hi = g[g.length - 1]!.level;
    const lastI = Math.max(...g.map((p) => p.i));
    let swept = false;
    for (let j = lastI + 1; j < ctx.n && !swept; j++) swept = type === 'high' ? ctx.c[j]!.h > hi : ctx.c[j]!.l < lo;
    if (swept) continue;
    out.push({ level: type === 'high' ? hi : lo, levelLo: lo, levelHi: hi, touches: g.length, lastI, firstT: Math.min(...g.map((p) => p.t)), lastT: Math.max(...g.map((p) => p.t)) });
  }
  return out;
}

export function detectLiquidity(ctx: TfContext): StructureEvent[] {
  if (ctx.n < 2 * PARAMS.fractalN + 1) return [];
  const out: StructureEvent[] = [];
  const last = ctx.n - 1, price = ctx.c[last]!.c, ref = ctx.c[last]!.t;
  const highs = resting(ctx, 'high'), lows = resting(ctx, 'low');
  for (const [side, list] of [['high', highs], ['low', lows]] as const) {
    for (const r of list) {
      if (r.touches < 2) continue;
      const idx = Math.min(last, r.lastI + PARAMS.fractalN);
      out.push(mkEvent(ctx, 'liquidity_pool', idx, {
        kind: side === 'high' ? 'equal_highs' : 'equal_lows', level: r.levelLo, levelHi: r.levelHi, bias: 0,
        confidence: Math.min(0.7, 0.5 + 0.05 * r.touches), anchor: [r.firstT, r.lastT, r.touches],
        text: `${ctx.instrument} ${ctx.tf} equal ${side}s ${px(r.levelLo)}-${px(r.levelHi)}, ${r.touches} touches since ${when(ctx.tf, r.firstT, ref)} ET. Resting ${side === 'high' ? 'buy' : 'sell'} stops, unswept.`,
        short: `${ctx.tf} equal ${side}s ${px(r.level)} unswept`,
        data: { touches: r.touches, side: side === 'high' ? 'buy' : 'sell' },
      }));
    }
  }
  // Nearest resting level each side of the last close. Reported together, always: the order of arrival decides, not the thesis.
  const above = highs.filter((r) => r.level > price).sort((a, b) => a.level - b.level)[0];
  const below = lows.filter((r) => r.level < price).sort((a, b) => b.level - a.level)[0];
  const dist = (lvl: number): number => ((lvl - price) / price) * 100;
  const describe = (r: Resting | undefined, name: string): string =>
    r ? `${name} ${px(r.level)} (${dist(r.level) >= 0 ? '+' : '-'}${Math.abs(dist(r.level)).toFixed(2)}%${r.touches > 1 ? `, ${r.touches} equal` : ''})` : `no ${name} inside ${ctx.n - ctx.scanFrom} candles`;
  const text = `${ctx.instrument} ${ctx.tf} ${px(price)}: ${describe(above, 'buy stops')}; ${describe(below, 'sell stops')}. Liquidity sits both sides.`;
  const both = { buySide: above?.level ?? null, sellSide: below?.level ?? null, buySideDistPct: above ? dist(above.level) : null, sellSideDistPct: below ? dist(below.level) : null, price };
  for (const [kind, r] of [['buy_side_liquidity', above], ['sell_side_liquidity', below]] as const) {
    out.push(mkEvent(ctx, 'liquidity_pool', r ? Math.min(last, r.lastI + PARAMS.fractalN) : last, {
      kind, level: r?.level ?? null, bias: 0, confidence: 0.5, anchor: [r ? r.lastT : 'none', r?.level ?? 0],
      text, short: `${describe(above, 'buy stops')}, ${describe(below, 'sell stops')}`,
      obsKey: `liquidity|${kind}|${ctx.tf}|${r?.level ?? 'none'}`,
      data: { ...both, touches: r?.touches ?? 0 },
    }));
  }
  return out;
}
