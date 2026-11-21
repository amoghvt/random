/**
 * The regret killer (spec section 8): what price did after the exit, how much of the available move the
 * exits captured, and what the written plan would have made on the same path.
 */
import { DAY, iso, ms, pnlUsd, round, type Candle, type Ticket } from '@desk/contracts';
import { EPS, candlesSince, favorable, reached, replayFills, sign, sortedFills } from './position';

/** "Time stop + 1 session": one full 24-hour cycle after the later of the exit and the time stop. */
export const POST_EXIT_SESSION_MS = DAY;
export const postExitWindowEnd = (ticket: Ticket, exitMs: number): number => Math.max(ms(ticket.timeStop), exitMs) + POST_EXIT_SESSION_MS;

export interface PostExitExcursions {
  /** Furthest move in the trade's direction after the exit, percent of exit price (>= 0). Null with no candles in the window. */
  mfePct: number | null;
  /** Furthest move against the trade's direction after the exit, percent of exit price (>= 0). */
  maePct: number | null;
  bestPrice: number | null; worstPrice: number | null;
  exitPrice: number | null;
  window: { from: string; to: string } | null;
  bars: number;
}

/**
 * Excursions after the final exit fill, measured on candles opening at or after the exit, up to the time stop + 1 session
 * (or `until`). Direction-aware: for a short, favorable is lower.
 */
export function postExitExcursions(ticket: Ticket, candlesAfterExit: Candle[], opts: { until?: number } = {}): PostExitExcursions {
  const pos = replayFills(ticket);
  const none: PostExitExcursions = { mfePct: null, maePct: null, bestPrice: null, worstPrice: null, exitPrice: pos.lastExitPrice, window: null, bars: 0 };
  if (pos.lastExitTs === null || pos.lastExitPrice === null || pos.openUnits > EPS) return none;
  const to = opts.until ?? postExitWindowEnd(ticket, pos.lastExitTs);
  const window = { from: iso(pos.lastExitTs), to: iso(to) };
  const path = candlesSince(candlesAfterExit, pos.lastExitTs, to);
  if (path.length === 0) return { ...none, window };
  const hi = Math.max(...path.map((c) => c.h)), lo = Math.min(...path.map((c) => c.l));
  const [best, worst] = ticket.direction === 'long' ? [hi, lo] : [lo, hi];
  const exit = pos.lastExitPrice;
  return {
    mfePct: round(Math.max(0, favorable(ticket.direction, exit, best)) / exit * 100, 3),
    maePct: round(Math.max(0, -favorable(ticket.direction, exit, worst)) / exit * 100, 3),
    bestPrice: best, worstPrice: worst, exitPrice: exit, window, bars: path.length,
  };
}

export interface Capture { capturePct: number | null; bestPrice: number | null; availableUsd: number | null; realizedUsd: number }
/**
 * Share of the available favorable move the realized exits captured:
 *   realized P&L / P&L had every entered unit exited at the best price between the entry and the time stop.
 * Negative when the trade lost while a favorable move was on offer. Clamped to [-100, 100] so one trade with a
 * tiny available move cannot swamp the comparison. Null when price never traded favorably (nothing to capture).
 */
export function capturePct(ticket: Ticket, candles: Candle[]): Capture {
  const pos = replayFills(ticket);
  const none: Capture = { capturePct: null, bestPrice: null, availableUsd: null, realizedUsd: round(pos.realizedUsd, 2) };
  if (pos.firstEntryTs === null || pos.avgEntry === null) return none;
  const path = candlesSince(candles, pos.firstEntryTs, ms(ticket.timeStop));
  if (path.length === 0) return none;
  const best = ticket.direction === 'long' ? Math.max(...path.map((c) => c.h)) : Math.min(...path.map((c) => c.l));
  const available = pnlUsd(ticket.instrument, pos.enteredUnits, pos.avgEntry, best, ticket.direction);
  if (!(available > EPS)) return { ...none, bestPrice: best };
  return { capturePct: round(Math.min(100, Math.max(-100, (pos.realizedUsd / available) * 100)), 1), bestPrice: best, availableUsd: round(available, 2), realizedUsd: round(pos.realizedUsd, 2) };
}

export interface PlanSimulation {
  /** False when the candles end before the plan is flat; then pnlUsd is null. */
  complete: boolean;
  pnlUsd: number | null;
  units: number; entryPrice: number | null;
  exits: Array<{ ts: string; price: number; fraction: number; why: 'T1' | 'T2' | 'T3' | 'invalidation' | 'time_stop' }>;
}
/**
 * What the ticket as written would have realized on this path. Planned size (never more than was entered through entry fills)
 * from the actual average entry price; each target's fraction comes off when a candle trades strictly through it; everything
 * left exits at the invalidation price when a candle trades at or through it, or at the open of the first candle at or after
 * the time stop. Invalidation is checked before targets inside one candle (the conservative order). The runner's trailing stop
 * is not modelled: the runner rides to T3, invalidation or the time stop.
 */
export function simulatePlan(ticket: Ticket, candles: Candle[]): PlanSimulation {
  const entries = sortedFills(ticket).filter((f) => f.kind === 'entry');
  const entered = entries.reduce((a, f) => a + f.units, 0);
  const first = entries[0];
  if (!first || entered <= EPS) return { complete: false, pnlUsd: null, units: 0, entryPrice: null, exits: [] };
  const units = Math.min(ticket.size.units, entered);
  const entryPrice = replayFills({ ...ticket, fills: entries }).avgEntry ?? first.price;
  const travel = sign(ticket.direction);
  const stopAt = ms(ticket.timeStop);
  const exits: PlanSimulation['exits'] = [];
  let left = 1, next = 0;
  for (const c of candlesSince(candles, ms(first.ts))) {
    if (c.t >= stopAt) { exits.push({ ts: iso(c.t), price: c.o, fraction: left, why: 'time_stop' }); left = 0; break; }
    if (reached(travel > 0 ? c.l : c.h, ticket.invalidation.price, travel > 0 ? -1 : 1)) { exits.push({ ts: iso(c.t), price: ticket.invalidation.price, fraction: left, why: 'invalidation' }); left = 0; break; }
    while (next < 3 && reached(travel > 0 ? c.h : c.l, ticket.targets[next]!.price, travel, true)) {
      const fraction = next === 2 ? left : Math.min(left, ticket.targets[next]!.fraction);
      exits.push({ ts: iso(c.t), price: ticket.targets[next]!.price, fraction, why: (['T1', 'T2', 'T3'] as const)[next]! });
      left -= fraction; next++;
    }
    if (left <= EPS) { left = 0; break; }
  }
  if (left > 0) return { complete: false, pnlUsd: null, units, entryPrice, exits };
  const pnl = exits.reduce((a, e) => a + pnlUsd(ticket.instrument, units * e.fraction, entryPrice, e.price, ticket.direction), 0);
  return { complete: true, pnlUsd: round(pnl, 2), units, entryPrice, exits };
}

export interface CaptureComparison {
  since: string;
  /** Mean capturePct of closed trades that followed the plan; null (not 0) with no sample. */
  planCapturePct: number | null; planCount: number;
  overrideCapturePct: number | null; overrideCount: number;
  /** Closed trades in the window with no capture number yet (no favorable move, or not settled). */
  unscored: number;
  text: string;
}
/** "Plan-following exits captured X% of the available move; overrides captured Y%." Trades closed at or after `since`. */
export function captureComparison(tickets: Ticket[], since: number | string): CaptureComparison {
  const from = ms(since);
  const closed = tickets.filter((t) => t.status === 'closed' && t.result !== null && t.closedAt !== null && ms(t.closedAt) >= from);
  const scored = closed.filter((t) => t.result!.capturePct !== null);
  const avg = (xs: Ticket[]): number | null => (xs.length ? round(xs.reduce((a, t) => a + t.result!.capturePct!, 0) / xs.length, 1) : null);
  const plan = scored.filter((t) => t.result!.followedPlan), over = scored.filter((t) => !t.result!.followedPlan);
  const p = avg(plan), o = avg(over);
  const part = (label: string, v: number | null, n: number): string => (v === null ? `${label}: no sample` : `${label} captured ${v.toFixed(0)}% of the available move (${n} ${n === 1 ? 'trade' : 'trades'})`);
  return {
    since: iso(from), planCapturePct: p, planCount: plan.length, overrideCapturePct: o, overrideCount: over.length, unscored: closed.length - scored.length,
    text: p === null && o === null ? 'No closed trades with a capture number yet. No sample, no verdict.' : `${part('Plan-following exits', p, plan.length)}; ${part('overrides', o, over.length)}.`,
  };
}
