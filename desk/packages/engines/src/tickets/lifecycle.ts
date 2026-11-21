/**
 * Ticket lifecycle reducers. Pure: ticket in, new ticket out; nothing is mutated and nothing is persisted here.
 * The system never places orders; fills arrive from the account feed or the trader's confirmation.
 */
import { MIN, iso, ms, round, type Candle, type Fill, type OverrideKind, type Ticket } from '@desk/contracts';
import { scoreAdherence } from './adherence';
import { detectDeviations, type DeviationOptions } from './deviations';
import { EPS, etClock, favorable, inferFillOverrides, isIncrease, px, reached, replayFills, sign, sortedFills, targetProgress, type OverrideCandidate, type PositionSnapshot } from './position';
import { capturePct, postExitExcursions, postExitWindowEnd, simulatePlan } from './regret';

export class TicketStateError extends Error {
  constructor(message: string) { super(message); this.name = 'TicketStateError'; }
}

export const UNDECLARED = 'Undeclared: ';
const ONCE: OverrideKind[] = ['size_up', 'held_through_invalidation', 'held_through_time_stop', 'added_to_loser'];

export interface FillOutcome {
  ticket: Ticket;
  /** Set when the fill was not applied; the ticket is returned unchanged. */
  rejected: string | null;
  /** Deviations this fill created. Show the override prompt, then `recordOverride` with the trader's reason. */
  candidates: OverrideCandidate[];
  /** Which target a scale-out fill was matched to. */
  matchedTarget: 1 | 2 | 3 | null;
  /** True when nothing is left open: call `closeTicket`. */
  flat: boolean;
  position: PositionSnapshot;
  asOf: string;
}

/**
 * Applies one fill. An entry opens the ticket; scale-outs are matched to the first unfilled target their price reached;
 * a reducing fill larger than the open size is clamped to it. Adds are checked: under water is `added_to_loser`,
 * past `size.units` is `size_up`. A scale-out or exit before the plan called for one is an `early_exit` candidate (0 points).
 */
export function applyFill(ticket: Ticket, fillIn: Fill, now: number): FillOutcome {
  const asOf = iso(now);
  const before = replayFills(ticket);
  const reject = (rejected: string): FillOutcome => ({ ticket, rejected, candidates: [], matchedTarget: null, flat: before.enteredUnits > 0 && before.openUnits <= EPS, position: before, asOf });
  if (ticket.status === 'closed' || ticket.status === 'cancelled') return reject(`Ticket is ${ticket.status}. Fills go on a live ticket.`);
  if (!(fillIn.units > 0) || !(fillIn.price > 0) || !Number.isFinite(ms(fillIn.ts))) return reject('Fill needs a time, a price above 0 and units above 0.');
  let fill: Fill = { ...fillIn };
  const candidates: OverrideCandidate[] = [];
  const known = new Set<OverrideKind>([...ticket.overrides.map((o) => o.kind), ...inferFillOverrides(ticket).map((c) => c.kind)]);

  if (isIncrease(fill)) {
    if (fill.kind === 'add' && before.openUnits <= EPS) return reject('Nothing open to add to. The first fill is an entry.');
    if (fill.kind === 'entry' && ticket.entry.kind === 'time' && ticket.entry.at !== undefined && before.enteredUnits === 0 && ms(fill.ts) < ms(ticket.entry.at) - MIN) {
      candidates.push({ kind: 'other', ts: fill.ts, price: fill.price, reason: `Entered ${Math.round((ms(ticket.entry.at) - ms(fill.ts)) / MIN)} min before the ${etClock(ticket.entry.at)} trigger.` });
    }
  } else {
    if (before.openUnits <= EPS) return reject('Nothing open to reduce.');
    if (fill.units > before.openUnits) fill = { ...fill, units: before.openUnits };
  }

  const next: Ticket = { ...ticket, fills: [...ticket.fills, fill], status: 'open' };
  const after = replayFills(next);
  for (const c of inferFillOverrides(next)) if (!known.has(c.kind)) candidates.push(c);

  let matchedTarget: FillOutcome['matchedTarget'] = null;
  if (!isIncrease(fill)) {
    const progress = targetProgress(next);
    const idx = progress.filledAt.findIndex((f) => f === fill);
    if (idx >= 0) matchedTarget = (idx + 1) as 1 | 2 | 3;
    const scaled = progress.filledAt.filter((f) => f !== null).length;
    const atInvalidation = reached(fill.price, ticket.invalidation.price, sign(ticket.direction) > 0 ? -1 : 1);
    const early = fill.kind === 'scale_out' ? idx < 0
      : fill.kind === 'exit' && !atInvalidation && ms(fill.ts) < ms(ticket.timeStop) && scaled < 2 && favorable(ticket.direction, ticket.targets[2].price, fill.price) < 0;
    if (early && !ticket.overrides.some((o) => o.kind === 'early_exit')) {
      const nextTarget = ticket.targets[Math.min(scaled, 2)]!;
      candidates.push({ kind: 'early_exit', ts: fill.ts, price: fill.price, reason: `Out at ${px(fill.price)}, ${px(round(Math.abs(nextTarget.price - fill.price), 2))} pts short of T${Math.min(scaled, 2) + 1} ${px(nextTarget.price)}.` });
    }
  }
  return { ticket: next, rejected: null, candidates, matchedTarget, flat: after.openUnits <= EPS, position: after, asOf };
}

/**
 * Logs an override with the trader's one-line reason. One per kind for size up, the two holds and the add (a second is a no-op,
 * unless the first was system-detected: then the trader's reason replaces it). Skipped scale-outs and the rest stack.
 */
export function recordOverride(ticket: Ticket, kind: OverrideKind, reason: string, now: number): Ticket {
  if (ticket.status === 'cancelled') throw new TicketStateError('Ticket is cancelled. Nothing to override.');
  const text = reason.trim() || 'No reason given.';
  if (ONCE.includes(kind)) {
    const i = ticket.overrides.findIndex((o) => o.kind === kind);
    if (i >= 0) {
      const existing = ticket.overrides[i]!;
      if (!existing.reason.startsWith(UNDECLARED) || text.startsWith(UNDECLARED)) return ticket;
      return { ...ticket, overrides: ticket.overrides.map((o, k) => (k === i ? { ...o, reason: text } : o)) };
    }
  }
  return { ...ticket, overrides: [...ticket.overrides, { ts: iso(now), kind, reason: text, pnlImpactUsd: null }] };
}

/** Cancels a ticket that never filled. An open ticket is closed, not cancelled. */
export function cancelTicket(ticket: Ticket, now: number): Ticket {
  if (ticket.status === 'cancelled') return ticket;
  if (ticket.fills.length > 0 || ticket.status === 'open' || ticket.status === 'closed') throw new TicketStateError('Ticket has fills. Close it; a filled ticket is never cancelled.');
  return { ...ticket, status: 'cancelled', closedAt: iso(now) };
}

/**
 * Plan impact of overriding, per overridden trade: realized P&L minus what `simulatePlan` says the written ticket would have
 * made on the same path. Split evenly across the trade's overrides so the ledger can sum them. Left null until the candles
 * cover the plan to its end.
 */
function withPlanImpact(ticket: Ticket, candles: Candle[]): Ticket {
  if (ticket.overrides.length === 0) return ticket;
  const sim = simulatePlan(ticket, candles);
  if (!sim.complete || sim.pnlUsd === null) return ticket;
  const each = round((replayFills(ticket).realizedUsd - sim.pnlUsd) / ticket.overrides.length, 2);
  return { ...ticket, overrides: ticket.overrides.map((o) => ({ ...o, pnlImpactUsd: each })) };
}

/**
 * Closes the trade: any open units exit at `price` (logged as a stop when the price is at or through the invalidation),
 * undeclared deviations found on `candlesDuringTrade` are added as overrides, and the result block is computed.
 * Exit price in the result is the final exit fill; P&L is realized across every fill. Post-exit MFE/MAE come from
 * `settleResult` once candles after the exit exist; capture is set here only when the candles reach the time stop
 * (or the exit is at or after it).
 */
export function closeTicket(ticket: Ticket, exit: { price: number; ts: string | number }, candlesDuringTrade: Candle[], opts: DeviationOptions = {}): Ticket {
  if (ticket.status === 'closed') return ticket;
  const pos0 = replayFills(ticket);
  if (ticket.status === 'cancelled' || pos0.firstEntryTs === null) throw new TicketStateError('Ticket never filled. Cancel it; there is nothing to close.');
  const exitMs = ms(exit.ts);
  let t: Ticket = ticket;
  if (pos0.openUnits > EPS) {
    if (!(exit.price > 0) || !Number.isFinite(exitMs)) throw new TicketStateError('Close needs a price above 0 and a time.');
    const stopped = reached(exit.price, ticket.invalidation.price, sign(ticket.direction) > 0 ? -1 : 1);
    t = { ...t, fills: [...t.fills, { ts: iso(exitMs), price: exit.price, units: pos0.openUnits, kind: stopped ? 'stop' : 'exit', source: 'manual' }] };
  }
  const pos = replayFills(t);
  const endMs = pos.lastExitTs ?? exitMs;
  for (const d of detectDeviations(t, candlesDuringTrade, endMs, opts)) {
    t = { ...t, overrides: [...t.overrides, { ts: d.ts, kind: d.kind, reason: `${UNDECLARED}${d.reason}`, pnlImpactUsd: null }] };
  }
  t = withPlanImpact(t, candlesDuringTrade);
  const { score, deductions } = scoreAdherence(t);
  const stopAt = ms(t.timeStop);
  const lastCandle = candlesDuringTrade.reduce((m, c) => Math.max(m, c.t), -Infinity);
  const covered = endMs >= stopAt || lastCandle >= stopAt - 5 * MIN;
  return {
    ...t, status: 'closed', closedAt: iso(endMs),
    result: {
      pnlUsd: round(pos.realizedUsd, 2), exitPrice: pos.lastExitPrice ?? exit.price, adherence: score, deductions,
      mfeAfterExitPct: null, maeAfterExitPct: null,
      capturePct: covered ? capturePct(t, candlesDuringTrade).capturePct : null,
      followedPlan: t.overrides.length === 0,
    },
  };
}

export interface Settlement { ticket: Ticket; /** True once `now` is past the post-exit window (time stop + 1 session). */ complete: boolean; window: { from: string; to: string } }
/**
 * Fills in the regret-killer numbers on a closed trade from candles spanning the entry to the end of the post-exit window:
 * MFE/MAE after exit, capture against the best price before the time stop, and the overrides' plan impact.
 * Safe to call repeatedly as candles arrive; `complete` says when to stop.
 */
export function settleResult(ticket: Ticket, candles: Candle[], now: number): Settlement {
  if (ticket.status !== 'closed' || ticket.result === null || ticket.closedAt === null) throw new TicketStateError('Only a closed ticket settles.');
  const exitMs = replayFills(ticket).lastExitTs ?? ms(ticket.closedAt);
  const end = postExitWindowEnd(ticket, exitMs);
  const seen = candles.filter((c) => c.t <= now);
  const exc = postExitExcursions(ticket, seen);
  const cap = now >= ms(ticket.timeStop) ? capturePct(ticket, seen).capturePct : ticket.result.capturePct;
  const t = withPlanImpact(ticket, seen);
  return {
    ticket: { ...t, result: { ...ticket.result, mfeAfterExitPct: exc.mfePct, maeAfterExitPct: exc.maePct, capturePct: cap } },
    complete: now >= end, window: { from: iso(exitMs), to: iso(end) },
  };
}

/** True when the trade ended on a stop fill. */
export const stoppedOut = (ticket: Ticket): boolean => sortedFills(ticket).some((f) => f.kind === 'stop');
