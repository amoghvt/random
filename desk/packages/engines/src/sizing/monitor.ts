/** Position monitor: live distance to the fail price and Safe / Thin / Critical (spec section 7). Pure. */
import { DAY, fmtNum, hhmm, instrument, iso, ms, pnlUsd, type AccountRules, type Catalyst, type Position, type PositionStatus, type PositionStatusLabel } from '@desk/contracts';
import { accountRoom, type AccountStateInput } from './room';
import { durationLabel, nextFlatten, nextSnapshot, weekendLockAt } from './session';
import { ATR_LOOKBACK, atr, worstPlausibleMove, type CandleSet } from './worst';

/**
 * Critical when the fail price is within this many 1-minute ATRs. 1.0 is the spec's "a one-ATR move ends the account";
 * 1.5 is the thin-fail-price guardrail threshold, and it maps to Critical too, so the wider one is the line.
 */
export const CRITICAL_ATR_MULT = 1.5;

export interface MonitorInput {
  position: Position; rules: AccountRules;
  /** Account state with this position's open P&L already in `equity`. */
  state: AccountStateInput;
  mark: number; now: number;
  /** The ticket's time stop; defaults to the next lock, snapshot or flatten, else 24h. */
  holdUntil?: number | null;
  catalysts: Catalyst[];
  candles: CandleSet;
  /** 1-minute ATR (ATR14, mean true range). Omit to compute it from candles.m1. */
  atr1m?: number | null;
}
export interface MonitorResult extends PositionStatus {
  failBasis: 'account_room' | 'venue_liquidation' | 'unverified';
  worstRemainingPct: number | null;
}

export function monitorPosition(input: MonitorInput): MonitorResult {
  const { position: pos, rules, state, mark, now } = input;
  const spec = instrument(pos.instrument);
  const long = pos.direction === 'long';
  const a = input.atr1m !== undefined ? input.atr1m : atr(input.candles.m1, ATR_LOOKBACK, now)?.value ?? null;
  const room = accountRoom(rules, state, now);

  // Fail price: where the account room runs out at this size, or the venue liquidation price when that is nearer.
  const roomDist = room.unverified.length > 0 || pos.units <= 0 ? null
    : spec.pointValue > 0 ? room.rawUsd / (pos.units * spec.pointValue) : (room.rawUsd / pos.units) * pos.entryPrice;
  const liqDist = pos.liquidationPrice === null ? null : Math.max(0, long ? mark - pos.liquidationPrice : pos.liquidationPrice - mark);
  let distancePts: number, failBasis: MonitorResult['failBasis'];
  if (roomDist !== null && (liqDist === null || roomDist <= liqDist)) { distancePts = roomDist; failBasis = 'account_room'; }
  else if (liqDist !== null) { distancePts = liqDist; failBasis = 'venue_liquidation'; }
  else { distancePts = 0; failBasis = 'unverified'; }
  const failPrice = long ? mark - distancePts : mark + distancePts;
  const distancePct = (distancePts / mark) * 100;

  // Next clock on the account.
  const lock = weekendLockAt(rules, pos.instrument, now);
  const clocks: Array<{ what: string; at: number }> = [];
  const snap = nextSnapshot(rules, now);
  if (snap !== null) clocks.push({ what: `Daily-loss snapshot ${rules.dailyLoss?.snapshotET} ET`, at: snap });
  if (lock && !lock.inside) clocks.push({ what: `${rules.firm} weekend lock`, at: lock.from });
  if (lock?.inside) clocks.push({ what: `${rules.firm} weekend lock lifts`, at: lock.to });
  const flat = nextFlatten(rules, now);
  if (flat !== null) clocks.push({ what: `Flatten by ${rules.session.flattenByET} ET`, at: flat });
  const next = clocks.sort((x, y) => x.at - y.at)[0] ?? null;

  const end = input.holdUntil ?? next?.at ?? now + DAY;
  const under = spec.priceSymbol;
  const cat = input.catalysts
    .filter((c) => c.status !== 'resolved' && ms(c.scheduledAt) > now && ms(c.scheduledAt) <= end)
    .filter((c) => (c.code !== 'EARNINGS' && c.code !== 'IPO') || c.symbol === pos.instrument || c.instruments.some((s) => s === pos.instrument || s === under))
    .sort((x, y) => x.tier - y.tier || ms(x.scheduledAt) - ms(y.scheduledAt))[0] ?? null;

  const worst = worstPlausibleMove({ instrument: pos.instrument, price: mark, entryAt: now, holdUntil: Math.max(end, now + 60_000), now, catalysts: input.catalysts, candles: input.candles, rules });
  const worstPct = Number.isNaN(worst.pct) ? null : worst.pct;
  let status: PositionStatusLabel;
  if (failBasis === 'unverified' || distancePts <= 0 || (a !== null && distancePts <= CRITICAL_ATR_MULT * a)) status = 'Critical';
  else if (worstPct === null || distancePct <= worstPct) status = 'Thin';
  else status = 'Safe';

  const left = durationLabel(end - now);
  const head = `${pos.instrument} ${pos.direction} on ${rules.name}: fail ${fmtNum(failPrice, failPrice < 1000 ? 2 : 0)}, ${fmtNum(distancePts, distancePts < 10 ? 1 : 0)} pts (${distancePct.toFixed(2)}%) away`;
  const basis = failBasis === 'venue_liquidation' ? 'venue liquidation' : failBasis === 'account_room' ? `${room.binding === 'daily_limit' ? 'daily loss limit' : 'drawdown floor'}` : 'rule unverified';
  const atrText = a === null ? 'no 1m ATR on file' : `1m ATR ${fmtNum(a, 1)}`;
  let verdict: string;
  if (failBasis === 'unverified') verdict = `Critical: no fail price until this is confirmed: ${room.unverified.join('; ')}.`;
  else if (status === 'Critical') verdict = a !== null && a > 0 ? `Critical: ${(distancePts / a).toFixed(1)} ATR ends it. Cut size or close.` : 'Critical: at the fail price. Close.';
  else if (status === 'Thin') verdict = worstPct === null ? 'Thin: worst move not measured, no candles on file.' : `Thin: inside the ${worstPct.toFixed(2)}% worst case for the next ${left}.`;
  else verdict = `Safe: worst case for the next ${left} is ${(worstPct ?? 0).toFixed(2)}%.`;
  const parts = [`${head} (${basis}); ${atrText}.`, verdict];
  if (cat) {
    const reaches = cat.impliedMovePct !== null && cat.impliedMovePct >= distancePct;
    parts.push(`${cat.name} ${hhmm(ms(cat.scheduledAt))} ET is inside the window${cat.impliedMovePct === null ? '' : `, implied ${cat.impliedMovePct.toFixed(2)}%${reaches ? ' reaches the fail price' : ''}`}.`);
  }
  if (next) parts.push(`${next.what} in ${durationLabel(next.at - now)}.`);

  return {
    positionId: pos.id, asOf: iso(now), mark, pnlUsd: pnlUsd(pos.instrument, pos.units, pos.entryPrice, mark, pos.direction),
    failPrice, distancePts, distancePct, status, atr1m: a,
    nextLockOrSnapshot: next ? { what: next.what, at: iso(next.at) } : null,
    catalystInWindow: cat ? { id: cat.id, name: cat.name, at: cat.scheduledAt, tier: cat.tier } : null,
    line: parts.join(' '), failBasis, worstRemainingPct: worstPct,
  };
}
