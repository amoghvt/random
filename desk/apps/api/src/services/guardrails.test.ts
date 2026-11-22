import { describe, expect, it } from 'vitest';
import { HOUR, KV, MIN, fromZoned, iso, type Position } from '@desk/contracts';
import { putAccountState } from './accounts';
import { readOnlyState } from './context';
import { acknowledgement, checkChat, checkTicket, guardrailContext, runGuardrails } from './guardrails';
import { testTicket } from './journal.testkit';
import { lastPrice } from './market';
import { hedgeViolations } from './positions';
import { desk, recordedDesk } from './recorded.testkit';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);
const NOW = et(17, 11, 0);
const SEED = { symbols: ['NQ', 'ES'] };

describe('guardrails service', () => {
  it('assembles the context from the journal and the recorded candles', async () => {
    const d = await recordedDesk(NOW, SEED);
    await putAccountState(d.deps, 'lucid-25k', { balance: 27_400 }, NOW);
    const ctx = await guardrailContext(d.deps, NOW);
    expect(ctx.tz).toBe('America/New_York');
    expect(ctx.candles.d1.NQ!.length).toBe(120);
    expect(ctx.candles.m1!.NQ!.every((c) => c.t <= NOW)).toBe(true);
    expect(ctx.accountRules).toHaveLength(9);
    expect(ctx.accountStates.find((s) => s.accountId === 'lucid-25k')?.balance).toBe(27_400);
    expect(ctx.ledger).toMatchObject({ monthToDateUsd: 0, instances: 0 });
    expect(ctx.reentry).toEqual([]);
    expect(ctx.medianNotional20).toBeNull();
    const flushes = ctx.confirmationDays!.NQ!;
    console.log(`[guardrails] NQ flushes on the recorded daily candles as of 2026-11-17: ${flushes.map((f) => `${f.flushDate} ${f.dropPct.toFixed(1)}%${f.confirmation ? '' : ' (unconfirmed)'}`).join(', ')}`);
    expect(flushes.at(-1)).toMatchObject({ flushDate: '2026-11-16', confirmation: null });
    expect(await acknowledgement(d.deps, NOW)).toBeNull();
  }, 60_000);

  it('chat: a bottom call fires once with the numbers and is journaled; a control message does not fire', async () => {
    const d = await recordedDesk(NOW, SEED);
    expect(await checkChat(d.deps, 'What is the 10Y doing into the auction?', NOW)).toEqual([]);
    const fired = await checkChat(d.deps, 'I feel like the bottom is in on NQ', NOW);
    expect(fired.map((f) => f.pattern)).toEqual(['bottom_call']);
    console.log(`[guardrails] bottom call: ${fired[0]!.text}`);
    expect(fired[0]!.trigger.kind).toBe('chat');
    expect(await d.store.list('guardrail_firings')).toHaveLength(1);
    // Said again in the same episode: the repeat is journaled and marked, not delivered as a second lecture.
    const again = await checkChat(d.deps, 'bottom is in, I am sure', NOW + 5 * MIN);
    expect(again.map((f) => [f.pattern, f.evidence.repeat])).toEqual([['bottom_call', true]]);
    expect(again[0]!.text).not.toBe(fired[0]!.text);
  }, 60_000);

  it('ticket: an opposite position on a second Vest account blocks the draft; previewing writes nothing', async () => {
    const d = await recordedDesk(NOW, SEED);
    const mark = (await lastPrice(d.deps, 'NQ', NOW))!.price;
    const long: Position = { id: 'pos_a', accountId: 'vest-instant', ticketId: null, instrument: 'NQ-PERP', direction: 'long', units: 20_000, entryPrice: mark, openedAt: iso(NOW - HOUR), liquidationPrice: null, leverage: 2 };
    await d.store.put('positions', [long]);
    const draft = testTicket('tkt_short', mark, NOW, { accountId: 'vest-eval', instrument: 'NQ-PERP', direction: 'short', status: 'planned', fills: [] });
    const hedges = await hedgeViolations(d.deps, NOW, { accountId: draft.accountId, instrument: draft.instrument, direction: draft.direction });
    const preview = await checkTicket(d.deps, draft, NOW, { hedgeViolations: hedges, save: false });
    const cross = preview.find((f) => f.pattern === 'cross_account_offset')!;
    console.log(`[guardrails] cross-account: ${cross.text}`);
    expect(cross.blocks).toBe(true);
    expect(await d.store.list('guardrail_firings')).toEqual([]);
    await checkTicket(d.deps, draft, NOW, { hedgeViolations: hedges });
    expect((await d.store.list('guardrail_firings')).map((f) => f.pattern)).toContain('cross_account_offset');
    // Control: the same draft with no opposite exposure does not fire the rule.
    const control = await checkTicket(d.deps, draft, NOW, { hedgeViolations: [], save: false });
    expect(control.some((f) => f.pattern === 'cross_account_offset')).toBe(false);
  }, 60_000);

  it('session: three plan-breaking trades in a day fire the circuit breaker once and leave the desk read-only until tomorrow', async () => {
    const d = await recordedDesk(NOW, SEED);
    const mark = (await lastPrice(d.deps, 'NQ', NOW))!.price;
    const broke = (id: string, minsAgo: number) => testTicket(id, mark, NOW, { overrides: [{ ts: iso(NOW - minsAgo * MIN), kind: 'moved_stop', reason: 'gave it room', pnlImpactUsd: null }] });
    await d.store.put('tickets', [broke('tkt_1', 90), broke('tkt_2', 60)]);
    const quiet = await runGuardrails(d.deps, NOW);
    expect(quiet.firings.filter((f) => f.pattern === 'circuit_breaker')).toEqual([]);
    expect((await readOnlyState(d.deps.store, NOW)).readOnly).toBe(false);

    await d.store.put('tickets', [broke('tkt_3', 5)]);
    const run = await runGuardrails(d.deps, NOW);
    const breaker = run.firings.find((f) => f.pattern === 'circuit_breaker')!;
    console.log(`[guardrails] breaker: ${breaker.text}`);
    expect(breaker.effect).toBe('read_only');
    expect(run.intents.map((i) => [i.class, i.reason])).toContainEqual(['P2', 'circuit_breaker']);
    const ro = await readOnlyState(d.deps.store, NOW);
    expect(ro).toEqual({ readOnly: true, until: iso(et(18, 0, 0)), reason: breaker.text });
    expect(await d.store.kvGet<string>(KV.readOnlyUntil)).toBe(iso(et(18, 0, 0)));

    // The next loop states nothing twice; the desk reopens on its own after midnight local.
    const next = await runGuardrails(d.deps, NOW + MIN);
    expect(next.firings.filter((f) => f.pattern === 'circuit_breaker')).toEqual([]);
    expect(next.intents).toEqual([]);
    expect((await d.store.list('guardrail_firings')).filter((f) => f.pattern === 'circuit_breaker')).toHaveLength(1);
    expect((await readOnlyState(d.deps.store, et(18, 0, 1))).readOnly).toBe(false);
  }, 60_000);

  it('runs clean on an empty store', async () => {
    const d = await desk(NOW);
    expect(await runGuardrails(d.deps, NOW)).toEqual({ firings: [], intents: [], flags: {} });
    expect(await checkChat(d.deps, 'long NQ into CPI?', NOW)).toEqual([]);
  });
});
