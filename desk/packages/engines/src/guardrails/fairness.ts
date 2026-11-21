/**
 * Fairness: the warnings only carry weight if the correct reads are acknowledged too.
 * Built from journal entries alone; null when the journal has nothing recent to point at.
 */
import { DAY, ET, dayKey, ms } from '@desk/contracts';
import { thresholdsOf, type GuardrailContext } from './context';
import { joinAnd, shortDate, signedUsd } from './voice';

export interface Acknowledgement { text: string; refs: string[]; asOf: string }

export function acknowledgeCorrectRead(ctx: GuardrailContext): Acknowledgement | null {
  const since = ctx.now - thresholdsOf(ctx).acknowledgeLookbackDays * DAY;
  const recent = (t: string): boolean => ms(t) >= since && ms(t) <= ctx.now;
  const reads = (ctx.correctReads ?? []).filter((r) => recent(r.ts)).sort((a, b) => ms(a.ts) - ms(b.ts)).slice(-2);
  const asOf = new Date(ctx.now).toISOString();
  if (reads.length > 0) {
    return { text: `You called ${joinAnd(reads.map((r) => `the ${shortDate(dayKey(r.ts, ET))} ${r.what}`))}.`, refs: reads.map((r) => r.sourceId), asOf };
  }
  const winner = ctx.tickets
    .filter((t) => t.closedAt && recent(t.closedAt) && t.result && t.result.followedPlan && t.result.pnlUsd > 0)
    .sort((a, b) => ms(b.closedAt!) - ms(a.closedAt!))[0];
  if (!winner?.result || !winner.closedAt) return null;
  const capture = winner.result.capturePct != null ? `, ${Math.round(winner.result.capturePct)}% of the move captured` : '';
  return {
    text: `Plan followed on the ${shortDate(dayKey(winner.closedAt, ET))} ${winner.instrument} ${winner.direction}: ${signedUsd(winner.result.pnlUsd)}${capture}.`,
    refs: [winner.id], asOf,
  };
}
