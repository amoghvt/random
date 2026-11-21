/** Account row for the Positions screen and the brief: floor, room, payout and consistency lines, next deadline. Pure. */
import { DAY, fmtSignedUsd, fmtUsd, iso, ms, type AccountRow, type AccountRules } from '@desk/contracts';
import { accountRoom, isUnverifiedText, type AccountStateInput } from './room';
import { weekendLockAt } from './session';

export type AccountRowFields = Omit<AccountRow, 'rules' | 'state'> & {
  /** Set after a single-session gain above the firm's claim threshold (Vest). Also leads payoutLine. */
  claimPrompt: string | null;
  /** Nearer-limit room after the cushion: what a ticket may risk. */
  usableUsd: number;
  blockReason: string | null;
};

/** Cap on the next payout request: the ladder step for the payouts taken so far, else the flat cap. */
function nextCap(rules: AccountRules, payoutsTaken: number): number | null {
  const l = rules.payout.ladderUsd;
  if (l && l.length > 0) return l[Math.min(payoutsTaken, l.length - 1)]!;
  return rules.payout.capUsd;
}

export function accountRow(rules: AccountRules, state: AccountStateInput, now: number): AccountRowFields {
  const room = accountRoom(rules, state, now);
  const p = rules.payout;
  const start = state.startingBalance ?? rules.startingBalance;
  const payoutUnverified = isUnverifiedText(p.text) && p.bufferUsd === null && p.capUsd === null && p.consistencyPct === null;
  const closed = p.maxPayouts !== null && state.payoutsTaken >= p.maxPayouts;

  let claimableUsd: number | null = null;
  if (!payoutUnverified && room.unverified.length === 0 && !closed) {
    const above = Math.max(0, state.balance - (start + (p.bufferUsd ?? 0)));
    const cap = nextCap(rules, state.payoutsTaken);
    claimableUsd = cap === null ? above : Math.min(above, cap);
  }

  const sessionPct = state.dayStartBalance > 0 ? (state.dayPnl / state.dayStartBalance) * 100 : 0;
  const claimPrompt = rules.claimPromptGainPct !== null && sessionPct > rules.claimPromptGainPct
    ? `Session ${fmtSignedUsd(state.dayPnl)} is +${sessionPct.toFixed(0)}% of the account, over the ${rules.claimPromptGainPct}% line. Claim now, withdraw same day.`
    : null;

  const bits: string[] = [];
  if (room.unverified.length > 0) bits.push(`No size until confirmed: ${room.unverified.join('; ')}.`);
  if (closed) bits.push(`${state.payoutsTaken} of ${p.maxPayouts} payouts taken: account is closed to payouts.`);
  else if (payoutUnverified) bits.push(`Payout rules unverified, confirm in the firm dashboard.`);
  else if (claimableUsd !== null) {
    const cap = nextCap(rules, state.payoutsTaken);
    const where = p.bufferUsd !== null ? ` above the ${fmtUsd(p.bufferUsd)} buffer` : '';
    const terms: string[] = [];
    if (cap !== null) terms.push(`cap ${fmtUsd(cap)}`);
    if (p.minUsd !== null) terms.push(`minimum ${fmtUsd(p.minUsd)}`);
    if (p.qualifyingDays !== null) terms.push(`${Math.min(state.qualifyingDaysInCycle, p.qualifyingDays)} of ${p.qualifyingDays} qualifying days`);
    if (p.cycleDays !== null && state.cycleStartedAt) terms.push(`day ${Math.min(p.cycleDays, Math.floor((now - ms(state.cycleStartedAt)) / DAY) + 1)} of ${p.cycleDays}`);
    if (p.maxPayouts !== null) terms.push(`payout ${state.payoutsTaken + 1} of ${p.maxPayouts}`);
    if (terms.length === 0) terms.push('no cap, no schedule');
    bits.push(`Claimable ${fmtUsd(claimableUsd)}${where}; ${terms.join(', ')}.`);
  }
  const payoutLine = [claimPrompt, ...bits].filter((s): s is string => s !== null).join(' ');

  let consistencyLine: string | null = null;
  if (p.consistencyPct !== null) {
    if (state.cyclePnl <= 0) consistencyLine = `Cycle ${fmtSignedUsd(state.cyclePnl)}; ${p.consistencyPct}% consistency has nothing to measure yet.`;
    else {
      const share = (state.bestDayPnlInCycle / state.cyclePnl) * 100;
      consistencyLine = share > p.consistencyPct
        ? `Best day ${fmtUsd(state.bestDayPnlInCycle)} is ${share.toFixed(0)}% of the ${fmtUsd(state.cyclePnl)} cycle, over the ${p.consistencyPct}% limit; needs ${fmtSignedUsd(state.bestDayPnlInCycle / (p.consistencyPct / 100) - state.cyclePnl)} on other days.`
        : `Best day ${fmtUsd(state.bestDayPnlInCycle)} is ${share.toFixed(0)}% of the ${fmtUsd(state.cyclePnl)} cycle; limit ${p.consistencyPct}%.`;
    }
  }

  const deadlines: Array<{ what: string; at: number }> = [];
  if (rules.inactivityDays !== null && state.lastTradeAt) deadlines.push({ what: `Inactivity breach: ${rules.inactivityDays} days without a trade`, at: ms(state.lastTradeAt) + rules.inactivityDays * DAY });
  if (p.cycleDays !== null && state.cycleStartedAt) deadlines.push({ what: `Payout eligible: ${p.cycleDays} calendar days`, at: ms(state.cycleStartedAt) + p.cycleDays * DAY });
  const lockSymbol = rules.instruments[0];
  const lock = lockSymbol ? weekendLockAt(rules, lockSymbol, now) : null;
  if (lock) deadlines.push(lock.inside ? { what: `${rules.firm} weekend lock lifts`, at: lock.to } : { what: `${rules.firm} weekend lock`, at: lock.from });
  const next = deadlines.filter((d) => d.at > now).sort((a, b) => a.at - b.at)[0] ?? null;

  return {
    floorUsd: Number.isNaN(room.floorUsd) ? 0 : room.floorUsd, roomUsd: room.rawUsd, usableUsd: room.usableUsd,
    payoutLine, consistencyLine, nextDeadline: next ? { what: next.what, at: iso(next.at) } : null,
    claimableUsd, claimPrompt, blockReason: room.blockReason,
  };
}
