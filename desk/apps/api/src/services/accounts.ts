/** Account rules (YAML, with a kv override after a rule diff), AccountState docs and the account rows the UI renders. */
import { KV, AccountRules, iso, type AccountRow, type AccountState, type AccountStateBody, type Position, type RuleDiff } from '@desk/contracts';
import { sizing } from '@desk/engines';
import type { DeskDeps } from './context';

const yamlCache = new Map<string, AccountRules[]>();
function yamlRules(dir: string | undefined): AccountRules[] {
  const key = dir ?? sizing.ACCOUNTS_DIR;
  let rules = yamlCache.get(key);
  if (!rules) { rules = sizing.loadAccounts(key); yamlCache.set(key, rules); }
  return rules;
}

/** Rules for every account: the YAML files, with any account stored in kv `accounts.rules` replacing its file. */
export async function loadRules(deps: DeskDeps): Promise<AccountRules[]> {
  const files = yamlRules(deps.accountsDir);
  const stored = (await deps.store.kvGet<unknown[]>(KV.accountRules)) ?? [];
  const over = new Map<string, AccountRules>();
  for (const raw of stored) { const r = AccountRules.safeParse(raw); if (r.success) over.set(r.data.id, r.data); }
  return files.map((f) => over.get(f.id) ?? f);
}
export async function rulesById(deps: DeskDeps): Promise<Record<string, AccountRules>> {
  return Object.fromEntries((await loadRules(deps)).map((r) => [r.id, r]));
}

/**
 * A rule page changed. The numbers on file are from before the change and nothing here can read the new ones,
 * so the stored rules keep their values and carry the change as a firm-risk line until the trader confirms them.
 */
export async function applyRuleDiffs(deps: DeskDeps, diffs: RuleDiff[]): Promise<AccountRules[]> {
  if (diffs.length === 0) return [];
  const rules = await loadRules(deps);
  const changed: AccountRules[] = [];
  for (const r of rules) {
    const mine = diffs.filter((d) => d.accountIds.includes(r.id));
    if (mine.length === 0) continue;
    const lines = mine.map((d) => `Rule page changed ${d.detectedAt.slice(0, 10)} (${d.url}): ${d.added.length} added, ${d.removed.length} removed. Values on file predate it; confirm in the firm dashboard.`);
    const firmRisk = [...r.firmRisk, ...lines.filter((l) => !r.firmRisk.includes(l))];
    changed.push({ ...r, firmRisk });
  }
  if (changed.length === 0) return [];
  const ids = new Set(changed.map((c) => c.id));
  const stored = ((await deps.store.kvGet<AccountRules[]>(KV.accountRules)) ?? []).filter((r) => !ids.has(r.id));
  await deps.store.kvSet(KV.accountRules, [...stored, ...changed]);
  return changed;
}

export interface Account { rules: AccountRules; state: AccountState }

/** The stored state, or the inactive default at the starting balance when the trader has entered nothing. */
export async function accountState(deps: DeskDeps, rules: AccountRules, now: number): Promise<AccountState> {
  return (await deps.store.get('account_states', rules.id)) ?? sizing.defaultAccountState(rules, now);
}
export async function accounts(deps: DeskDeps, now: number): Promise<Account[]> {
  const rules = await loadRules(deps);
  const stored = new Map((await deps.store.list('account_states')).map((s) => [s.accountId, s]));
  return rules.map((r) => ({ rules: r, state: stored.get(r.id) ?? sizing.defaultAccountState(r, now) }));
}
export const activeAccounts = async (deps: DeskDeps, now: number): Promise<Account[]> => (await accounts(deps, now)).filter((a) => a.state.active);

/** Writes the numbers the trader entered. Entering a balance makes the account active unless told otherwise. */
export async function putAccountState(deps: DeskDeps, accountId: string, body: AccountStateBody, now: number): Promise<AccountRow> {
  const rules = (await loadRules(deps)).find((r) => r.id === accountId);
  if (!rules) throw new Error(`No account ${accountId}`);
  const prev = await deps.store.get('account_states', accountId);
  const base = prev ?? sizing.defaultAccountState(rules, now);
  const dayStart = body.dayStartBalance ?? (prev ? prev.dayStartBalance : body.balance);
  const next: AccountState = {
    ...base, accountId, asOf: iso(now), active: body.active ?? true,
    balance: body.balance, equity: body.equity ?? body.balance,
    highWaterBalance: Math.max(prev ? prev.highWaterBalance : body.balance, body.balance, body.equity ?? body.balance),
    dayStartBalance: dayStart, dayPnl: body.balance - dayStart,
    cyclePnl: body.cyclePnl ?? base.cyclePnl, bestDayPnlInCycle: body.bestDayPnlInCycle ?? base.bestDayPnlInCycle,
    qualifyingDaysInCycle: body.qualifyingDaysInCycle ?? base.qualifyingDaysInCycle, payoutsTaken: body.payoutsTaken ?? base.payoutsTaken,
    ...(body.startingBalance !== undefined ? { startingBalance: body.startingBalance } : base.startingBalance !== undefined ? { startingBalance: base.startingBalance } : {}),
  };
  await deps.store.put('account_states', [next]);
  return rowOf({ rules, state: next }, now);
}

export function rowOf(a: Account, now: number): AccountRow {
  return { rules: a.rules, state: a.state, ...sizing.accountRow(a.rules, a.state, now) };
}
export async function accountRows(deps: DeskDeps, now: number): Promise<AccountRow[]> {
  return (await accounts(deps, now)).map((a) => rowOf(a, now));
}

/** State with open P&L in `equity`: entered balance plus the marked P&L of what is open on the account. */
export function withOpenPnl(state: AccountState, openPnlUsd: number | null): AccountState {
  return openPnlUsd === null ? state : { ...state, equity: state.balance + openPnlUsd };
}
export const positionsOn = (positions: Position[], accountId: string): Position[] => positions.filter((p) => p.accountId === accountId);
