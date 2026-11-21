import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { AccountRules, Profile } from '@desk/contracts';
import { ACCOUNTS_DIR, loadAccounts, parseWeeklyET, unverifiedRules } from './index';
import { rulesOf } from './testkit';

const all = loadAccounts();
const SPEC = 'trader spec 2026-11-21';

describe('accounts/*.yaml', () => {
  it('every YAML validates against the AccountRules schema', () => {
    expect(all.length).toBe(9);
    for (const r of all) expect(AccountRules.safeParse(r).success, r.id).toBe(true);
  });

  it('there is one file per account id in profile.yaml', () => {
    const profile = Profile.parse(parse(readFileSync(join(ACCOUNTS_DIR, '../profile.yaml'), 'utf8')));
    expect(all.map((r) => r.id).sort()).toEqual([...profile.accounts].sort());
  });

  it('every file carries its source: origin, as-of date and at least one URL for the nightly diff', () => {
    for (const r of all) {
      expect(r.source.origin.startsWith(SPEC), r.id).toBe(true);
      expect(r.source.asOf, r.id).toBe('2026-11-21');
      expect(r.source.urls.length, r.id).toBeGreaterThan(0);
      for (const u of r.source.urls) expect(u, r.id).toMatch(/^https:\/\/[a-z0-9.-]+\//);
    }
  });

  it('every null drawdown or daily-loss amount says it is unverified', () => {
    for (const r of all) {
      if (r.drawdown.amountUsd === null && r.drawdown.pct === null) expect(r.drawdown.text, r.id).toContain('unverified, confirm in the firm dashboard');
      if (r.dailyLoss && r.dailyLoss.amountUsd === null && r.dailyLoss.pctOfSnapshot === null) expect(r.dailyLoss.text, r.id).toContain('unverified, confirm in the firm dashboard');
    }
    expect(all.filter((r) => unverifiedRules(r).length > 0).map((r) => r.id).sort()).toEqual(['apex-50k', 'tradeify-50k', 'vest-eval', 'vest-instant']);
  });

  it('all firms prohibit cross-account hedging, with a clause to quote', () => {
    for (const r of all) expect(r.prohibited.find((p) => p.rule === 'cross_account_hedging')?.clause.length ?? 0, r.id).toBeGreaterThan(20);
  });

  it('CME firms flatten before 16:00 ET; Vest has the weekend lock instead', () => {
    for (const r of all) {
      if (r.venue === 'cme') { expect(r.session.flattenByET, r.id).toBe('16:00'); expect(r.session.weekendLock, r.id).toBeNull(); }
      else { expect(r.session.flattenByET, r.id).toBeNull(); expect(r.session.weekendLock, r.id).not.toBeNull(); }
    }
  });

  it('Vest: the section 7 rules as stated', () => {
    for (const id of ['vest-instant', 'vest-eval']) {
      const r = rulesOf(id);
      expect(r.source.origin).toBe(SPEC);
      expect(r.venue).toBe('perp');
      expect(r.drawdown).toMatchObject({ type: 'static', pct: 6, amountUsd: null, includesOpenPnl: true, locksAtBalance: null });
      expect(r.dailyLoss).toMatchObject({ pctOfSnapshot: 3, snapshotET: '20:00', hardBreach: true });
      expect(r.leverage.caps['NQ-PERP']).toBe(50);
      expect(r.leverage.eventCutText).toMatch(/lifted one minute after release/);
      expect(r.session.weekendLock).toMatchObject({ fromET: 'Fri 20:00', toET: 'Sun 18:00' });
      expect(parseWeeklyET(r.session.weekendLock!.fromET)).toEqual({ weekday: 5, hour: 20, minute: 0 });
      expect(r.prohibited.map((p) => p.rule)).toEqual(['cross_account_hedging', 'stop_entry_orders']);
      expect(r.prohibited[0]!.clause).toBe('Vest: coordinating accounts incl. opposite positions is prohibited.');
      expect(r.payout).toMatchObject({ capUsd: null, cycleDays: null, qualifyingDays: null, consistencyPct: null });
      expect(r.payout.text).toMatch(/No cap, no schedule, claim anytime/);
      expect(r.firmRisk.join(' ')).toMatch(/Panama-law counterparty; liability capped at fees paid/);
      expect(r.claimPromptGainPct).toBe(25);
      expect(r.markDivergencePts).toEqual([10, 40]);
    }
  });

  it('MFFU: Builder, Rapid and Pro', () => {
    const b = rulesOf('mffu-builder-50k');
    expect(b.drawdown).toMatchObject({ type: 'eod_trailing', lockedFloor: b.startingBalance + 100 });
    expect(b.dailyLoss?.amountUsd).toBe(1_000);
    expect(b.payout).toMatchObject({ capUsd: 2_000, qualifyingDays: 2, consistencyPct: 50, bufferUsd: 2_100 });
    const p = rulesOf('mffu-pro-50k');
    expect(p.payout).toMatchObject({ cycleDays: 14, minUsd: 1_000, consistencyPct: 60, bufferUsd: 2_100 });
    expect(p.prohibited.some((x) => x.rule === 'news_trading')).toBe(true);
    const r = rulesOf('mffu-rapid-50k');
    expect(r.drawdown.type).toBe('intraday_trailing');
    expect(r.drawdown.text).toContain('(firm help center, read 2026-11-21)');
    expect(r.payout.bufferUsd).toBe(2_100);
    for (const x of [b, p, r]) expect(x.inactivityDays, x.id).toBe(7);
  });

  it('Apex, Lucid and Tradeify', () => {
    const a = rulesOf('apex-50k');
    expect(a.drawdown.type).toBe('intraday_trailing');
    expect(a.startingBalance + a.payout.bufferUsd!).toBe(52_100); // Safety Net
    expect(a.payout).toMatchObject({ qualifyingDays: 5, consistencyPct: 50, maxPayouts: 6, capUsd: 3_000 });
    expect(a.payout.text).toMatch(/Safety Net \$52,100 for life/);
    expect(a.payout.text).toMatch(/\$1,500 to \$3,000 ladder/);
    const l = rulesOf('lucid-25k');
    expect(l.drawdown).toMatchObject({ amountUsd: 1_000, lockedFloor: 25_100 });
    expect(l.dailyLoss).toBeNull();
    const lp = rulesOf('lucid-pro-50k');
    expect(lp.payout).toMatchObject({ qualifyingDays: 3, consistencyPct: 40, ladderUsd: [2_000, 2_500] });
    for (const id of ['lucid-25k', 'lucid-pro-50k', 'tradeify-50k']) {
      const scalp = rulesOf(id).prohibited.find((x) => x.rule === 'micro_scalping');
      expect(scalp?.clause, id).toMatch(/No scalps under 5 to 10 seconds/);
      expect(scalp?.minHoldSec, id).toBeGreaterThanOrEqual(5);
      expect(scalp?.minHoldSec, id).toBeLessThanOrEqual(10);
    }
  });

  it('a bad file fails loudly with its name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-accounts-'));
    try {
      expect(loadAccounts(dir)).toEqual([]);
      const good = readFileSync(join(ACCOUNTS_DIR, 'lucid-25k.yaml'), 'utf8');
      writeFileSync(join(dir, 'lucid-25k.yaml'), good);
      expect(loadAccounts(dir).map((r) => r.id)).toEqual(['lucid-25k']);
      writeFileSync(join(dir, 'broken.yaml'), good.replace('venue: cme', 'venue: moon'));
      expect(() => loadAccounts(dir)).toThrow(/accounts\/broken\.yaml: venue/);
      writeFileSync(join(dir, 'broken.yaml'), good);
      expect(() => loadAccounts(dir)).toThrow(/id "lucid-25k" does not match the file name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
