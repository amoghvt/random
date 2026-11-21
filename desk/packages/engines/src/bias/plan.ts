/** The trade, the kill condition and the expiry. Levels come from the watcher's events and ATR, never from "now". */
import { MIN, iso, round, type BiasCall, type Horizon, type TradePlan } from '@desk/contracts';
import { cashClose, etStamp, horizonEnd, sessionDay } from './calendar';
import { levelsAround, px, type CatalystState } from './factors';
import type { BiasInputs } from './types';

const BAR: Record<Horizon, string> = { intraday: '15m', swing: '1h', position: 'daily' };
export const TARGET_FRACTIONS: [number, number, number] = [0.5, 0.3, 0.2];

/** The ATR unit levels are spaced in: 1h ATR intraday, daily ATR for swing, 2x daily ATR for position. */
export function atrUnit(inp: BiasInputs): { unit: number; label: string } | null {
  const { atrM15, atrH1, atrD1 } = inp.levels;
  const pick = (opts: Array<[number | null, number, string]>): { unit: number; label: string } | null => {
    for (const [v, k, label] of opts) if (v != null && v > 0) return { unit: v * k, label };
    return null;
  };
  if (inp.horizon === 'intraday') return pick([[atrH1, 1, '1h ATR'], [atrM15, 2, '2x 15m ATR'], [atrD1, 0.25, 'quarter daily ATR']]);
  if (inp.horizon === 'swing') return pick([[atrD1, 1, 'daily ATR'], [atrH1, 4, '4x 1h ATR']]);
  return pick([[atrD1, 2, '2x daily ATR'], [atrH1, 8, '8x 1h ATR']]);
}

/** Flat 15 minutes before the cash close (intraday) or at the horizon end, and always before the next Tier-1 catalyst. */
export function timeStop(inp: BiasInputs, st: CatalystState, now: number): TradePlan['timeStop'] {
  const close = cashClose(sessionDay(now));
  let at = inp.horizon === 'intraday' ? (close - 15 * MIN > now ? close - 15 * MIN : close) : horizonEnd(now, inp.horizon);
  let text = `flat by ${etStamp(at)}`;
  const t1 = st.nextTier1 ? Date.parse(st.nextTier1.scheduledAt) : null;
  if (t1 != null && t1 - 15 * MIN > now && t1 - 15 * MIN < at) { at = t1 - 15 * MIN; text = `flat by ${etStamp(at)}, before ${st.nextTier1!.name}`; }
  return { at: iso(at), text };
}

/**
 * Entry: a close through the nearest level inside 0.75 ATR units in the call's direction, otherwise a pullback of
 * 0.25 units that holds. Invalidation: 0.1 units beyond the nearest level 0.4 to 2 units behind the entry,
 * otherwise 1 unit. Targets: 1R, 2R, 3R, each snapped to a known level within 0.3R; scale out 50/30/20.
 */
export function buildTrade(inp: BiasInputs, dir: 1 | -1, st: CatalystState, now: number): TradePlan | null {
  const u = atrUnit(inp);
  const price = inp.levels.price, tick = inp.levels.tick > 0 ? inp.levels.tick : 0.01;
  if (!u || !(price > 0)) return null;
  const U = u.unit, bar = BAR[inp.horizon];
  const snap = (x: number): number => round(Math.round(x / tick) * tick, 6);
  const { above, below } = levelsAround(inp);
  const ahead = dir === 1 ? above : below, behind = dir === 1 ? below : above;
  const beyond = dir === 1 ? 'above' : 'below', against = dir === 1 ? 'below' : 'above';
  const trigger = ahead.find((l) => Math.abs(l - price) >= 0.05 * U && Math.abs(l - price) <= 0.75 * U);
  const entryPx = snap(trigger ?? price - dir * 0.25 * U);
  const entryText = trigger != null
    ? `${bar} close ${beyond} ${px(entryPx)}`
    : `${dir === 1 ? 'pullback' : 'bounce'} to ${px(entryPx)} that holds: ${bar} close back ${beyond} it`;
  const support = behind.find((l) => (entryPx - l) * dir >= 0.4 * U && (entryPx - l) * dir <= 2 * U);
  const invPx = snap(support != null ? support - dir * 0.1 * U : entryPx - dir * U);
  const R = Math.abs(entryPx - invPx);
  if (!(R > 0) || invPx <= 0) return null;
  const targets: number[] = [];
  for (const k of [1, 2, 3]) {
    const nominal = entryPx + dir * k * R, last = targets.at(-1) ?? entryPx;
    const near = ahead.find((l) => Math.abs(l - nominal) <= 0.3 * R && (l - last) * dir > 0.2 * R);
    targets.push(snap(near ?? nominal));
  }
  if (targets.some((t) => t <= 0)) return null;
  return {
    instrument: inp.instrument, direction: dir === 1 ? 'long' : 'short',
    entry: { kind: 'price', text: entryText, price: entryPx },
    referencePrice: price,
    targets: [0, 1, 2].map((i) => ({ price: targets[i]!, fraction: TARGET_FRACTIONS[i]! })) as TradePlan['targets'],
    invalidation: {
      price: invPx,
      reason: support != null ? `trade ${against} ${px(invPx)}: 0.1 of the ${u.label} beyond the ${px(support)} level` : `trade ${against} ${px(invPx)}: one ${u.label} (${px(U)}) against the entry`,
    },
    timeStop: timeStop(inp, st, now),
  };
}

/** The resolved branch's own plan when it points the same way, is for this instrument and its time stop is still ahead. */
export function branchTrade(inp: BiasInputs, dir: 1 | -1, st: CatalystState, now: number): TradePlan | null {
  const t = st.resolved?.branch?.trade;
  if (!t || (t.direction === 'long' ? 1 : -1) !== dir) return null;
  if (t.instrument !== inp.instrument && t.instrument !== inp.priceSymbol) return null;
  if (t.timeStop.at && Date.parse(t.timeStop.at) <= now) return null;
  return t;
}

export function killForTrade(inp: BiasInputs, trade: TradePlan): BiasCall['killCondition'] {
  const side = trade.direction === 'long' ? 'below' : 'above';
  return { text: `${inp.instrument} ${side} ${px(trade.invalidation.price)} flips it.`, level: trade.invalidation.price, side };
}

/** No edge: the fact that would create one. The nearer known level carries the level and side. */
export function creatorOfEdge(inp: BiasInputs, st: CatalystState): { text: string; kill: BiasCall['killCondition'] } {
  const { above, below } = levelsAround(inp), price = inp.levels.price;
  const up = above[0], dn = below[0];
  const parts: string[] = [];
  if (st.next) parts.push(`${st.next.name} ${etStamp(st.next.scheduledAt)}`);
  if (up != null && dn != null) parts.push(`a break of ${px(up)} or ${px(dn)}`);
  else if (up != null) parts.push(`a break above ${px(up)}`);
  else if (dn != null) parts.push(`a break below ${px(dn)}`);
  if (parts.length === 0) parts.push('a watcher signal (MSS or sweep and reclaim) or a scheduled catalyst');
  const text = `What creates one: ${parts.join(', or ')}.`;
  const nearUp = up != null && (dn == null || up - price <= price - dn);
  if (up == null && dn == null) return { text, kill: { text } };
  return { text, kill: nearUp ? { text, level: up, side: 'above' } : { text, level: dn, side: 'below' } };
}

/** The earlier of the horizon end, the next Tier-1 catalyst and the trade's time stop; always after `now`. */
export function expiryFor(inp: BiasInputs, st: CatalystState, trade: TradePlan | null, now: number): number {
  const cands = [horizonEnd(now, inp.horizon), st.nextTier1 ? Date.parse(st.nextTier1.scheduledAt) : null, trade?.timeStop.at ? Date.parse(trade.timeStop.at) : null];
  return Math.min(...cands.filter((t): t is number => t != null && t > now));
}
