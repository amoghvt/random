import { describe, expect, it } from 'vitest';
import { KV, fromZoned, type AccountRules, type RuleDiff } from '@desk/contracts';
import { accountRows, accountState, accounts, activeAccounts, applyRuleDiffs, loadRules, putAccountState } from './accounts';
import { desk } from './recorded.testkit';

const NOW = fromZoned(2026, 11, 17, 11, 0);

describe('accounts service', () => {
  it('loads the nine rule files and gives every account an inactive default state until numbers are entered', async () => {
    const d = await desk(NOW);
    const rules = await loadRules(d.deps);
    expect(rules.map((r) => r.id)).toEqual(['apex-50k', 'lucid-25k', 'lucid-pro-50k', 'mffu-builder-50k', 'mffu-pro-50k', 'mffu-rapid-50k', 'tradeify-50k', 'vest-eval', 'vest-instant']);
    const all = await accounts(d.deps, NOW);
    expect(all.every((a) => !a.state.active)).toBe(true);
    expect(await activeAccounts(d.deps, NOW)).toEqual([]);
    const lucid = rules.find((r) => r.id === 'lucid-25k')!;
    expect(await accountState(d.deps, lucid, NOW)).toMatchObject({ accountId: 'lucid-25k', active: false, balance: 25_000, equity: 25_000 });
    expect(await d.store.list('account_states')).toEqual([]);
  });

  it('entering a balance activates the account and the row carries floor, room and the block reason', async () => {
    const d = await desk(NOW);
    const row = await putAccountState(d.deps, 'lucid-25k', { balance: 27_400 }, NOW);
    expect(row.state).toMatchObject({ active: true, balance: 27_400, equity: 27_400, highWaterBalance: 27_400, dayStartBalance: 27_400, dayPnl: 0 });
    // $1,000 trailing drawdown locked at $25,100: room is 27,400 - 25,100, usable is that less the 20% cushion.
    expect(row.floorUsd).toBe(25_100);
    expect(row.roomUsd).toBe(2_300);
    expect(row.usableUsd).toBe(1_840);
    expect(row.blockReason).toBeNull();
    const later = await putAccountState(d.deps, 'lucid-25k', { balance: 27_000 }, NOW + 60_000);
    expect(later.state).toMatchObject({ dayStartBalance: 27_400, dayPnl: -400, highWaterBalance: 27_400 });
    expect((await activeAccounts(d.deps, NOW)).map((a) => a.rules.id)).toEqual(['lucid-25k']);
    await expect(putAccountState(d.deps, 'no-such-account', { balance: 1 }, NOW)).rejects.toThrow('No account no-such-account');
  });

  it('Vest stays blocked until the trader enters the account size', async () => {
    const d = await desk(NOW);
    // Evaluation still has no confirmed size; Instant was confirmed at $10,000 on 2026-11-22.
    const blocked = await putAccountState(d.deps, 'vest-eval', { balance: 10_000 }, NOW);
    expect(blocked.blockReason).toMatch(/no size until the rule is confirmed: account size/);
    expect(blocked.usableUsd).toBe(0);
    const open = await putAccountState(d.deps, 'vest-eval', { balance: 10_000, startingBalance: 10_000 }, NOW);
    expect(open.blockReason).toBeNull();
    // 3% of the snapshot is the nearer limit: $300, $240 after the cushion.
    expect(open.usableUsd).toBe(240);
    const instant = await putAccountState(d.deps, 'vest-instant', { balance: 10_000 }, NOW);
    expect(instant.blockReason).toBeNull();
    // No daily limit on Instant: the $400 floor binds, $320 after the cushion.
    expect(instant.usableUsd).toBe(320);
    const rows = await accountRows(d.deps, NOW);
    expect(rows.find((r) => r.rules.id === 'apex-50k')?.blockReason).toMatch(/drawdown amount/);
  });

  it('a rule diff is written onto the stored rules of its accounts and survives a reload', async () => {
    const d = await desk(NOW);
    const diff: RuleDiff = { id: 'rulediff_test', accountIds: ['mffu-builder-50k'], firm: 'MyFundedFutures', url: 'https://help.myfundedfutures.com/x', detectedAt: '2026-11-17T07:30:00.000Z', summary: 'test diff', added: ['a'], removed: [] };
    const changed = await applyRuleDiffs(d.deps, [diff]);
    expect(changed.map((c) => c.id)).toEqual(['mffu-builder-50k']);
    const rules = await loadRules(d.deps);
    const builder = rules.find((r) => r.id === 'mffu-builder-50k')!;
    expect(builder.firmRisk.at(-1)).toBe('Rule page changed 2026-11-17 (https://help.myfundedfutures.com/x): 1 added, 0 removed. Values on file predate it; confirm in the firm dashboard.');
    expect(builder.dailyLoss?.amountUsd).toBe(1000);
    expect(rules.find((r) => r.id === 'lucid-25k')?.firmRisk.some((l) => l.startsWith('Rule page changed'))).toBe(false);
    await applyRuleDiffs(d.deps, [diff]);
    expect((await loadRules(d.deps)).find((r) => r.id === 'mffu-builder-50k')?.firmRisk.filter((l) => l.startsWith('Rule page changed')).length).toBe(1);
    expect((await d.store.kvGet<AccountRules[]>(KV.accountRules))?.length).toBe(1);
  });
});
