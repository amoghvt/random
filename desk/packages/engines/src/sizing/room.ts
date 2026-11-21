/** Drawdown floor and usable room per account (spec section 7, step 2). Pure. */
import { fmtUsd, iso, ms, type AccountRules, type AccountState } from '@desk/contracts';
import { etLabel, lastSnapshot } from './session';

/** Cushion taken off the room for feed divergence and slippage, percent. */
export const CUSHION_PCT = 20;
export const UNVERIFIED_TEXT = 'unverified, confirm in the firm dashboard';
export const isUnverifiedText = (text: string): boolean => /unverified/i.test(text);

/** The trader may carry the real account size on the state when the YAML has none (requested contract field). */
export type AccountStateInput = AccountState & { startingBalance?: number };
const startOf = (rules: AccountRules, state?: AccountStateInput): number => state?.startingBalance ?? rules.startingBalance;

/** Rules that must be confirmed before this account can be sized. Empty = usable. */
export function unverifiedRules(rules: AccountRules, state?: AccountStateInput): string[] {
  const out: string[] = [];
  const d = rules.drawdown;
  if (d.amountUsd === null && d.pct === null && d.lockedFloor === null) out.push(`drawdown amount (${d.text})`);
  else if (d.amountUsd === null && d.pct !== null && startOf(rules, state) <= 0) out.push(`account size: the ${d.pct}% drawdown needs a starting balance (${d.text})`);
  const dl = rules.dailyLoss;
  if (dl && dl.amountUsd === null && dl.pctOfSnapshot === null) out.push(`daily loss limit (${dl.text})`);
  return out;
}

function drawdownAmount(rules: AccountRules, state: AccountStateInput): number {
  const d = rules.drawdown;
  if (d.amountUsd !== null) return d.amountUsd;
  if (d.pct !== null && startOf(rules, state) > 0) return (d.pct / 100) * startOf(rules, state);
  return NaN;
}

/**
 * Balance or equity level that ends the account. NaN when the rule is unverified.
 * static: start - amount. eod_trailing: highest end-of-day balance - amount. intraday_trailing: equity high-water - amount.
 * A trailing floor stops at `lockedFloor` (or at `locksAtBalance - amount` when only the lock balance is on file).
 */
export function drawdownFloor(rules: AccountRules, state: AccountStateInput): number {
  const d = rules.drawdown;
  const start = startOf(rules, state);
  const amount = drawdownAmount(rules, state);
  if (d.type === 'static') return Number.isNaN(amount) ? (d.lockedFloor ?? NaN) : start - amount;
  if (Number.isNaN(amount)) return NaN;
  const hw = d.type === 'eod_trailing' ? Math.max(state.highWaterBalance, start) : Math.max(state.highWaterBalance, state.equity, state.balance, start);
  const trailing = hw - amount;
  if (d.lockedFloor !== null) return Math.min(trailing, d.lockedFloor);
  if (d.locksAtBalance !== null) return Math.min(hw, d.locksAtBalance) - amount;
  return trailing;
}

export interface AccountRoom {
  accountId: string; asOf: string;
  floorUsd: number;
  /** Distance from the breach basis (equity when the rule counts open P&L, else balance) to the floor. */
  toDrawdownUsd: number;
  /** Distance to the daily loss limit; null when the account has none. */
  toDailyLimitUsd: number | null;
  /** Nearer of the two, before the cushion. */
  rawUsd: number;
  /** rawUsd less the cushion: what a ticket may lose on the worst plausible path. */
  usableUsd: number;
  binding: 'drawdown' | 'daily_limit';
  cushionPct: number;
  /** Non-empty = sizing is blocked until these rules are confirmed. */
  unverified: string[];
  blockReason: string | null;
  notes: string[];
}

export function accountRoom(rules: AccountRules, state: AccountStateInput, now: number): AccountRoom {
  const base = { accountId: rules.id, asOf: iso(now), cushionPct: CUSHION_PCT };
  const unverified = unverifiedRules(rules, state);
  if (unverified.length > 0) {
    return { ...base, floorUsd: NaN, toDrawdownUsd: 0, toDailyLimitUsd: null, rawUsd: 0, usableUsd: 0, binding: 'drawdown', unverified, notes: [],
      blockReason: `${rules.name}: no size until the ${unverified.length > 1 ? 'rules are' : 'rule is'} confirmed: ${unverified.join('; ')}.` };
  }
  const notes: string[] = [];
  const floorUsd = drawdownFloor(rules, state);
  const basis = rules.drawdown.includesOpenPnl ? state.equity : state.balance;
  const toDrawdownUsd = Math.max(0, basis - floorUsd);
  let toDailyLimitUsd: number | null = null;
  const dl = rules.dailyLoss;
  if (dl) {
    const limit = dl.amountUsd ?? ((dl.pctOfSnapshot ?? 0) / 100) * state.dayStartBalance;
    toDailyLimitUsd = Math.max(0, limit - (state.dayStartBalance - basis));
    const snap = lastSnapshot(rules, now);
    if (snap !== null && ms(state.asOf) < snap) notes.push(`Snapshot rolled ${etLabel(snap)} after the state was entered; day-start balance ${fmtUsd(state.dayStartBalance)} is stale.`);
  }
  const binding = toDailyLimitUsd !== null && toDailyLimitUsd < toDrawdownUsd ? 'daily_limit' : 'drawdown';
  const rawUsd = binding === 'daily_limit' ? (toDailyLimitUsd ?? 0) : toDrawdownUsd;
  let blockReason: string | null = null;
  if (rawUsd <= 0) {
    blockReason = binding === 'drawdown'
      ? `${rules.name}: ${fmtUsd(basis)} is at or under the ${fmtUsd(floorUsd)} floor. No room.`
      : `${rules.name}: daily loss limit is used up. No room until the next session.`;
    if (binding === 'drawdown' && rules.drawdown.amountUsd !== null && floorUsd - basis > 3 * rules.drawdown.amountUsd) blockReason += ` Balances here run on a ${fmtUsd(rules.startingBalance)} basis; check the number entered.`;
  }
  return { ...base, floorUsd, toDrawdownUsd, toDailyLimitUsd, rawUsd, usableUsd: rawUsd * (1 - CUSHION_PCT / 100), binding, unverified, blockReason, notes };
}

/** Fresh account at the starting balance. Inactive until the trader enters real numbers. */
export function defaultAccountState(rules: AccountRules, now: number): AccountState {
  const b = rules.startingBalance;
  return {
    accountId: rules.id, asOf: iso(now), active: false, balance: b, equity: b, highWaterBalance: b, dayStartBalance: b, dayPnl: 0,
    cyclePnl: 0, bestDayPnlInCycle: 0, qualifyingDaysInCycle: 0, cycleStartedAt: null, payoutsTaken: 0, lastTradeAt: null,
  };
}
