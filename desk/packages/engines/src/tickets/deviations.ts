/**
 * Undeclared overrides, inferred from fills against the plan and the price path. The worker runs
 * `detectDeviations` every loop; `ticketAlerts` is the edge the P0 "invalidation or time stop hit" push hangs on.
 */
import { MIN, instrument, iso, ms, type Candle, type Ticket } from '@desk/contracts';
import { EPS, candlesSince, etClock, inferFillOverrides, isIncrease, px, reached, replayFills, sign, sortedFills, targetProgress, type OverrideCandidate } from './position';

export interface DeviationOptions {
  /** Minutes allowed between a target trading through and the scale-out fill. */
  scaleOutWindowMin?: number;
  /** Minutes allowed between invalidation trading and the position being flat. */
  invalidationGraceMin?: number;
  /** Minutes allowed past the time stop. */
  timeStopGraceMin?: number;
}
export const DEVIATION_DEFAULTS: Required<DeviationOptions> = { scaleOutWindowMin: 5, invalidationGraceMin: 2, timeStopGraceMin: 1 };

/**
 * Every deviation the fills and the path prove as of `now`, declared or not.
 *  - held_through_invalidation: a candle traded at or through the invalidation and the position was not flat `invalidationGraceMin` later.
 *  - held_through_time_stop: units still open `timeStopGraceMin` after the time stop.
 *  - skipped_scale_out (per target): a candle traded strictly through the target and, `scaleOutWindowMin` later, less had come off
 *    than the plan's cumulative fraction. Futures round down to whole contracts (a 1-lot cannot scale); notional sizes get 10% slack.
 *    A skipped target's fraction is not demanded again at the next target, so one miss is one deduction.
 *  - size_up / added_to_loser from the fills themselves.
 */
export function allDeviations(ticket: Ticket, candles1m: Candle[], now: number, opts: DeviationOptions = {}): OverrideCandidate[] {
  const o = { ...DEVIATION_DEFAULTS, ...opts };
  const out: OverrideCandidate[] = inferFillOverrides(ticket);
  const first = replayFills(ticket).firstEntryTs;
  if (first === null) return out;
  const travel = sign(ticket.direction);
  const path = candlesSince(candles1m, first, now + 1);
  const flatAt = (t: number): boolean => replayFills(ticket, t).openUnits <= EPS;

  const invHit = path.find((c) => reached(travel > 0 ? c.l : c.h, ticket.invalidation.price, travel > 0 ? -1 : 1));
  if (invHit) {
    const deadline = invHit.t + o.invalidationGraceMin * MIN;
    if (!flatAt(invHit.t) && deadline <= now && !flatAt(deadline)) {
      out.push({ kind: 'held_through_invalidation', ts: iso(invHit.t), price: ticket.invalidation.price, reason: `${px(ticket.invalidation.price)} traded at ${etClock(invHit.t)}; still in ${o.invalidationGraceMin} min later.` });
    }
  }

  const stopAt = ms(ticket.timeStop);
  const stopDeadline = stopAt + o.timeStopGraceMin * MIN;
  if (stopDeadline <= now && !flatAt(stopDeadline) && first <= stopDeadline) {
    out.push({ kind: 'held_through_time_stop', ts: ticket.timeStop, reason: `Time stop was ${etClock(stopAt)}; still open after it.` });
  }

  const whole = instrument(ticket.instrument).pointValue > 0;
  let owed = 0;
  ticket.targets.forEach((tg, i) => {
    const hit = path.find((c) => reached(travel > 0 ? c.h : c.l, tg.price, travel, true));
    if (!hit) return;
    const deadline = hit.t + o.scaleOutWindowMin * MIN;
    if (deadline > now) return;
    const at = replayFills(ticket, deadline);
    const enteredAtHit = replayFills(ticket, hit.t).enteredUnits;
    const cum = owed + tg.fraction;
    const required = whole ? Math.floor(cum * enteredAtHit + 1e-6) : cum * enteredAtHit * 0.9;
    if (enteredAtHit > EPS && at.exitedUnits + EPS < required) {
      out.push({ kind: 'skipped_scale_out', ts: iso(hit.t), targetIndex: (i + 1) as 1 | 2 | 3, price: tg.price, reason: `T${i + 1} ${px(tg.price)} traded at ${etClock(hit.t)}; no scale-out within ${o.scaleOutWindowMin} min.` });
    } else owed = cum;
  });
  return out.sort((a, b) => ms(a.ts) - ms(b.ts));
}

/**
 * Deviations not yet on the ticket. Single-instance kinds are dropped when an override of that kind exists;
 * skipped scale-outs are matched by count (the trader's own declaration covers the earliest skipped target).
 */
export function detectDeviations(ticket: Ticket, candles1m: Candle[], now: number, opts: DeviationOptions = {}): OverrideCandidate[] {
  const have = new Map<string, number>();
  for (const ov of ticket.overrides) have.set(ov.kind, (have.get(ov.kind) ?? 0) + 1);
  let skipsToDrop = have.get('skipped_scale_out') ?? 0;
  return allDeviations(ticket, candles1m, now, opts).filter((d) => {
    if (d.kind !== 'skipped_scale_out') return !have.has(d.kind);
    if (skipsToDrop > 0) { skipsToDrop--; return false; }
    return true;
  });
}

export interface TicketAlert {
  kind: 'invalidation' | 'time_stop' | 'target';
  targetIndex?: 1 | 2 | 3;
  level: number | null;
  /** Line 1 of the notification: the fact with the number. */
  text: string;
  /** Line 2: what the plan says to do. */
  action: string;
  dedupeKey: string;
  ts: string;
}

/**
 * What the plan says is due right now on an open ticket: invalidation traded, time stop passed, or a target traded with its
 * scale-out not yet filled. Stateless; each alert carries a dedupeKey so the notifier sends it once. Pass `prevPrice`
 * (the previous loop's price) to get crossings only.
 */
export function ticketAlerts(ticket: Ticket, lastPrice: number, now: number, opts: { prevPrice?: number } = {}): TicketAlert[] {
  const pos = replayFills(ticket);
  if (ticket.status !== 'open' || pos.openUnits <= EPS || !Number.isFinite(lastPrice)) return [];
  const travel = sign(ticket.direction);
  const ts = iso(now);
  const crossed = (level: number, dirOfTravel: 1 | -1): boolean =>
    reached(lastPrice, level, dirOfTravel) && (opts.prevPrice === undefined || !reached(opts.prevPrice, level, dirOfTravel));
  const out: TicketAlert[] = [];
  const inv = ticket.invalidation.price;
  if (crossed(inv, travel > 0 ? -1 : 1)) {
    out.push({ kind: 'invalidation', level: inv, ts, dedupeKey: `ticket:${ticket.id}:invalidation`, text: `${ticket.instrument} ${px(lastPrice)}: invalidation ${px(inv)} hit on the ${ticket.direction}.`, action: `Plan says out. ${ticket.invalidation.reason}.`.replace(/\.\.$/, '.') });
  }
  if (now >= ms(ticket.timeStop)) {
    out.push({ kind: 'time_stop', level: null, ts, dedupeKey: `ticket:${ticket.id}:time_stop`, text: `${ticket.instrument} ${ticket.direction}: time stop ${etClock(ticket.timeStop)} hit, still open at ${px(lastPrice)}.`, action: 'Plan says flat. The thesis had a clock.' });
  }
  const progress = targetProgress(ticket);
  const exitsSoFar = sortedFills(ticket).filter((f) => !isIncrease(f)).length;
  ticket.targets.forEach((tg, i) => {
    if (progress.filledAt[i] !== null || exitsSoFar > i || !crossed(tg.price, travel)) return;
    const pct = Math.round(tg.fraction * 100);
    out.push({ kind: 'target', targetIndex: (i + 1) as 1 | 2 | 3, level: tg.price, ts, dedupeKey: `ticket:${ticket.id}:target:${i + 1}`, text: `${ticket.instrument} ${px(lastPrice)}: T${i + 1} ${px(tg.price)} hit.`, action: i === 2 ? 'Plan says the rest comes off.' : `Plan says ${pct}% off here.` });
  });
  return out;
}
