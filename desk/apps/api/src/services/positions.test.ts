import { describe, expect, it } from 'vitest';
import { HOUR, KV, MIN, fromZoned, iso, type Position, type PositionStatus } from '@desk/contracts';
import { notify, tickets as tk } from '@desk/engines';
import { putAccountState } from './accounts';
import { testTicket } from './journal.testkit';
import { fineCandles, lastPrice } from './market';
import { hedgeViolations, positionsView, runPositions, runTickets, storedHeld } from './positions';
import { desk, recordedDesk } from './recorded.testkit';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);
const NOW = et(17, 11, 0);
const SYMBOLS = { symbols: ['NQ', 'ES', 'NVDA'] };

/** A position as the trader would have entered it; the mark it is built around is the recorded one. */
const perp = (id: string, accountId: string, direction: Position['direction'], entryPrice: number, over: Partial<Position> = {}): Position =>
  ({ id, accountId, ticketId: null, instrument: 'NQ-PERP', direction, units: 500_000, entryPrice, openedAt: iso(NOW - 10 * MIN), liquidationPrice: null, leverage: 50, ...over });

describe('positions service', () => {
  it('a 50x Vest long with the fail price 0.6% away is Critical and raises the position P0; a position with no mark gets no status', async () => {
    const d = await recordedDesk(NOW, SYMBOLS);
    await putAccountState(d.deps, 'vest-instant', { balance: 10_000, startingBalance: 10_000 }, NOW);
    const mark = (await lastPrice(d.deps, 'NQ-PERP', NOW))!.price;
    await d.store.put('positions', [
      perp('pos_50x', 'vest-instant', 'long', mark, { liquidationPrice: mark * 0.994 }),
      { ...perp('pos_gold', 'vest-instant', 'long', 4000), instrument: 'GC', units: 1, leverage: null },
    ]);
    const run = await runPositions(d.deps, NOW);
    expect(run.unmarked.map((p) => p.id)).toEqual(['pos_gold']);
    expect(run.held.map((h) => h.position.id)).toEqual(['pos_50x']);
    const s = run.held[0]!.status;
    console.log(`[positions] 50x NQ-PERP long at ${mark}: ${s.status}, fail ${s.failPrice}, ${s.distancePct}% away. ${s.line}`);
    expect(s.status).toBe('Critical');
    expect(s.mark).toBe(mark);
    expect(s.distancePct).toBeLessThanOrEqual(0.6);
    expect(run.intents.map((i) => [i.class, i.reason])).toEqual([['P0', notify.POSITION_CRITICAL]]);
    expect(Object.keys((await d.store.kvGet<Record<string, PositionStatus>>(KV.positionStatus)) ?? {})).toEqual(['pos_50x']);
    expect((await storedHeld(d.deps)).map((h) => h.position.id)).toEqual(['pos_50x']);
    const view = await positionsView(d.deps, NOW);
    expect(view.positions.find((p) => p.position.id === 'pos_gold')?.status).toBeNull();
    expect(view.accounts).toHaveLength(9);
  }, 60_000);

  it('opposite NQ exposure on two accounts is a hedge violation, before and after the second order', async () => {
    const d = await recordedDesk(NOW, { ...SYMBOLS, tfs: ['1d'] });
    const mark = (await lastPrice(d.deps, 'NQ', NOW))!.price;
    await d.store.put('positions', [perp('pos_a', 'vest-instant', 'long', mark)]);
    expect(await hedgeViolations(d.deps, NOW)).toEqual([]);
    const pending = await hedgeViolations(d.deps, NOW, { accountId: 'vest-eval', instrument: 'NQ-PERP', direction: 'short' });
    expect(pending).toHaveLength(1);
    console.log(`[positions] hedge: ${pending[0]!.text}`);
    expect(await hedgeViolations(d.deps, NOW, { accountId: 'vest-eval', instrument: 'NQ-PERP', direction: 'long' })).toEqual([]);
    await d.store.put('positions', [perp('pos_b', 'vest-eval', 'short', mark)]);
    expect((await hedgeViolations(d.deps, NOW)).length).toBe(1);
    expect((await positionsView(d.deps, NOW)).hedgeViolations).toHaveLength(1);
  }, 60_000);

  it('tickets: an invalidation that has traded raises its P0 and is written as an undeclared deviation; a closed trade settles from the recorded candles', async () => {
    const d = await recordedDesk(NOW, SYMBOLS);
    const mark = (await lastPrice(d.deps, 'MNQ', NOW))!.price;
    // Long from 100 points above the recorded mark with the invalidation 80 under the entry: it has already traded through.
    const held = testTicket('tkt_held', mark + 100, NOW);
    // A second ticket entered at the mark an hour ago and closed by the trader 30 minutes ago.
    const entryTs = NOW - HOUR, exitTs = NOW - 30 * MIN;
    const open = testTicket('tkt_done', mark, NOW, { fills: [{ ts: iso(entryTs), price: mark, units: 1, kind: 'entry', source: 'manual' }], timeStop: iso(NOW - 10 * MIN) });
    const during = (await fineCandles(d.deps, 'MNQ', entryTs, exitTs)).filter((c) => c.t >= entryTs);
    const exit = during.at(-1)!.c;
    const closed = tk.closeTicket(open, { price: exit, ts: exitTs }, during);
    expect(closed.result?.mfeAfterExitPct).toBeNull();
    await d.store.put('tickets', [held, closed]);

    const run = await runTickets(d.deps, NOW);
    expect(run.intents.map((i) => i.reason)).toContain('ticket_invalidation');
    const p0 = run.intents.find((i) => i.reason === 'ticket_invalidation')!;
    console.log(`[tickets] ${p0.class} ${p0.lines.join(' / ')}`);
    expect(p0.class).toBe('P0');
    expect(p0.deepLink).toBe('/positions?id=tkt_held');
    const after = (await d.store.get('tickets', 'tkt_held'))!;
    expect(after.overrides.map((o) => o.kind)).toContain('held_through_invalidation');
    expect(after.overrides.every((o) => o.reason.startsWith(tk.UNDECLARED))).toBe(true);
    // Stated once: the next loop adds no second copy.
    await runTickets(d.deps, NOW + MIN);
    expect((await d.store.get('tickets', 'tkt_held'))!.overrides).toHaveLength(after.overrides.length);

    const settled = (await d.store.get('tickets', 'tkt_done'))!;
    console.log(`[tickets] closed ${mark} -> ${exit}: P&L ${settled.result?.pnlUsd} USD, adherence ${settled.result?.adherence}, after exit MFE ${settled.result?.mfeAfterExitPct}% MAE ${settled.result?.maeAfterExitPct}%, capture ${settled.result?.capturePct}`);
    expect(run.settled.map((t) => t.id)).toEqual(['tkt_done']);
    expect(settled.result?.mfeAfterExitPct).not.toBeNull();
    expect(settled.result?.maeAfterExitPct).not.toBeNull();
  }, 60_000);

  it('runs clean with nothing open', async () => {
    const d = await desk(NOW);
    expect(await runPositions(d.deps, NOW)).toEqual({ held: [], unmarked: [], intents: [] });
    expect(await runTickets(d.deps, NOW)).toEqual({ intents: [], deviated: [], settled: [] });
    expect((await positionsView(d.deps, NOW)).positions).toEqual([]);
  });
});
