/**
 * The engine-backed routes, driven with app.inject on a MemoryStore seeded from data/recorded. Market data is the
 * recording; balances, tickets and fills are what the trader would type, priced off the recorded marks.
 */
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AccountRules, AccountState, BaseRate, BiasCall, Brief, CalibrationBucket, Candle, Catalyst, ChatMessage, GuardrailFiring, Headline,
  HedgeViolation, JournalNote, KV, MIN, OverrideLedger, Position, PositionStatus, Quote, SizingResult, StructureEvent, Ticket, WatcherUpdate,
  DAY, fromZoned, iso,
  type AskReply, type ChartView, type JournalView, type NowView, type OverridePrompt, type PositionsView, type TicketPreview, type TicketSaveResult,
} from '@desk/contracts';
import type { LlmClient, LlmRequest } from '@desk/feeds';
import { buildApp } from '../app';
import { generateMorning } from '../services/briefs';
import { testTicket } from '../services/journal.testkit';
import { lastPrice } from '../services/market';
import { desk, recordedDesk, type Desk } from '../services/recorded.testkit';
import { computeBaseRates } from '../services/watcher';
import { kit } from '../testkit';
import { runLoop } from '../worker';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);
const NOV17 = et(17, 11, 0);
const SEED = { symbols: ['NQ', 'ES'] };

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
interface Reply<T> { status: number; body: T }
async function call<T = unknown>(app: FastifyInstance, method: Method, url: string, payload?: object): Promise<Reply<T>> {
  const r = await app.inject({ method, url, ...(payload !== undefined ? { payload } : {}) });
  return { status: r.statusCode, body: JSON.parse(r.body) as T };
}

/** A desk on the recording at `at`, after one pass of the loop, with the API mounted on it. */
async function open(at: number): Promise<{ d: Desk; app: FastifyInstance }> {
  const d = await recordedDesk(at, SEED);
  const report = await runLoop(d.deps, at);
  expect(report.steps.filter((s) => !s.ok)).toEqual([]);
  return { d, app: buildApp(d.deps) };
}

/* Contract shapes that have no zod schema of their own, assembled from the ones that do. */
const Stamp = z.object({ value: z.number().nullable(), asOf: z.string().nullable(), source: z.string().nullable(), stale: z.boolean(), age: z.string().nullable() });
const NowShape = z.object({
  asOf: z.string(), primary: BiasCall.nullable(), calls: z.array(BiasCall), updates: z.array(WatcherUpdate),
  rates: z.object({ y2: Stamp, y10: Stamp, y30: Stamp, spread2s10sBp: z.number().nullable(), fed: z.object({ hike: Stamp, cut: Stamp, hold: Stamp, meeting: z.string().nullable() }) }),
  quotes: z.record(Quote.extend({ stale: z.boolean(), age: z.string() })),
  nextCatalyst: z.object({ id: z.string(), name: z.string(), tier: z.number(), scheduledAt: z.string(), consensus: z.number().nullable(), prior: z.number().nullable() }).nullable(),
  headlines: z.array(Headline),
  session: z.object({ killSwitch: z.boolean(), readOnly: z.boolean(), readOnlyReason: z.string().nullable(), quietHours: z.boolean() }),
  feedHealth: z.array(z.object({ feed: z.string(), ok: z.boolean(), lastOk: z.string().nullable(), error: z.string().nullable(), live: z.boolean() })),
});
const AccountRowShape = z.object({
  rules: AccountRules, state: AccountState, floorUsd: z.number().nullable(), roomUsd: z.number().nullable(), payoutLine: z.string(), consistencyLine: z.string().nullable(),
  nextDeadline: z.object({ what: z.string(), at: z.string() }).nullable(), claimableUsd: z.number().nullable(),
});
const PositionsShape = z.object({
  asOf: z.string(), accounts: z.array(AccountRowShape), hedgeViolations: z.array(HedgeViolation),
  positions: z.array(z.object({ position: Position, status: PositionStatus.nullable(), ticket: Ticket.nullable(), nextTarget: z.object({ price: z.number(), fraction: z.number() }).nullable() })),
});
const PreviewShape = z.object({
  ok: z.boolean(), errors: z.array(z.object({ field: z.string(), message: z.string() })), sizing: SizingResult.nullable(), guardrails: z.array(GuardrailFiring),
  wouldSaveAs: z.enum(['planned', 'watch', 'blocked']), reentryCooldownUntil: z.string().nullable(),
});
const SaveShape = PreviewShape.extend({ ticket: Ticket.nullable() });
const JournalShape = z.object({
  asOf: z.string(), adherence20: z.number().nullable(), adherenceCount: z.number(), pnl20Usd: z.number().nullable(),
  calibration: z.object({ buckets: z.array(CalibrationBucket), n: z.number(), updatedAt: z.string().nullable(), source: z.enum(['replay', 'live', 'mixed']) }),
  ledger: OverrideLedger, trades: z.array(Ticket), calls: z.array(BiasCall), events: z.array(GuardrailFiring), notes: z.array(JournalNote), baseRates: z.array(BaseRate),
  guardrailScorecard: z.array(z.object({ pattern: z.string(), fired: z.number(), complied: z.number(), overrode: z.number(), savedUsd: z.number(), costUsd: z.number(), retired: z.boolean() })),
});
const Point = z.object({ t: z.number(), v: z.number() });
const ChartShape = z.object({
  symbol: z.string(), tf: z.string(), asOf: z.string().nullable(), stale: z.boolean(), candles: z.array(Candle),
  ema: z.object({ e20: z.array(Point), e50: z.array(Point), e200: z.array(Point) }), levels: z.array(StructureEvent),
  failPrices: z.array(z.object({ positionId: z.string(), accountId: z.string(), price: z.number() })),
});
const AskShape = z.object({ message: ChatMessage, guardrails: z.array(GuardrailFiring), engine: z.enum(['llm', 'rules']) });

/** A short MNQ draft on Lucid 25K off the latest confirmed 15m short setup on NQ in the store, levels around the recorded mark. */
async function shortDraft(d: Desk, now: number, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const setup = (await d.store.list('structure_events', { instrument: 'NQ', since: iso(now - DAY) })).find((e) => e.confirmedSetup && e.bias === -1 && e.tf === '15m');
  if (!setup) throw new Error('no confirmed 15m short setup on NQ in the recording at this time');
  const mark = (await lastPrice(d.deps, 'NQ', now))!.price;
  return {
    accountId: 'lucid-25k', instrument: 'MNQ', direction: 'short', reason: { kind: 'structure', setupEventId: setup.id },
    entry: { kind: 'condition', text: 'retest of the swept high fails' },
    targets: [{ price: mark - 75 }, { price: mark - 145 }, { price: mark - 225 }],
    invalidation: { price: mark + 545, reason: 'back above the swept high' }, timeStop: iso(et(17, 15, 30)), ...over,
  };
}

describe('engine-backed routes', () => {
  it('every read route answers on an empty store, and none of them is open without the session', async () => {
    const d = await desk(NOV17);
    const app = buildApp(d.deps);
    const now = await call<NowView>(app, 'GET', '/api/now');
    expect(now.status).toBe(200);
    expect(NowShape.parse(now.body)).toMatchObject({ primary: null, calls: [], nextCatalyst: null, session: { killSwitch: false, readOnly: false } });
    expect((await call(app, 'GET', '/api/catalysts')).body).toEqual([]);
    expect((await call(app, 'GET', '/api/catalysts/nope')).status).toBe(404);
    expect(PositionsShape.parse((await call(app, 'GET', '/api/positions')).body).accounts).toHaveLength(9);
    expect(z.array(AccountRowShape).parse((await call(app, 'GET', '/api/accounts')).body).every((a) => !a.state.active)).toBe(true);
    expect((await call(app, 'GET', '/api/tickets')).body).toEqual([]);
    expect((await call(app, 'GET', '/api/tickets/nope')).status).toBe(404);
    expect(JournalShape.parse((await call(app, 'GET', '/api/journal')).body)).toMatchObject({ adherence20: null, adherenceCount: 0, pnl20Usd: null, calibration: { n: 0, updatedAt: null, source: 'live' }, trades: [], baseRates: [] });
    for (const kind of ['morning', 'recap', 'weekly']) expect(await call(app, 'GET', `/api/briefs/latest?kind=${kind}`)).toEqual({ status: 200, body: null });
    expect((await call(app, 'GET', '/api/briefs/latest?kind=noon')).status).toBe(400);
    expect((await call(app, 'GET', '/api/ask/history')).body).toEqual([]);
    expect(ChartShape.parse((await call(app, 'GET', '/api/charts/NQ')).body)).toMatchObject({ symbol: 'NQ', tf: '15m', asOf: null, stale: true, candles: [], failPrices: [] });
    expect((await call(app, 'GET', '/api/charts/NOPE')).status).toBe(404);
    expect((await call(app, 'GET', '/api/charts/NQ?tf=3m')).status).toBe(400);
    // A draft on an empty desk is refused in words, not with a 500.
    const refused = await call<TicketSaveResult>(app, 'POST', '/api/tickets', { accountId: 'lucid-25k', instrument: 'MNQ', direction: 'long' });
    expect(refused.status).toBe(200);
    expect(SaveShape.parse(refused.body)).toMatchObject({ ok: false, wouldSaveAs: 'blocked', ticket: null });
    await app.close();

    const k = kit();
    for (const [method, url] of [['GET', '/api/now'], ['POST', '/api/refresh'], ['GET', '/api/catalysts'], ['GET', '/api/positions'], ['GET', '/api/accounts'], ['POST', '/api/tickets'], ['GET', '/api/journal'], ['POST', '/api/ask'], ['GET', '/api/charts/NQ']] as const) {
      expect((await k.app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
    await k.app.close();
  });

  it('now, refresh, catalysts, charts, briefs and the journal return contract-shaped bodies built from the recording', async () => {
    const start = et(16, 10, 0);
    const { d, app } = await open(start);
    await generateMorning(d.deps, start);

    // Pull to refresh a day later: the recorded feeds hand over every bar since, and the loop runs on them.
    d.clock.t = NOV17;
    const refreshed = await call<NowView>(app, 'POST', '/api/refresh');
    expect(refreshed.status).toBe(200);
    const now = NowShape.parse(refreshed.body);
    expect(now.asOf).toBe(iso(NOV17));
    expect(await d.store.kvGet<string>(KV.lastLoop)).toBe(iso(NOV17));
    expect(now.primary).toMatchObject({ instrument: 'NQ', horizon: 'intraday' });
    expect(now.rates.y10.value).not.toBeNull();
    expect(now.rates.y2.value).toBeNull();
    expect(now.feedHealth.some((h) => h.feed === 'worker:bias' && h.ok)).toBe(true);
    console.log(`[routes] now 2026-11-17 11:00 ET: NQ intraday ${now.primary!.call} ${now.primary!.probability} at ${now.primary!.referencePrice}; 10Y ${now.rates.y10.value}% (${now.rates.y10.source}, ${now.rates.y10.age} old); next ${now.nextCatalyst?.name}`);
    expect(NowShape.parse((await call(app, 'GET', '/api/now')).body).primary?.id).toBe(now.primary!.id);

    const cats = z.array(Catalyst).parse((await call(app, 'GET', '/api/catalysts?days=7&past=1')).body);
    expect(cats.length).toBeGreaterThan(3);
    expect(cats.map((c) => c.scheduledAt)).toEqual([...cats.map((c) => c.scheduledAt)].sort());
    expect(cats.every((c) => Date.parse(c.scheduledAt) >= NOV17 - DAY && Date.parse(c.scheduledAt) < NOV17 + 7 * DAY)).toBe(true);
    const retail = cats.find((c) => c.code === 'RETAIL_SALES')!;
    expect(retail.status).toBe('resolved');
    expect(Catalyst.parse((await call(app, 'GET', `/api/catalysts/${retail.id}`)).body).id).toBe(retail.id);
    expect((await call(app, 'GET', '/api/catalysts?days=0')).status).toBe(400);

    const chart = ChartShape.parse((await call<ChartView>(app, 'GET', '/api/charts/MNQ?tf=15m')).body);
    expect(chart.candles).toHaveLength(500);
    expect(chart.candles.every((c) => c.symbol === 'NQ' && c.tf === '15m' && c.t <= NOV17)).toBe(true);
    expect(chart).toMatchObject({ symbol: 'MNQ', asOf: iso(NOV17), stale: false });
    expect(chart.ema.e200).toHaveLength(500);
    expect(chart.ema.e20.at(-1)!.t).toBe(chart.candles.at(-1)!.t);
    // Below a falling 200: the 15m structure the bias engine reads on the same tape.
    expect(chart.candles.at(-1)!.c).toBeLessThan(chart.ema.e50.at(-1)!.v);
    expect(chart.ema.e50.at(-1)!.v).toBeLessThan(chart.ema.e200.at(-1)!.v);
    expect(chart.levels.length).toBeGreaterThan(0);
    expect(chart.levels.every((e) => e.instrument === 'NQ' && e.tf !== '1m' && e.tf !== '5m' && e.detector !== 'ema_posture')).toBe(true);
    console.log(`[routes] NQ 15m chart: last ${chart.candles.at(-1)!.c}, EMA20 ${chart.ema.e20.at(-1)!.v}, EMA50 ${chart.ema.e50.at(-1)!.v}, EMA200 ${chart.ema.e200.at(-1)!.v}, ${chart.levels.length} levels`);
    expect(ChartShape.parse((await call(app, 'GET', '/api/charts/NQ?tf=1d')).body).candles.length).toBeGreaterThan(400);

    const brief = Brief.parse((await call(app, 'GET', '/api/briefs/latest?kind=morning')).body);
    expect(brief).toMatchObject({ kind: 'morning', forDay: '2026-11-16' });
    expect((await call(app, 'GET', '/api/briefs/latest?kind=weekly')).body).toBeNull();

    expect(await computeBaseRates(d.deps, NOV17)).toBeGreaterThan(0);
    const note = JournalNote.parse((await call(app, 'POST', '/api/journal/notes', { text: '  My best trades are catalyst plus timing. ', tags: ['Edge', 'edge', ' timing '] })).body);
    expect(note).toMatchObject({ text: 'My best trades are catalyst plus timing.', tags: ['edge', 'timing'], source: 'trader', ts: iso(NOV17) });
    expect((await call(app, 'POST', '/api/journal/notes', { text: '   ' })).status).toBe(400);

    const journal = JournalShape.parse((await call<JournalView>(app, 'GET', '/api/journal')).body);
    expect(Object.keys((await call<JournalView>(app, 'GET', '/api/journal')).body)[1]).toBe('adherence20');
    expect(journal.notes.map((n) => n.id)).toContain(note.id);
    expect(journal.calls.length).toBeGreaterThan(0);
    // Monday's calls expired and were scored by the loop on the recorded path: they are live calls, not replay.
    const scored = journal.calls.filter((c) => c.outcome && c.call !== 'no_edge' && c.outcome.correct !== null);
    expect(journal.calibration.n).toBe(scored.length);
    expect(journal.calibration.n).toBeGreaterThan(0);
    expect(journal.calibration).toMatchObject({ source: 'live', updatedAt: iso(NOV17) });
    const sweep = journal.baseRates.find((r) => r.instrument === 'NQ' && r.tf === '1h' && r.pattern.includes('sweep'))!;
    expect(sweep.n).toBeGreaterThan(100);
    expect(journal.guardrailScorecard.length).toBeGreaterThan(10);
    console.log(`[routes] journal: ${journal.calibration.n} scored live call(s) ${scored.map((c) => `${c.instrument} ${c.horizon} ${c.call} ${c.probability} -> ${c.outcome!.correct ? 'right' : 'wrong'} (${c.outcome!.movePct.toFixed(2)}%)`).join('; ')}; base rate ${sweep.pattern} NQ 1h ${sweep.hitRate.toFixed(3)} n=${sweep.n}`);
    await app.close();
  }, 120_000);

  it('accounts and manual positions: a balance activates the account, a typed-in position is marked and can be removed', async () => {
    const { app } = await open(NOV17);
    expect((await call(app, 'PUT', '/api/accounts/nope/state', { balance: 1 })).status).toBe(404);
    expect((await call(app, 'PUT', '/api/accounts/lucid-25k/state', { balance: -5 })).status).toBe(400);
    const row = AccountRowShape.parse((await call(app, 'PUT', '/api/accounts/lucid-25k/state', { balance: 27_400 })).body);
    expect(row).toMatchObject({ state: { active: true, balance: 27_400, asOf: iso(NOV17) }, floorUsd: 25_100, roomUsd: 2_300 });
    const rows = z.array(AccountRowShape).parse((await call(app, 'GET', '/api/accounts')).body);
    expect(rows.filter((a) => a.state.active).map((a) => a.rules.id)).toEqual(['lucid-25k']);

    expect((await call(app, 'POST', '/api/positions', { accountId: 'lucid-25k', instrument: 'MNQ', direction: 'long', units: 0, entryPrice: 26_900 })).status).toBe(400);
    expect((await call(app, 'POST', '/api/positions', { accountId: 'nope', instrument: 'MNQ', direction: 'long', units: 1, entryPrice: 26_900 })).status).toBe(400);
    expect((await call(app, 'POST', '/api/positions', { accountId: 'lucid-25k', instrument: 'VIX', direction: 'long', units: 1, entryPrice: 20 })).status).toBe(400);
    const made = PositionsShape.parse((await call<PositionsView>(app, 'POST', '/api/positions', { accountId: 'lucid-25k', instrument: 'MNQ', direction: 'long', units: 1, entryPrice: 26_900 })).body);
    expect(made.positions).toHaveLength(1);
    const p = made.positions[0]!;
    expect(p.position).toMatchObject({ accountId: 'lucid-25k', instrument: 'MNQ', units: 1, entryPrice: 26_900, ticketId: null, openedAt: iso(NOV17) });
    // Marked at the recorded 26,925.25: one MNQ, 25.25 points, $2 a point.
    expect(p.status).toMatchObject({ mark: 26_925.25, pnlUsd: 50.5 });
    console.log(`[routes] manual position: ${p.status!.line}`);
    const gone = PositionsShape.parse((await call(app, 'DELETE', `/api/positions/${p.position.id}`)).body);
    expect(gone.positions).toEqual([]);
    expect((await call(app, 'DELETE', `/api/positions/${p.position.id}`)).status).toBe(404);
    await app.close();
  }, 60_000);

  it('tickets: no targets and a free-text reason are rejected in the desk voice; oversize is clamped; fill, override prompt, override, close and cancel', async () => {
    const { d, app } = await open(NOV17);
    await call(app, 'PUT', '/api/accounts/lucid-25k/state', { balance: 27_400 });
    const draft = await shortDraft(d, NOV17);

    const noTargets = SaveShape.parse((await call(app, 'POST', '/api/tickets', { ...draft, targets: [] })).body);
    expect(noTargets).toMatchObject({ ok: false, wouldSaveAs: 'blocked', ticket: null, errors: [{ field: 'targets', message: 'No targets, no ticket. Three exits before the entry.' }] });
    const twoTargets = SaveShape.parse((await call(app, 'POST', '/api/tickets', { ...draft, targets: (draft.targets as unknown[]).slice(0, 2) })).body);
    expect(twoTargets.errors).toEqual([{ field: 'targets', message: '2 targets. The plan is three, written before the entry.' }]);
    const noStops = SaveShape.parse((await call(app, 'POST', '/api/tickets', { ...draft, invalidation: undefined, timeStop: undefined })).body);
    expect(noStops.errors.map((e) => e.message)).toEqual(['No invalidation, no ticket. One price that proves the idea wrong.', 'No time stop, no ticket. Name the latest time the thesis is still alive.']);
    const freeText = SaveShape.parse((await call(app, 'POST', '/api/tickets', { ...draft, reason: 'it looks heavy and everyone is long' })).body);
    expect(freeText).toMatchObject({ ok: false, ticket: null, errors: [{ field: 'reason', message: 'No catalyst, no trade. Free text is not a reason; pick a catalyst or a confirmed setup.' }] });
    const madeUp = SaveShape.parse((await call(app, 'POST', '/api/tickets', { ...draft, reason: { kind: 'structure', setupEventId: 'se_made_up' } })).body);
    expect(madeUp.errors[0]!.message).toBe('Setup se_made_up is not on the confirmed list. No setup, no trade.');
    const nowEntry = SaveShape.parse((await call(app, 'POST', '/api/tickets', { ...draft, entry: 'now' })).body);
    expect(nowEntry.errors[0]!.message).toBe('"Now" is not a trigger. A price, a time, or a condition.');
    expect(await d.store.list('tickets')).toEqual([]);

    // 50 MNQ asked for; the engine's survivable size is what the ticket carries.
    const preview = PreviewShape.parse((await call<TicketPreview>(app, 'POST', '/api/tickets/preview', { ...draft, units: 50 })).body);
    expect(preview).toMatchObject({ ok: true, errors: [], wouldSaveAs: 'planned', guardrails: [] });
    const max = preview.sizing!.maxUnits;
    expect(max).toBeGreaterThanOrEqual(1);
    expect(max).toBeLessThan(50);
    expect(await d.store.list('tickets')).toEqual([]);
    const saved = (await call<TicketSaveResult & { notes: string[] }>(app, 'POST', '/api/tickets', { ...draft, units: 50 })).body;
    const ticket = SaveShape.parse(saved).ticket!;
    expect(saved).toMatchObject({ ok: true, wouldSaveAs: 'planned', notes: [`Size cut to ${max} from 50. Engine max is ${max}; down only, never up.`] });
    expect(ticket).toMatchObject({ status: 'planned', size: { units: max, engineMaxUnits: max, failPrice: preview.sizing!.failPrice }, holdThroughCatalyst: { flag: false, catalystId: null } });
    expect(ticket.sizingSnapshot?.worstMove.basis).toBe('p95_window');
    console.log(`[routes] oversize: asked 50 MNQ, engine max ${max} (${preview.sizing!.worstMove.text} usable $${preview.sizing!.room.usableUsd}), fail ${ticket.size.failPrice}`);

    expect(z.array(Ticket).parse((await call(app, 'GET', '/api/tickets?status=planned,open')).body).map((t) => t.id)).toEqual([ticket.id]);
    expect((await call(app, 'GET', '/api/tickets?status=closed')).body).toEqual([]);
    expect((await call(app, 'GET', '/api/tickets?status=maybe')).status).toBe(400);
    const detail = (await call<{ ticket: Ticket; ledger: OverrideLedger; events: StructureEvent[] }>(app, 'GET', `/api/tickets/${ticket.id}`)).body;
    expect(Ticket.parse(detail.ticket).id).toBe(ticket.id);
    expect(OverrideLedger.parse(detail.ledger)).toMatchObject({ monthToDateUsd: 0, instances: 0 });
    expect(z.array(StructureEvent).parse(detail.events).map((e) => e.id)).toEqual([(draft.reason as { setupEventId: string }).setupEventId]);

    // The trader confirms the entry at the recorded mark. The system placed nothing.
    const mark = (await lastPrice(d.deps, 'NQ', NOV17))!.price;
    expect((await call(app, 'POST', `/api/tickets/${ticket.id}/fill`, { fill: { ts: iso(NOV17), price: mark, units: 0, kind: 'entry', source: 'manual' } })).status).toBe(409);
    expect((await call(app, 'POST', `/api/tickets/${ticket.id}/fill`, { fill: { ts: iso(NOV17 + DAY), price: mark, units: max, kind: 'entry', source: 'manual' } })).status).toBe(400);
    expect((await call(app, 'POST', '/api/tickets/nope/fill', { fill: { ts: iso(NOV17), price: mark, units: max, kind: 'entry', source: 'manual' } })).status).toBe(404);
    const filled = Ticket.parse((await call(app, 'POST', `/api/tickets/${ticket.id}/fill`, { fill: { ts: iso(NOV17), price: mark, units: max, kind: 'entry', source: 'manual' } })).body);
    expect(filled).toMatchObject({ status: 'open', overrides: [] });
    const view = PositionsShape.parse((await call(app, 'GET', '/api/positions')).body);
    expect(view.positions).toHaveLength(1);
    expect(view.positions[0]).toMatchObject({ position: { ticketId: ticket.id, units: max, entryPrice: mark, direction: 'short' }, ticket: { id: ticket.id }, nextTarget: ticket.targets[0], status: { status: 'Safe', mark } });
    const chart = ChartShape.parse((await call(app, 'GET', '/api/charts/NQ?tf=1m')).body);
    expect(chart.failPrices).toEqual([{ positionId: view.positions[0]!.position.id, accountId: 'lucid-25k', price: view.positions[0]!.status!.failPrice }]);
    expect((await call(app, 'POST', `/api/tickets/${ticket.id}/cancel`)).status).toBe(409);

    // An override costs a prompt and a reason.
    expect(await call(app, 'POST', `/api/tickets/${ticket.id}/override`, { kind: 'moved_stop', reason: 'gave it room' })).toEqual({ status: 409, body: { error: 'Override prompt first: the plan, the live P&L, the ledger. Then the reason.' } });
    const prompt = (await call<OverridePrompt>(app, 'GET', `/api/tickets/${ticket.id}/override-prompt`)).body;
    expect(Ticket.parse(prompt.ticket).id).toBe(ticket.id);
    expect(OverrideLedger.parse(prompt.ledger).instances).toBe(0);
    expect(prompt.livePnlUsd).toBe(0);
    expect(prompt.text.split('\n')).toEqual([expect.stringMatching(/^Plan: MNQ short, 33% off at /), 'Live P&L +$0.', 'No overrides on the books this month. This would be the first.', 'Your call.']);
    expect((await call(app, 'POST', `/api/tickets/${ticket.id}/override`, { kind: 'moved_stop', reason: '  ' })).status).toBe(400);
    expect((await call(app, 'POST', `/api/tickets/${ticket.id}/override`, { kind: 'vibes', reason: 'gave it room' })).status).toBe(400);
    const overridden = Ticket.parse((await call(app, 'POST', `/api/tickets/${ticket.id}/override`, { kind: 'moved_stop', reason: 'gave it room' })).body);
    expect(overridden.overrides).toEqual([{ ts: iso(NOV17), kind: 'moved_stop', reason: 'gave it room', pnlImpactUsd: null }]);

    // Twenty minutes on, out at the recorded price.
    const later = NOV17 + 20 * MIN;
    d.clock.t = later;
    await call(app, 'POST', '/api/refresh');
    const exit = (await lastPrice(d.deps, 'NQ', later))!.price;
    expect((await call(app, 'POST', `/api/tickets/${ticket.id}/close`, { price: -1 })).status).toBe(400);
    const closed = Ticket.parse((await call(app, 'POST', `/api/tickets/${ticket.id}/close`, { price: exit })).body);
    expect(closed).toMatchObject({ status: 'closed', closedAt: iso(later), result: { exitPrice: exit, pnlUsd: (mark - exit) * 2 * max, followedPlan: false } });
    console.log(`[routes] trade: short ${max} MNQ ${mark} -> ${exit} at 11:20 ET, P&L $${closed.result!.pnlUsd}, adherence ${closed.result!.adherence}, overrides ${closed.overrides.map((o) => o.kind).join(', ')}`);
    expect(PositionsShape.parse((await call(app, 'GET', '/api/positions')).body).positions).toEqual([]);
    expect((await call(app, 'POST', `/api/tickets/${ticket.id}/cancel`)).status).toBe(409);
    expect((await call(app, 'POST', `/api/tickets/${ticket.id}/fill`, { fill: { ts: iso(later), price: exit, units: 1, kind: 'add', source: 'manual' } })).status).toBe(409);

    const journal = JournalShape.parse((await call(app, 'GET', '/api/journal')).body);
    expect(journal).toMatchObject({ adherence20: closed.result!.adherence, adherenceCount: 1, pnl20Usd: closed.result!.pnlUsd });
    expect(journal.trades.map((t) => t.id)).toEqual([ticket.id]);
    expect(journal.ledger.instances).toBe(closed.overrides.length);

    // A second ticket that never fills is cancelled, not closed.
    const second = SaveShape.parse((await call(app, 'POST', '/api/tickets', await shortDraft(d, later))).body).ticket!;
    expect(second.id).not.toBe(ticket.id);
    expect((await call(app, 'POST', `/api/tickets/${second.id}/close`, { price: exit })).status).toBe(409);
    expect(Ticket.parse((await call(app, 'POST', `/api/tickets/${second.id}/cancel`)).body)).toMatchObject({ status: 'cancelled', closedAt: iso(later) });
    await app.close();
  }, 120_000);

  it('a hold through a Tier-1 catalyst the account cannot survive is blocked with the sizing engine\'s message', async () => {
    const at = et(10, 7, 0);
    const { d, app } = await open(at);
    await call(app, 'PUT', '/api/accounts/lucid-25k/state', { balance: 25_600 });
    const cpi = (await d.store.list('catalysts')).find((c) => c.code === 'CPI')!;
    expect(cpi).toMatchObject({ tier: 1, status: 'upcoming', scheduledAt: iso(et(10, 8, 30)) });
    const mark = (await lastPrice(d.deps, 'NQ', at))!.price;
    const draft = {
      accountId: 'lucid-25k', instrument: 'MNQ', direction: 'long', reason: { kind: 'catalyst', catalystId: cpi.id },
      entry: { kind: 'time', at: iso(et(10, 8, 0)), text: 'long ahead of the print' },
      targets: [{ price: mark + 110 }, { price: mark + 210 }, { price: mark + 360 }], invalidation: { price: mark - 90, reason: 'loses the overnight low' }, timeStop: iso(et(10, 10, 0)),
    };
    const res = SaveShape.parse((await call(app, 'POST', '/api/tickets', draft)).body);
    expect(res).toMatchObject({ ok: false, wouldSaveAs: 'blocked', ticket: null, sizing: { blocked: true, maxUnits: 0, catalystInWindow: { id: cpi.id } } });
    expect(res.errors).toEqual([{ field: 'size', message: res.sizing!.blockReason }]);
    expect(res.sizing!.blockReason).toMatch(/^This cannot survive CPI \(core MoM\) at any size above 0 MNQ; the catalyst trade is /);
    expect(res.guardrails.map((g) => [g.pattern, g.effect])).toEqual([['catalyst_hold', 'block']]);
    console.log(`[routes] tier-1 hold: implied ±${cpi.impliedMovePct}% on ${mark}, usable $${res.sizing!.room.usableUsd}. ${res.sizing!.blockReason}`);
    console.log(`[routes] tier-1 hold flag: ${res.guardrails[0]!.text}`);
    expect(await d.store.list('tickets')).toEqual([]);
    // Control: the same plan flat half an hour before the print is sized and saved.
    const flatBefore = SaveShape.parse((await call(app, 'POST', '/api/tickets', { ...draft, entry: { kind: 'condition', text: 'overnight low holds on a retest' }, reason: { kind: 'catalyst', catalystId: cpi.id }, timeStop: iso(et(10, 8, 0)) })).body);
    expect(flatBefore.sizing?.catalystInWindow).toBeNull();
    expect(flatBefore.guardrails.filter((g) => g.pattern === 'catalyst_hold')).toEqual([]);
    await app.close();
  }, 60_000);

  it('a late-night ticket with no catalyst inside 12 hours is asked once, then saved as a watch on the second attempt', async () => {
    const at = et(10, 23, 30);
    const { d, app } = await open(at);
    await call(app, 'PUT', '/api/accounts/lucid-25k/state', { balance: 27_400 });
    const claims = (await d.store.list('catalysts', { since: iso(at), order: 'asc' }))[0]!;
    expect(claims).toMatchObject({ code: 'CLAIMS', scheduledAt: iso(et(12, 8, 30)) });
    const mark = (await lastPrice(d.deps, 'NQ', at))!.price;
    const draft = {
      accountId: 'lucid-25k', instrument: 'MNQ', direction: 'long', reason: { kind: 'catalyst', catalystId: claims.id },
      entry: { kind: 'condition', text: 'overnight low holds on a retest' },
      targets: [{ price: mark + 60 }, { price: mark + 120 }, { price: mark + 200 }], invalidation: { price: mark - 80, reason: 'loses the overnight low' }, timeStop: iso(et(11, 15, 30)),
    };
    // Previews ask the question without counting as an attempt.
    const preview = PreviewShape.parse((await call(app, 'POST', '/api/tickets/preview', draft)).body);
    expect(preview).toMatchObject({ ok: false, wouldSaveAs: 'blocked', errors: [] });
    expect(await d.store.list('guardrail_firings')).toEqual([]);

    const first = SaveShape.parse((await call(app, 'POST', '/api/tickets', draft)).body);
    expect(first).toMatchObject({ ok: false, wouldSaveAs: 'blocked', ticket: null, errors: [] });
    expect(first.guardrails.map((g) => [g.pattern, g.effect])).toEqual([['late_night_idea', 'block']]);
    expect(first.guardrails[0]!.text).toBe("It's 23:30 and this MNQ long has no scheduled catalyst inside 12 hours. Next on the calendar is Initial Jobless Claims (w/o Nov. 2, 2026), 33h out. Name the catalyst, or it saves as a watch.");
    expect(await d.store.list('tickets')).toEqual([]);

    d.clock.t = at + MIN;
    const second = SaveShape.parse((await call(app, 'POST', '/api/tickets', draft)).body);
    expect(second).toMatchObject({ ok: true, wouldSaveAs: 'watch', errors: [], ticket: { status: 'watch', fills: [] } });
    expect(second.guardrails.map((g) => [g.pattern, g.effect])).toEqual([['late_night_idea', 'downgrade_to_watch']]);
    console.log(`[routes] late night: ${first.guardrails[0]!.text} / ${second.guardrails[0]!.text}`);
    expect((await d.store.list('tickets')).map((t) => t.status)).toEqual(['watch']);
    // A watch takes no fills and opens no position.
    expect((await call(app, 'POST', `/api/tickets/${second.ticket!.id}/fill`, { fill: { ts: iso(at + MIN), price: mark, units: 1, kind: 'entry', source: 'manual' } })).status).toBe(409);
    expect(await d.store.list('positions')).toEqual([]);
    await app.close();
  }, 60_000);

  it('opposite exposure on a second account is blocked with the firm\'s clause', async () => {
    const { d, app } = await open(NOV17);
    for (const id of ['vest-instant', 'vest-eval']) await call(app, 'PUT', `/api/accounts/${id}/state`, { balance: 10_000, startingBalance: 10_000 });
    const mark = (await lastPrice(d.deps, 'NQ', NOV17))!.price;
    await call(app, 'POST', '/api/positions', { accountId: 'vest-instant', instrument: 'NQ-PERP', direction: 'long', units: 20_000, entryPrice: mark, leverage: 2 });
    const draft = await shortDraft(d, NOV17, { accountId: 'vest-eval', instrument: 'NQ-PERP' });
    const res = SaveShape.parse((await call(app, 'POST', '/api/tickets', draft)).body);
    expect(res).toMatchObject({ ok: false, wouldSaveAs: 'blocked', ticket: null, errors: [] });
    const cross = res.guardrails.find((g) => g.pattern === 'cross_account_offset')!;
    expect(cross).toMatchObject({ effect: 'block', blocks: true });
    expect(cross.text).toBe('Blocked: short NQ-PERP on vest-eval is opposite exposure to NQ-PERP on vest-instant. Vest Markets: "Vest: coordinating accounts incl. opposite positions is prohibited". One direction across accounts, or one account flat.');
    expect(await d.store.list('tickets')).toEqual([]);
    expect((await d.store.list('guardrail_firings')).map((f) => f.pattern)).toContain('cross_account_offset');
    // Control: the same direction on the second account is not an offset.
    const same = PreviewShape.parse((await call(app, 'POST', '/api/tickets/preview', { ...draft, direction: 'long' })).body);
    expect(same.guardrails.some((g) => g.pattern === 'cross_account_offset')).toBe(false);
    await app.close();
  }, 60_000);

  it('the kill switch and the read-only desk refuse new tickets with the reason', async () => {
    const { d, app } = await open(NOV17);
    await call(app, 'PUT', '/api/accounts/lucid-25k/state', { balance: 27_400 });
    const draft = await shortDraft(d, NOV17);
    expect(PreviewShape.parse((await call(app, 'POST', '/api/tickets/preview', draft)).body).ok).toBe(true);

    await call(app, 'POST', '/api/admin/kill', { on: true });
    const killed = SaveShape.parse((await call(app, 'POST', '/api/tickets', draft)).body);
    expect(killed).toMatchObject({ ok: false, wouldSaveAs: 'blocked', ticket: null, errors: [{ field: 'session', message: 'Kill switch is on. No new tickets until it is off.' }] });
    expect(PreviewShape.parse((await call(app, 'POST', '/api/tickets/preview', draft)).body).ok).toBe(false);
    await call(app, 'POST', '/api/admin/kill', { on: false });

    // Three plan-breaking trades today (the trader's own overrides): the next draft trips the breaker.
    const mark = (await lastPrice(d.deps, 'NQ', NOV17))!.price;
    await d.store.put('tickets', [90, 60, 5].map((minsAgo, i) => testTicket(`tkt_broke_${i}`, mark, NOV17, { status: 'closed', closedAt: iso(NOV17 - minsAgo * MIN), overrides: [{ ts: iso(NOV17 - minsAgo * MIN), kind: 'moved_stop', reason: 'gave it room', pnlImpactUsd: null }] })));
    const tripped = SaveShape.parse((await call(app, 'POST', '/api/tickets', draft)).body);
    expect(tripped).toMatchObject({ ok: false, wouldSaveAs: 'blocked', ticket: null });
    const breaker = tripped.guardrails.find((g) => g.pattern === 'circuit_breaker')!;
    expect(breaker.effect).toBe('read_only');
    expect(breaker.text).toMatch(/^Three plan-breaking trades today: .* Desk is read-only for the rest of the session; it reopens tomorrow\.$/);

    const now = NowShape.parse((await call(app, 'GET', '/api/now')).body);
    expect(now.session).toMatchObject({ readOnly: true, readOnlyReason: breaker.text });
    d.clock.t = NOV17 + MIN;
    const refused = SaveShape.parse((await call(app, 'POST', '/api/tickets', draft)).body);
    expect(refused).toMatchObject({ ok: false, wouldSaveAs: 'blocked', ticket: null });
    expect(refused.errors[0]).toEqual({ field: 'session', message: breaker.text });
    console.log(`[routes] read-only: ${breaker.text}`);
    expect((await d.store.list('tickets')).filter((t) => !t.id.startsWith('tkt_broke_'))).toEqual([]);
    // Refused drafts are not journaled a second time.
    expect((await d.store.list('guardrail_firings')).filter((f) => f.pattern === 'circuit_breaker')).toHaveLength(1);
    // The desk reopens on its own the next local day.
    d.clock.t = et(18, 0, 1);
    expect(NowShape.parse((await call(app, 'GET', '/api/now')).body).session.readOnly).toBe(false);
    await app.close();
  }, 60_000);

  it('Ask "up or down today?" returns the current call with its as-of; check live re-reads the feeds; history keeps both sides', async () => {
    const { d, app } = await open(NOV17);
    const call0 = (await d.store.list('bias_calls', { instrument: 'NQ', status: 'intraday', limit: 1 }))[0]!;
    const res = AskShape.parse((await call<AskReply>(app, 'POST', '/api/ask', { text: 'up or down today?' })).body);
    expect(res.engine).toBe('rules');
    expect(res.guardrails).toEqual([]);
    expect(res.message).toMatchObject({ role: 'desk', asOf: call0.createdAt, citations: [{ label: 'call NQ intraday', source: 'bias engine', asOf: call0.createdAt }] });
    expect(res.message.text).toMatch(new RegExp(`^NQ intraday: Lean short ${call0.probability.toFixed(2)}, expires `));
    expect(res.message.text).toMatch(/Kill: .*\(as of 11:00 ET\)$/);
    console.log(`[routes] ask: ${res.message.text}`);

    // "check live": ten minutes later the loop runs before the answer, so the call it quotes is as of now.
    d.clock.t = NOV17 + 10 * MIN;
    const live = AskShape.parse((await call(app, 'POST', '/api/ask', { text: 'NQ: which way?', checkLive: true })).body);
    expect(await d.store.kvGet<string>(KV.lastLoop)).toBe(iso(NOV17 + 10 * MIN));
    expect((await lastPrice(d.deps, 'NQ', d.clock.t))!.asOf).toBe(iso(NOV17 + 10 * MIN));
    expect(live.message.text).toMatch(/^NQ intraday: /);
    // The phrase alone asks for it too.
    d.clock.t = NOV17 + 12 * MIN;
    await call(app, 'POST', '/api/ask', { text: 'what is the latest on the 10Y?' });
    expect(await d.store.kvGet<string>(KV.lastLoop)).toBe(iso(NOV17 + 12 * MIN));

    // A message that calls the low: the guardrail answers beside the desk.
    d.clock.t = NOV17 + 13 * MIN;
    const flagged = AskShape.parse((await call(app, 'POST', '/api/ask', { text: 'I feel like the bottom is in on NQ' })).body);
    expect(flagged.guardrails.map((g) => [g.pattern, g.trigger.kind])).toEqual([['bottom_call', 'chat']]);
    expect(flagged.message.text).toMatch(/Current call: NQ intraday: /);

    expect((await call(app, 'POST', '/api/ask', { text: '  ' })).status).toBe(400);
    const history = z.array(ChatMessage).parse((await call(app, 'GET', '/api/ask/history')).body);
    expect(history.map((m) => m.role)).toEqual(['trader', 'desk', 'trader', 'desk', 'trader', 'desk', 'trader', 'desk']);
    expect(history[0]).toMatchObject({ text: 'up or down today?', ts: iso(NOV17) });
    expect(history[1]!.id).toBe(res.message.id);
    await app.close();
  }, 60_000);

  it('Ask uses the LLM only when its answer passes the checks, and says which engine answered', async () => {
    const d = await recordedDesk(NOV17, SEED);
    await runLoop(d.deps, NOV17);
    const seen: LlmRequest[] = [];
    let answer = 'NQ goes up to 30,000 tomorrow.';
    const llm: LlmClient = { available: true, complete: async (req) => { seen.push(req); return answer; } };
    const app = buildApp({ ...d.deps, llm } as typeof d.deps);

    // A direction with no probability, no kill condition, no as-of and a number that is on no feed: discarded.
    const bad = AskShape.parse((await call(app, 'POST', '/api/ask', { text: 'up or down today?' })).body);
    expect(bad.engine).toBe('rules');
    expect(bad.message.text).toMatch(/^NQ intraday: Lean short /);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toContain('Answer only from the FACT SHEET');
    expect(seen[0]!.messages[0]!.content).toMatch(/^FACT SHEET, built [\s\S]*CURRENT CALLS\n- NQ intraday: Lean short [\s\S]*QUESTION\nup or down today\?$/);
    expect(d.log.lines.some((l) => l.startsWith('warn ask: LLM answer discarded'))).toBe(true);

    // The same facts, stamped, pass and are returned as the LLM's answer.
    d.clock.t = NOV17 + 1000;
    answer = bad.message.text;
    const good = AskShape.parse((await call(app, 'POST', '/api/ask', { text: 'up or down today?' })).body);
    expect(good.engine).toBe('llm');
    expect(good.message.text).toBe(answer);
    expect(good.message.citations?.map((c) => c.label)).toContain('call NQ intraday');
    await app.close();
  }, 60_000);
});
