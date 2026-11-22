import { describe, expect, it } from 'vitest';
import { HOUR, MIN, fromZoned, hashId, iso, type Headline, type Store } from '@desk/contracts';
import { loadRecordedCalendar } from '@desk/feeds';
import { putAccountState } from './accounts';
import { generateMatrices, matrixDue, nextCatalyst, refreshCatalysts, regime, runCatalysts } from './catalysts';
import { candleReader } from './market';
import { calendarEventAt, desk, recorded, recordedDesk } from './recorded.testkit';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);
const EVE = et(9, 20, 5);

/** The recorded calendar as the feed shows it at `at`: an actual appears once its release time has passed. */
async function calendarAt(store: Store, at: number): Promise<void> {
  await store.put('calendar', loadRecordedCalendar().map((r) => calendarEventAt(r, at)));
}

describe('catalysts service on the recorded calendar', () => {
  it('builds tiered catalysts with history from stored candles, and a matrix only when one is due', async () => {
    const d = await recordedDesk(EVE);
    const reg = await regime(d.deps, EVE);
    console.log(`[catalysts] regime 2026-11-09 20:05 ET: ${JSON.stringify(reg)}`);
    expect(reg?.hikeProb).toBeNull();
    const r = await refreshCatalysts(d.deps, EVE);
    const cpi = r.catalysts.find((c) => c.code === 'CPI')!;
    expect(cpi).toMatchObject({ tier: 1, status: 'upcoming', keyedOn: 'CORE_CPI', consensus: 0.2, prior: 0.3, matrix: null, source: 'tradingview:recorded' });
    expect(cpi.scheduledAt).toBe(iso(et(10, 8, 30)));
    expect(cpi.history.length).toBe(8);
    expect(cpi.history.every((h) => Date.parse(h.date) < EVE && h.h1Pct !== null)).toBe(true);
    expect(cpi.impliedMovePct).toBeGreaterThan(0);
    expect(cpi.impliedMoveSource).not.toBeNull();
    expect(matrixDue(cpi, EVE)).toBe('missing');
    expect(matrixDue(cpi, et(8, 8, 0))).toBeNull();
    const tier3 = r.catalysts.find((c) => c.tier === 3)!;
    expect(matrixDue(tier3, Date.parse(tier3.scheduledAt) - HOUR)).toBeNull();

    const run = await generateMatrices(d.deps, EVE, { catalysts: r.catalysts });
    const withMatrix = run.generated.find((c) => c.id === cpi.id)!;
    expect(matrixDue(withMatrix, EVE + MIN)).toBeNull();
    expect(matrixDue(withMatrix, et(10, 6, 0))).toBe('06:00 ET run');
    expect(matrixDue({ ...withMatrix, consensus: 0.3 }, EVE + MIN)).toBe('consensus changed');
    const sum = withMatrix.matrix!.branches.reduce((a, b) => a + b.probability, 0);
    console.log(`[catalysts] CPI matrix: ${withMatrix.matrix!.branches.map((b) => `${b.id} ${b.label} ${b.probability} (${b.probabilitySource})`).join('; ')}`);
    expect(sum).toBeCloseTo(1, 2);
    expect(withMatrix.matrix!.branches.every((b) => b.probability <= 0.85)).toBe(true);
    expect((await nextCatalyst(d.deps, EVE))?.id).toBeDefined();
    // A second refresh keeps the matrix and writes nothing new for an unchanged catalyst.
    const again = await refreshCatalysts(d.deps, EVE);
    expect(again.catalysts.find((c) => c.id === cpi.id)?.matrix?.generatedAt).toBe(iso(EVE));
    expect(again.matched).toEqual([]);
  }, 120_000);

  it('a wire headline with the print resolves the catalyst before the calendar shows the actual', async () => {
    const d = await recordedDesk(EVE);
    await putAccountState(d.deps, 'lucid-25k', { balance: 27_400 }, EVE);
    await runCatalysts(d.deps, EVE);
    const at = et(10, 8, 30) + 20_000;
    d.clock.t = at;
    await d.store.upsertCandles(recorded('NQ', '5m').filter((c) => c.t + 5 * MIN > EVE && c.t + 5 * MIN <= at));
    // The wire line is the test's; its numbers are the recorded release (core 0.3 vs 0.2, headline 0.4 vs 0.3).
    const title = 'US Core CPI MoM 0.3% vs 0.2% expected; CPI MoM 0.4% vs 0.3% expected';
    const wire: Headline = { id: 'h_cpi', ts: iso(et(10, 8, 30) + 5000), source: 'test-wire', title, category: 'macro', impact: 2, direction: -1, symbols: ['NQ'], classifier: 'rules', dedupeKey: hashId('h', title) };
    await d.store.put('headlines', [wire]);
    expect((await d.store.list('calendar', { status: 'CORE_CPI', since: iso(et(10, 0, 0)), until: iso(et(11, 0, 0)) }))[0]?.actual).toBeNull();

    const step = await runCatalysts(d.deps, at);
    expect(step.matched).toHaveLength(1);
    expect(step.matched[0]!.resolution).toMatchObject({ actual: 0.3, branchId: 'C', headlineId: 'h_cpi' });
    const p0 = step.intents.find((i) => i.reason === 'tier1_resolved')!;
    console.log(`[catalysts] via headline: ${p0.lines.join(' / ')}`);
    expect(p0.class).toBe('P0');
    expect(p0.ticketPrefill?.size?.units).toBeGreaterThan(0);

    // The calendar catches up a minute later: same branch, no second resolution.
    await calendarAt(d.store, at + MIN);
    const next = await runCatalysts(d.deps, at + MIN);
    expect(next.matched).toEqual([]);
    expect(next.intents.filter((i) => i.reason === 'tier1_resolved')).toEqual([]);
    expect(next.catalysts.find((c) => c.code === 'CPI')?.resolution?.branchId).toBe('C');
  }, 120_000);

  it('an auction is not matched on the calendar actual: the calendar prints the high yield, the matrix is keyed on the tail', async () => {
    const before = et(10, 12, 0);
    const d = await recordedDesk(before);
    const first = await runCatalysts(d.deps, before);
    const auction = first.catalysts.find((c) => c.code === 'TREASURY_AUCTION' && c.scheduledAt === iso(et(10, 13, 0)))!;
    expect(auction.name).toContain('10-Year Note Auction');
    const after = et(10, 13, 5);
    await calendarAt(d.store, after);
    d.clock.t = after;
    const step = await runCatalysts(d.deps, after);
    const done = step.catalysts.find((c) => c.id === auction.id)!;
    console.log(`[catalysts] ${done.name}: tier ${done.tier} (${done.tierReason}), matrix ${done.matrix ? 'yes' : 'no'}, resolution ${JSON.stringify(done.resolution)}`);
    expect(done.resolution).toMatchObject({ actual: 5.02, branchId: null });
    expect(step.matched).toEqual([]);
    expect(step.intents.filter((i) => i.reason === 'catalyst_resolved' || i.reason === 'tier1_resolved' || i.reason === 'tier1_pending')).toEqual([]);
  }, 120_000);

  it('a resolution first seen more than an hour late is recorded on the card and not pushed', async () => {
    const d = await recordedDesk(EVE);
    await runCatalysts(d.deps, EVE);
    const late = et(10, 10, 0);
    await calendarAt(d.store, late);
    d.clock.t = late;
    const step = await runCatalysts(d.deps, late);
    expect(step.matched.map((c) => c.resolution?.branchId)).toEqual(['C']);
    expect(step.intents.filter((i) => i.reason === 'tier1_resolved')).toEqual([]);
    expect(d.log.lines.some((l) => /^warn catalysts: CPI .* resolved 90 min after the release: recorded, not pushed$/.test(l))).toBe(true);
    expect((await d.store.list('catalysts')).find((c) => c.code === 'CPI')?.status).toBe('resolved');
  }, 120_000);

  it('an impact-3 headline becomes an ad-hoc catalyst once, with two branches and no invented analogs', async () => {
    const at = et(17, 11, 0);
    const d = await recordedDesk(at);
    // The headline is the test's own (synthetic event text); prices and the VIX reading behind the card are recorded.
    const title = 'Synthetic test headline: emergency export controls on advanced chips announced';
    const h: Headline = { id: 'h_adhoc', ts: iso(at - 2 * MIN), source: 'test-wire', title, category: 'geopolitical', impact: 3, direction: -1, symbols: ['NQ'], classifier: 'rules', dedupeKey: hashId('h', title) };
    await d.store.put('headlines', [h]);
    const step = await runCatalysts(d.deps, at);
    const adhoc = step.catalysts.filter((c) => c.code === 'ADHOC');
    expect(adhoc).toHaveLength(1);
    console.log(`[catalysts] ad-hoc: ${adhoc[0]!.matrix!.branches.map((b) => `${b.label} ${b.probability} ${b.trade?.direction ?? 'no trade'}`).join('; ')}. ${adhoc[0]!.matrix!.regimeNotes.join(' ')}`);
    expect(adhoc[0]!.matrix!.branches).toHaveLength(2);
    expect(adhoc[0]!.history).toEqual([]);
    const again = await runCatalysts(d.deps, at + MIN);
    expect(again.catalysts.filter((c) => c.code === 'ADHOC')).toHaveLength(1);
    expect((await d.store.list('catalysts')).filter((c) => c.code === 'ADHOC')).toHaveLength(1);
  }, 120_000);

  it('returns nothing on an empty store', async () => {
    const d = await desk(EVE);
    expect(await regime(d.deps, EVE, candleReader(d.deps, EVE))).toBeNull();
    expect(await runCatalysts(d.deps, EVE)).toEqual({ catalysts: [], matched: [], intents: [] });
    expect(await nextCatalyst(d.deps, EVE)).toBeNull();
  });
});
