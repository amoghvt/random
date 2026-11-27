/**
 * The loop end to end on real recorded data: a MemoryStore seeded as of an instant, a fake clock, and feeds that
 * release the recording bar by bar. Account balances and positions entered here are the test's own inputs, as a
 * trader would type them; every price, yield and release value comes from data/recorded.
 */
import { describe, expect, it } from 'vitest';
import { KV, MIN, NotificationIntent, TradePlan, fromZoned, type CollectionName, type ListOpts, type Store } from '@desk/contracts';
import { bias } from '@desk/engines';
import { accountRows, loadRules, putAccountState } from './services/accounts';
import type { HealthRow } from './services/context';
import { lastPrice } from './services/market';
import { desk, recordedDesk } from './services/recorded.testkit';
import { backfillOnBoot, runDueJobs, runLoop, runRuleDiff, startWorker } from './worker';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);

describe('runLoop on the recorded Nov 17 2026 session', () => {
  it('11:00 ET: persists structure events, a bias call that replays from its inputs, a watcher update and the Now view', async () => {
    const at = et(17, 11, 0);
    const d = await recordedDesk(at);
    const r1 = await runLoop(d.deps, at);
    expect(r1.steps.filter((s) => !s.ok)).toEqual([]);
    expect(r1.steps.map((s) => s.name)).toEqual(['ingest', 'watcher', 'catalysts', 'session', 'bias', 'positions', 'tickets', 'guardrails', 'reminders', 'notifications', 'now', 'health']);

    const events = await d.store.list('structure_events', { instrument: 'NQ' });
    expect(events.length).toBeGreaterThan(100);
    expect(events.every((e) => Date.parse(e.ts) <= at)).toBe(true);

    const call = (await d.store.list('bias_calls', { instrument: 'NQ', status: 'intraday' }))[0]!;
    const px = await lastPrice(d.deps, 'NQ', at);
    expect(px?.stale).toBe(false);
    expect(call.referencePrice).toBe(px?.price);
    expect(call.probability).toBeGreaterThanOrEqual(0.5);
    expect(call.probability).toBeLessThanOrEqual(0.85);
    expect(call.facts.length).toBeGreaterThan(0);
    expect(bias.storedInputs(call)?.features.instrument).toBe('NQ');
    expect(bias.replayCall(call).id).toBe(call.id);
    expect(r1.now?.primary?.id).toBe(call.id);
    expect(r1.now?.rates.y10.value).toBeGreaterThan(3);
    expect(r1.now?.rates.y10.source).toBe('yahoo:recorded');

    // Same instant again: no new fact, so no new call and no second copy of any notification.
    const again = await runLoop(d.deps, at);
    expect(again.calls).toEqual([]);
    expect(again.notifications).toEqual([]);

    let updates = 0;
    for (const t of [at + MIN, at + 2 * MIN, at + 3 * MIN]) {
      d.clock.t = t;
      const r = await runLoop(d.deps, t);
      expect(r.steps.filter((s) => !s.ok)).toEqual([]);
      expect(r.ingest?.written.candle).toBeGreaterThan(0);
      updates += r.updates;
    }
    const stored = await d.store.list('watcher_updates');
    expect(stored.length).toBe(updates);
    expect(updates).toBeGreaterThan(0);
    for (const u of stored) { expect(u.text.length).toBeLessThanOrEqual(280); expect(u.text).toMatch(/^[A-Z0-9]+ [\d,.]+/); }
    expect(await d.store.kvGet<string>(KV.lastLoop)).toBe(new Date(at + 3 * MIN).toISOString());
    const health = (await d.store.kvGet<HealthRow[]>(KV.feedHealth)) ?? [];
    expect(health.filter((h) => h.feed.startsWith('worker:')).every((h) => h.ok)).toBe(true);
  }, 120_000);
});

describe('runLoop across the real Nov 10 2026 CPI release (08:30 ET, core 0.3% vs 0.2% consensus)', () => {
  it('writes the matrix the night before, matches the branch when the actual appears and pushes a P0 with a sized, pre-filled ticket', async () => {
    const eve = et(9, 20, 5);
    const d = await recordedDesk(eve);
    // The trader's own numbers: Lucid 25K with profits above the locked floor, and a Vest Instant account of $10,000.
    await putAccountState(d.deps, 'lucid-25k', { balance: 27_400 }, eve);
    await putAccountState(d.deps, 'vest-instant', { balance: 10_000, startingBalance: 10_000 }, eve);

    await runLoop(d.deps, eve);
    const planned = (await d.store.list('catalysts')).find((c) => c.code === 'CPI')!;
    expect(planned.tier).toBe(1);
    expect(planned.status).toBe('upcoming');
    expect(planned.keyedOn).toBe('CORE_CPI');
    expect(planned.consensus).toBe(0.2);
    expect(planned.history.length).toBe(8);
    expect(planned.matrix?.branches.map((b) => b.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    const hot = planned.matrix!.branches.find((b) => b.id === 'C')!;
    expect(hot.label).toBe('Hot: 0.3%');
    expect(hot.trade?.direction).toBe('short');
    expect(hot.trade?.accountId).toBeDefined();
    expect(hot.trade?.size?.units).toBeGreaterThan(0);

    const before = et(10, 8, 29), after = et(10, 8, 31);
    for (const t of [et(10, 6, 1), et(10, 7, 35), before]) { d.clock.t = t; expect((await runLoop(d.deps, t)).steps.filter((s) => !s.ok)).toEqual([]); }
    const t60 = (await d.store.list('notifications')).find((n) => n.reason === 'catalyst_t60');
    expect(t60?.decision).toBe('sent');
    const pre = (await d.store.get('catalysts', planned.id))!;
    expect(pre.resolution).toBeNull();
    // 06:00 ET run: the matrix was regenerated on the morning's price.
    expect(Date.parse(pre.matrix!.generatedAt)).toBe(et(10, 6, 1));
    expect((await d.store.list('notifications')).some((n) => n.reason === 'tier1_resolved')).toBe(false);

    d.clock.t = after;
    const r = await runLoop(d.deps, after);
    expect(r.steps.filter((s) => !s.ok)).toEqual([]);
    expect(r.matched.map((c) => c.id)).toEqual([planned.id]);
    const resolved = (await d.store.get('catalysts', planned.id))!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toMatchObject({ actual: 0.3, branchId: 'C' });
    expect(resolved.secondary?.actual).toBe(0.4);

    const p0 = r.notifications.find((n) => n.reason === 'tier1_resolved')!;
    expect(p0.class).toBe('P0');
    expect(p0.decision).toBe('sent');
    expect(p0.channels).toContain('webpush');
    expect(p0.lines[0]).toContain('Core CPI 0.3% vs 0.2%');
    expect(p0.deepLink).toBe(`/ticket?prefill=${p0.id}`);
    expect(NotificationIntent.safeParse(p0).success).toBe(true);
    const prefill = p0.ticketPrefill!;
    expect(TradePlan.safeParse(prefill).success).toBe(true);
    expect(prefill.reason).toEqual({ kind: 'catalyst', catalystId: planned.id, branchId: 'C' });
    expect(prefill.direction).toBe('short');
    expect(['lucid-25k', 'vest-instant']).toContain(prefill.accountId);
    expect(prefill.size!.units).toBeGreaterThan(0);
    expect(prefill.size!.failPrice).toBeGreaterThan(prefill.invalidation.price);
    expect(p0.lines.join(' ')).toContain(prefill.accountId!);
    expect(d.pushed.some((p) => p.payload.tag === p0.dedupeKey && p.payload.class === 'P0')).toBe(true);
    expect(d.feed.some((n) => n.id === p0.id)).toBe(true);

    // The next loops push nothing twice, and the reaction clock fills in from the recorded 5m bars.
    for (const t of [et(10, 8, 36), et(10, 8, 46), et(10, 9, 31)]) { d.clock.t = t; await runLoop(d.deps, t); }
    expect((await d.store.list('notifications')).filter((n) => n.reason === 'tier1_resolved').length).toBe(1);
    const clocked = (await d.store.get('catalysts', planned.id))!;
    expect(clocked.reaction?.m5Pct).toBeLessThan(0);
    expect(clocked.reaction?.m15Pct).toBeLessThan(0);
    expect(clocked.reaction?.verdict).not.toBeNull();
    expect(clocked.resolution?.branchId).toBe('C');
  }, 180_000);

  it('with no active account the P0 still goes out, unsized, and says so', async () => {
    const eve = et(9, 20, 5);
    const d = await recordedDesk(eve);
    await runLoop(d.deps, eve);
    const cpi = (await d.store.list('catalysts')).find((c) => c.code === 'CPI')!;
    expect(cpi.matrix?.regimeNotes).toContain('No active account with a balance entered: trades are unsized.');
    expect(cpi.matrix?.branches.every((b) => !b.trade?.size)).toBe(true);
    d.clock.t = et(10, 8, 31);
    const r = await runLoop(d.deps, d.clock.t);
    const p0 = r.notifications.find((n) => n.reason === 'tier1_resolved')!;
    expect(p0.decision).toBe('sent');
    expect(p0.ticketPrefill).toBeUndefined();
    expect(p0.lines[2]).toBe('Plan has no account or size yet. Size it on the card.');
    expect(p0.deepLink).toBe(`/catalysts?id=${cpi.id}`);
  }, 120_000);
});

describe('runLoop edge cases', () => {
  it('runs clean on an empty store with no feeds', async () => {
    const at = et(17, 11, 0);
    const d = await desk(at);
    const r = await runLoop(d.deps, at);
    expect(r.steps.filter((s) => !s.ok)).toEqual([]);
    expect(r.notifications).toEqual([]);
    expect(r.now?.primary).toBeNull();
    expect(r.now?.rates.y10).toMatchObject({ value: null, stale: true });
    expect(r.now?.nextCatalyst).toBeNull();
    const jobs = await runDueJobs(d.deps, at);
    expect(jobs.baseRates).toBe(0);
    expect(jobs.briefs).toContain('morning:2026-11-17');
    expect(d.log.lines.filter((l) => l.startsWith('error'))).toEqual([]);
  }, 60_000);

  it('isolates a failing step: the rest still run and the failure lands in feed health', async () => {
    const at = et(17, 11, 0);
    const d = await recordedDesk(at, { symbols: ['NQ', 'ES', 'US10Y', 'VIX'] });
    const store: Store = new Proxy(d.store, {
      get(target, prop) {
        if (prop === 'list') {
          return <K extends CollectionName>(c: K, o?: ListOpts) => (c === 'predictions' ? Promise.reject(new Error('predictions table offline')) : target.list(c, o));
        }
        const v: unknown = Reflect.get(target, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const r = await runLoop({ ...d.deps, store }, at);
    expect(r.steps.filter((s) => !s.ok).map((s) => s.name)).toEqual(['catalysts']);
    expect(r.steps.find((s) => s.name === 'catalysts')?.error).toBe('predictions table offline');
    expect((await d.store.list('bias_calls', { instrument: 'NQ' })).length).toBe(3);
    const health = (await d.store.kvGet<HealthRow[]>(KV.feedHealth)) ?? [];
    expect(health.find((h) => h.feed === 'worker:catalysts')).toMatchObject({ ok: false, error: 'predictions table offline', lastOk: null });
    expect(health.find((h) => h.feed === 'worker:bias')?.ok).toBe(true);
    expect(d.log.lines.some((l) => l.startsWith('error worker: catalysts failed'))).toBe(true);
  }, 60_000);

  it('kill switch: nothing runs but the position monitor, and only a Critical position pushes', async () => {
    const at = et(17, 11, 0);
    const d = await recordedDesk(at, { symbols: ['NQ', 'ES', 'US10Y', 'VIX'] });
    await putAccountState(d.deps, 'vest-instant', { balance: 10_000, startingBalance: 10_000 }, at);
    const mark = (await lastPrice(d.deps, 'NQ-PERP', at))!.price;
    // A 50x long entered by the trader: the venue liquidation sits 0.6% under the entry.
    await d.store.put('positions', [{ id: 'pos_test_50x', accountId: 'vest-instant', ticketId: null, instrument: 'NQ-PERP', direction: 'long', units: 500_000, entryPrice: mark, openedAt: new Date(at - 10 * MIN).toISOString(), liquidationPrice: mark * 0.994, leverage: 50 }]);
    await d.store.kvSet(KV.killSwitch, true);
    const r = await runLoop(d.deps, at);
    expect(r.killSwitch).toBe(true);
    expect(r.steps.map((s) => s.name)).toEqual(['ingest', 'positions', 'notifications', 'now', 'health']);
    expect(r.ingest?.polled).toEqual([]);
    expect(await d.store.list('bias_calls')).toEqual([]);
    expect(await d.store.list('structure_events')).toEqual([]);
    expect(r.notifications.map((n) => [n.class, n.reason, n.decision])).toEqual([['P0', 'position_critical', 'sent']]);
    expect(r.notifications[0]!.lines[0]).toContain('Critical on vest-instant');
    expect(r.now?.session.killSwitch).toBe(true);

    // Inside the 5-minute spacing the same Critical leaves no second record; after it, it repeats.
    d.clock.t = at + MIN;
    expect((await runLoop(d.deps, d.clock.t)).notifications).toEqual([]);
    d.clock.t = at + 6 * MIN;
    expect((await runLoop(d.deps, d.clock.t)).notifications.map((n) => n.decision)).toEqual(['sent']);
  }, 60_000);
});

describe('scheduled jobs', () => {
  it('registers the loop and the clock jobs, and stops', async () => {
    const d = await desk(et(17, 11, 0));
    const w = await startWorker(d.deps);
    expect(d.deps.scheduler.jobs().map((j) => j.name).sort()).toEqual([
      'base-rates', 'brief-morning', 'brief-recap', 'brief-regen', 'brief-weekly', 'calibration', 'due-jobs', 'loop', 'matrices-evening', 'matrices-morning', 'refit', 'rule-diff',
    ]);
    expect(d.deps.scheduler.jobs().find((j) => j.name === 'brief-morning')?.schedule).toBe('06:30 America/New_York');
    const run = await d.deps.scheduler.runNow('loop');
    expect(run.status).toBe('ok');
    expect(await d.store.kvGet<string>(KV.lastLoop)).toBe(new Date(et(17, 11, 0)).toISOString());
    await w.stop();
  });

  it('nightly rule diff: a changed rule page raises a P0 and marks the stored rules (synthetic rule page)', async () => {
    const at = et(17, 2, 30);
    const d = await desk(at);
    const page = (limit: string): string => `<html><body><main><p>Synthetic rule page for the test.</p><p>The daily loss limit is ${limit} on every plan.</p><p>Hedging across accounts is prohibited.</p><p>Positions must be flat by the session close.</p></main></body></html>`;
    let limit = '$1,000';
    const deps = { ...d.deps, fetch: async (): Promise<Response> => new Response(page(limit), { status: 200 }) };
    const first = await runRuleDiff(deps, at);
    expect(first.diffs).toEqual([]);
    expect(first.notifications).toEqual([]);

    limit = '$750';
    d.clock.t = at + 24 * 60 * MIN;
    const second = await runRuleDiff(deps, d.clock.t);
    expect(second.diffs.length).toBeGreaterThan(0);
    expect(second.diffs[0]!.added[0]).toBe('The daily loss limit is $750 on every plan.');
    expect(second.notifications.length).toBe(second.diffs.length);
    expect(second.notifications.every((n) => n.class === 'P0' && n.reason === 'rule_change')).toBe(true);
    // Two pages of one firm changing the same way read identically: the second is the same content and is held back.
    expect(second.notifications.filter((n) => n.decision === 'suppressed').every((n) => n.suppressedBy === 'duplicate_content')).toBe(true);
    const firms = new Set(second.diffs.map((x) => x.firm));
    expect(second.notifications.filter((n) => n.decision === 'sent').length).toBeGreaterThanOrEqual(firms.size);
    const rules = await loadRules(deps);
    const flagged = rules.filter((r) => r.firmRisk.some((l) => l.startsWith('Rule page changed 2026-11-18')));
    expect(flagged.map((r) => r.id).sort()).toEqual([...new Set(second.diffs.flatMap((x) => x.accountIds))].sort());
    // The numbers on file are untouched: nothing here can read the new ones.
    expect(rules.find((r) => r.id === 'mffu-builder-50k')?.dailyLoss?.amountUsd).toBe(1000);
    expect((await accountRows(deps, d.clock.t)).length).toBe(9);
  });

  it('boot backfill is skipped when the store already holds a recent daily series', async () => {
    const at = et(17, 11, 0);
    const d = await recordedDesk(at, { symbols: ['NQ'], tfs: ['1d'] });
    const deps = { ...d.deps, fetch: async (): Promise<Response> => { throw new Error('network must not be reached'); } };
    expect(await backfillOnBoot(deps, at)).toBe(0);
  });
});
