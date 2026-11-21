/** Time-based P2 reminders due this loop. Each is emitted at most once: any key `decide` has already seen is skipped. */
import { DAY, ET, HOUR, INSTRUMENTS, MIN, fmtUsd, fromZoned, zoned } from '@desk/contracts';
import type { AccountRules, AccountState, Catalyst, NotificationIntent, Position, Profile } from '@desk/contracts';
import { catalystT60, inactivityT24h, payoutEligible, vestWeekendLockT30 } from './builders';
import type { NotifyState } from './state';

export interface ReminderAccount {
  rules: AccountRules;
  state: AccountState;
  /** Open positions on this account; the weekend-lock reminder needs a non-crypto one. */
  positions?: Position[];
  /** The sizing engine's eligibility line, when it has one. Overrides the local check. */
  payoutLine?: string;
}

export interface ReminderContext {
  now: number;
  catalysts: Catalyst[];
  accounts: ReminderAccount[];
  profile: Profile;
  state: NotifyState;
  /** Send the weekend-lock reminder even with no open non-crypto position. */
  weekendLockAlways?: boolean;
}

/** Crypto trades through the Vest weekend lock; everything else is locked. */
const isCrypto = (symbol: string): boolean => INSTRUMENTS[symbol]?.kind === 'crypto';
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Next occurrence of the account's weekend lock start. `fromET` is read as "[weekday] HH:MM";
 * the weekday defaults to Friday and the time to 20:00 (spec section 7).
 */
export function nextWeekendLock(rules: AccountRules, now: number): number | null {
  const lock = rules.session.weekendLock;
  if (!lock) return null;
  const time = /(\d{1,2}):(\d{2})/.exec(lock.fromET);
  const named = WEEKDAYS.findIndex((d) => lock.fromET.toLowerCase().includes(d));
  const weekday = named >= 0 ? named : 5;
  const [hour, minute] = time ? [Number(time[1]), Number(time[2])] : [20, 0];
  const z = zoned(now, ET);
  const at = fromZoned(z.year, z.month, z.day + ((weekday - z.weekday + 7) % 7), hour, minute, ET);
  return at > now ? at : fromZoned(z.year, z.month, z.day + 7, hour, minute, ET);
}

/** Instant the inactivity rule breaches: the last trade plus the rule's calendar days. */
export function inactivityDeadline(rules: AccountRules, state: AccountState): number | null {
  if (rules.inactivityDays === null || state.lastTradeAt === null) return null;
  return Date.parse(state.lastTradeAt) + rules.inactivityDays * DAY;
}

/**
 * Whether the payout conditions encoded in the account rules are all met, and the line to show.
 * Checks every condition the schema carries (payout count, qualifying days, cycle length, consistency,
 * buffer, minimum); a null condition does not apply. Returns null when not eligible.
 */
export function payoutEligibility(rules: AccountRules, state: AccountState, now: number): { line: string; cycleKey: string } | null {
  const p = rules.payout;
  if (!state.active || state.cyclePnl <= 0) return null;
  if (p.maxPayouts !== null && state.payoutsTaken >= p.maxPayouts) return null;
  if (p.qualifyingDays !== null && state.qualifyingDaysInCycle < p.qualifyingDays) return null;
  if (p.cycleDays !== null && (state.cycleStartedAt === null || now - Date.parse(state.cycleStartedAt) < p.cycleDays * DAY)) return null;
  const bestDayPct = (state.bestDayPnlInCycle / state.cyclePnl) * 100;
  const limitPct = p.consistencyPct === null ? null : p.consistencyPct <= 1 ? p.consistencyPct * 100 : p.consistencyPct;
  if (limitPct !== null && bestDayPct > limitPct) return null;
  const above = state.balance - rules.startingBalance - (p.bufferUsd ?? 0);
  const amount = p.capUsd !== null ? Math.min(above, p.capUsd) : above;
  if (amount <= 0 || (p.minUsd !== null && amount < p.minUsd)) return null;
  const parts = [
    `${fmtUsd(amount)} claimable`,
    p.qualifyingDays !== null ? `${state.qualifyingDaysInCycle} of ${p.qualifyingDays} qualifying days` : null,
    limitPct !== null ? `best day ${Math.round(bestDayPct)}% of the cycle vs ${Math.round(limitPct)}% limit` : null,
  ].filter((x): x is string => x !== null);
  return { line: `${parts.join(', ')}.`, cycleKey: `${state.cycleStartedAt ?? 'open'}:${state.payoutsTaken}` };
}

export function dueReminders(ctx: ReminderContext): NotificationIntent[] {
  const { now } = ctx;
  const due: Array<NotificationIntent | null> = [];

  for (const c of ctx.catalysts) {
    const lead = Date.parse(c.scheduledAt) - now;
    if (lead > 0 && lead <= HOUR) due.push(catalystT60(c, now));
  }
  for (const a of ctx.accounts) {
    if (!a.state.active) continue;
    const lockAt = nextWeekendLock(a.rules, now);
    const exposed = ctx.weekendLockAlways === true || (a.positions ?? []).some((p) => !isCrypto(p.instrument));
    if (lockAt !== null && exposed && lockAt - now <= 30 * MIN) due.push(vestWeekendLockT30(a.rules, lockAt, now));

    const deadline = inactivityDeadline(a.rules, a.state);
    if (deadline !== null && deadline - now <= DAY) due.push(inactivityT24h(a.rules, deadline, now));

    const local = payoutEligibility(a.rules, a.state, now);
    const cycleKey = `${a.state.cycleStartedAt ?? 'open'}:${a.state.payoutsTaken}`;
    if (a.payoutLine) due.push(payoutEligible(a.rules, a.payoutLine, now, cycleKey));
    else if (local) due.push(payoutEligible(a.rules, local.line, now, local.cycleKey));
  }

  const seen = new Set<string>();
  return due.filter((n): n is NotificationIntent => {
    if (n === null || ctx.state.keys[n.dedupeKey] !== undefined || seen.has(n.dedupeKey)) return false;
    seen.add(n.dedupeKey);
    return true;
  });
}
