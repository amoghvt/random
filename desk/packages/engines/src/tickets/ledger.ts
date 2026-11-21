/**
 * Override ledger and the one-screen prompt shown before an override (spec section 8, Override policy).
 *
 * Method. For each overridden trade, impact = realized P&L minus the P&L the written ticket would have made on the same
 * price path (`simulatePlan`: planned size from the actual entry, each target's fraction off at its level, the rest out at
 * the invalidation or the time stop). The reducers split that evenly across the trade's overrides as `pnlImpactUsd`.
 * Month to date = the sum of those for overrides stamped in the current calendar month (tz wall clock). Negative means
 * overriding cost money against the plan. An override "paid" when its trade's impact is above 0.
 */
import { ET, dayKey, fromZoned, iso, ms, round, zoned, fmtSignedUsd, fmtUsd, type OverrideLedger, type Ticket } from '@desk/contracts';
import { captureComparison } from './regret';
import { etClock, px } from './position';

export interface OverrideLedgerDetail extends OverrideLedger {
  month: string; asOf: string;
  /** Overrides this month whose impact is not computed yet (trade still open, or the path to the plan's end not in yet). */
  pendingInstances: number;
  trades: Array<{ ticketId: string; instrument: string; impactUsd: number; overrides: number }>;
}

export function overrideLedger(tickets: Ticket[], now: number, tz: string = ET): OverrideLedgerDetail {
  const z = zoned(now, tz);
  const month = dayKey(now, tz).slice(0, 7);
  let total = 0, instances = 0, pending = 0, lastPaid: number | null = null;
  const trades: OverrideLedgerDetail['trades'] = [];
  for (const t of tickets) {
    if (t.status === 'cancelled') continue;
    let impact = 0, n = 0;
    for (const o of t.overrides) {
      if (o.pnlImpactUsd !== null && o.pnlImpactUsd > 0 && ms(o.ts) <= now && (lastPaid === null || ms(o.ts) > lastPaid)) lastPaid = ms(o.ts);
      if (dayKey(o.ts, tz).slice(0, 7) !== month || ms(o.ts) > now) continue;
      instances++; n++;
      if (o.pnlImpactUsd === null) pending++; else impact += o.pnlImpactUsd;
    }
    if (n > 0) { total += impact; trades.push({ ticketId: t.id, instrument: t.instrument, impactUsd: round(impact, 2), overrides: n }); }
  }
  const cmp = captureComparison(tickets, fromZoned(z.year, z.month, 1, 0, 0, tz));
  return {
    monthToDateUsd: round(total, 2), instances, lastPaidAt: lastPaid === null ? null : iso(lastPaid),
    planCapturePct: cmp.planCapturePct, overrideCapturePct: cmp.overrideCapturePct,
    month, asOf: iso(now), pendingInstances: pending, trades,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (t: string, tz: string): string => { const z = zoned(t, tz); return `${MONTHS[z.month - 1]} ${z.day}`; };

/** The ledger sentence on its own; also what replaces a repeated guardrail flag. */
export function ledgerSentence(ledger: OverrideLedger & { pendingInstances?: number }, tz: string = ET): string {
  if (ledger.instances === 0) return 'No overrides on the books this month. This would be the first.';
  const n = `${ledger.instances} ${ledger.instances === 1 ? 'instance' : 'instances'}`;
  const paid = ledger.lastPaidAt ? `the last one that paid was ${shortDate(ledger.lastPaidAt, tz)}` : 'none has paid yet';
  if ((ledger.pendingInstances ?? 0) >= ledger.instances) return `${n} of overriding this month, none settled yet; ${paid}.`;
  return `Overrides are ${ledger.monthToDateUsd === 0 ? '$0' : fmtUsd(ledger.monthToDateUsd)} month to date across ${n}; ${paid}.`;
}

/**
 * The text shown before an override: the plan, the live P&L, the running cost. Built only from the ticket and the ledger;
 * then the trader decides.
 */
export function overridePrompt(ticket: Ticket, livePnlUsd: number | null, ledger: OverrideLedger & { pendingInstances?: number }, tz: string = ET): string {
  const [t1, t2, t3] = ticket.targets;
  const pct = (f: number): string => `${Math.round(f * 100)}%`;
  const plan = `Plan: ${ticket.instrument} ${ticket.direction}, ${pct(t1.fraction)} off at ${px(t1.price)}, ${pct(t2.fraction)} at ${px(t2.price)}, rest at ${px(t3.price)}; out at ${px(ticket.invalidation.price)}; flat by ${etClock(ticket.timeStop)}.`;
  const live = livePnlUsd === null ? 'Live P&L: no mark.' : `Live P&L ${fmtSignedUsd(livePnlUsd)}.`;
  return [plan, live, ledgerSentence(ledger, tz), 'Your call.'].join('\n');
}
