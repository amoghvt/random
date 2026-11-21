/** Plan-adherence scoring (spec section 8). Adherence first, P&L second. */
import { dayKey, ms, round, type OverrideKind, type Ticket } from '@desk/contracts';
import { inferFillOverrides } from './position';

/** Spec deductions. Kinds not listed are logged overrides that cost no points. */
export const DEDUCTIONS: Partial<Record<OverrideKind, number>> = {
  size_up: 40, held_through_invalidation: 30, held_through_time_stop: 20, skipped_scale_out: 10, added_to_loser: 40,
};
export interface Deduction { kind: OverrideKind; points: number }
export interface AdherenceScore { score: number; deductions: Deduction[] }

/**
 * 100 minus the spec deductions, floor 0. Counted from the ticket's overrides plus what the fills prove on their own
 * (size up, added to a loser), so an undeclared add still costs. Each kind deducts once, except a skipped scale-out: 10 per target, 3 at most.
 */
export function scoreAdherence(ticket: Ticket): AdherenceScore {
  const kinds: OverrideKind[] = ticket.overrides.map((o) => o.kind);
  for (const c of inferFillOverrides(ticket)) if (!kinds.includes(c.kind)) kinds.push(c.kind);
  const deductions: Deduction[] = [];
  let skips = 0;
  for (const kind of kinds) {
    const points = DEDUCTIONS[kind];
    if (points === undefined) continue;
    if (kind === 'skipped_scale_out') { if (skips++ < 3) deductions.push({ kind, points }); } else if (!deductions.some((d) => d.kind === kind)) deductions.push({ kind, points });
  }
  return { score: Math.max(0, 100 - deductions.reduce((a, d) => a + d.points, 0)), deductions };
}

export interface RollingAdherence { score: number | null; count: number; pnlUsd: number | null; ticketIds: string[] }
/** Mean adherence of the last n closed trades (the dashboard's lead number). Null with no closed trades. */
export function rollingAdherence(tickets: Ticket[], n = 20): RollingAdherence {
  const closed = tickets.filter((t) => t.status === 'closed' && t.closedAt !== null).sort((a, b) => ms(b.closedAt!) - ms(a.closedAt!)).slice(0, n);
  if (closed.length === 0) return { score: null, count: 0, pnlUsd: null, ticketIds: [] };
  const scores = closed.map((t) => t.result?.adherence ?? scoreAdherence(t).score);
  return {
    score: round(scores.reduce((a, b) => a + b, 0) / scores.length, 1), count: closed.length,
    pnlUsd: round(closed.reduce((a, t) => a + (t.result?.pnlUsd ?? 0), 0), 2), ticketIds: closed.map((t) => t.id),
  };
}

/**
 * Circuit-breaker input: trades that broke the plan today (tz wall-clock day). A trade counts when it carries a deduction and
 * either closed today or had a deduction-bearing override stamped today. Optionally per account.
 */
export function planBreakingTradesToday(tickets: Ticket[], now: number, tz: string, accountId?: string): number {
  const today = dayKey(now, tz);
  return tickets.filter((t) => {
    if (accountId !== undefined && t.accountId !== accountId) return false;
    if (t.status === 'cancelled' || scoreAdherence(t).deductions.length === 0) return false;
    const closedToday = t.closedAt !== null && dayKey(t.closedAt, tz) === today;
    const deviatedToday = t.overrides.some((o) => DEDUCTIONS[o.kind] !== undefined && dayKey(o.ts, tz) === today)
      || inferFillOverrides(t).some((c) => dayKey(c.ts, tz) === today);
    return closedToday || deviatedToday;
  }).length;
}
