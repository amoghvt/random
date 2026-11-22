/**
 * Catalyst state: docs built from the calendar and earnings, scenario matrices when due with every branch trade sized,
 * live matching when an actual arrives (calendar or a parsed wire headline), the reaction clock and ad-hoc catalysts.
 */
import {
  DATUM_KEYS, DAY, EventCode, HOUR, INSTRUMENTS, MIN, fmtNum, freshness, hashId, iso,
  type AccountRules, type CalendarEvent, type Catalyst, type Datum, type Headline, type NotificationIntent, type Position, type ScenarioMatrix,
  type SizingResult, type Store, type TradePlan,
} from '@desk/contracts';
import { catalyst as cat, notify, sizing } from '@desk/engines';
import { activeAccounts, type Account } from './accounts';
import { logOf, profileOf, type DeskDeps } from './context';
import { candleReader, fineCandles, lastPrice, sizingCandles, y10Since, type CandleReader } from './market';

const PLAN_WINDOW_MS = 36 * HOUR;
const LOOKBACK_MS = 2 * DAY, LOOKAHEAD_MS = 14 * DAY;
const KNOWN_CODES = EventCode.options.filter((c) => c !== 'OTHER');
const HISTORY_RETRY_MS = 6 * HOUR;
/** When an empty history table was last attempted, per store, so a catalyst with no past prints is not recomputed every loop. */
const historyTried = new WeakMap<Store, Map<string, number>>();

/** A resolution first seen this long after the release is recorded on the card and not pushed: its entry window has gone. */
const LATE_RESOLUTION_MS = HOUR;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the calendar's actual is the number the matrix is keyed on. Auctions are keyed on the tail in bp and the tone
 * events on a read, while the calendar prints the auction's high yield: that actual is shown on the card, never matched.
 */
const calendarCarriesKeyedMetric = (c: Catalyst): boolean => cat.SPECS[c.code]?.centre !== 'zero';

async function freshDatum(deps: DeskDeps, key: string, now: number): Promise<Datum | null> {
  const d = (await deps.store.dataHistory(key, now - 30 * DAY, now)).at(-1);
  return d && freshness(d, now) !== 'stale' ? d : null;
}

/**
 * The regime the matrix signs its branches with, from the store only. Fed stance is the direction of the last change
 * in the last three decisions; hike and cut odds are null when no fresh reading is on file. Null without daily candles.
 */
export async function regime(deps: DeskDeps, now: number, reader: CandleReader = candleReader(deps, now)): Promise<cat.Regime | null> {
  const daily = await reader.closed('NQ', '1d');
  const last = daily.at(-1);
  if (!last) return null;
  const fed = (await deps.store.list('calendar', { status: 'FOMC', until: iso(now), order: 'desc', limit: 12 }))
    .filter((e) => e.actual !== null && e.prior !== null).slice(0, 3);
  const change = fed.find((e) => e.actual !== e.prior);
  const tail = daily.slice(-50);
  const sma50 = tail.reduce((a, c) => a + c.c, 0) / tail.length;
  const dd = (last.c / Math.max(...daily.slice(-60).map((c) => c.h)) - 1) * 100;
  const y10d = await freshDatum(deps, DATUM_KEYS.rate('US10Y'), now);
  const y10 = y10d?.value ?? (await reader.closed('US10Y', '5m')).at(-1)?.c ?? (await reader.closed('US10Y', '1d')).at(-1)?.c ?? null;
  const [hike, cutP] = await Promise.all([freshDatum(deps, DATUM_KEYS.fedHike, now), freshDatum(deps, DATUM_KEYS.fedCut, now)]);
  return {
    fedStance: change ? ((change.actual as number) > (change.prior as number) ? 'hiking' : 'cutting') : 'hold',
    hikeProb: hike?.value ?? null, cutProb: cutP?.value ?? null,
    trend: last.c > sma50 && dd > -5 ? 'uptrend' : last.c < sma50 && dd <= -10 ? 'downtrend' : 'correction',
    y10, y10RoundLevelDistanceBp: y10 === null ? null : Math.round((Math.round(y10 * 2) / 2 - y10) * 1000) / 10,
  };
}

/** Calendar rows with an actual, for surprise distributions and the history table. */
const pastEvents = (deps: DeskDeps, now: number): Promise<CalendarEvent[]> =>
  deps.store.list('calendar', { status: KNOWN_CODES, until: iso(now), since: iso(now - 800 * DAY), order: 'asc' });

async function historyCandles(reader: CandleReader, symbol: string): Promise<cat.CandlesByTf> {
  const [m5, h1, d1] = await Promise.all([reader.closed(symbol, '5m', 20_000), reader.closed(symbol, '1h', 20_000), reader.closed(symbol, '1d', 900)]);
  return { '5m': m5, '1h': h1, '1d': d1 };
}

export interface RefreshResult {
  catalysts: Catalyst[];
  /** Resolved to a branch in this pass. */
  matched: Catalyst[];
  /** An actual arrived but the branch split cannot be decided yet (a hold without the tone, a missing secondary). */
  pending: Catalyst[];
}

/**
 * Rebuilds the catalyst docs for the last 2 and next 14 days and resolves any whose actual has arrived.
 * A stored matrix, a matched resolution and the reaction readings survive the rebuild.
 */
export async function refreshCatalysts(deps: DeskDeps, now: number, reader: CandleReader = candleReader(deps, now)): Promise<RefreshResult> {
  const since = iso(now - LOOKBACK_MS), until = iso(now + LOOKAHEAD_MS);
  const [calendar, earnings, stored, profile, predictions] = await Promise.all([
    deps.store.list('calendar', { since, until, order: 'asc' }),
    deps.store.list('earnings', { since, until, order: 'asc' }),
    deps.store.list('catalysts', { since, until, order: 'asc' }),
    profileOf(deps),
    deps.store.list('predictions', { since: iso(now - 2 * DAY), until: iso(now + 1) }),
  ]);
  const events = calendar.filter((e) => e.code !== 'OTHER' || (e.importance ?? -1) >= 1);
  const existing = new Map(stored.map((c) => [c.id, c]));
  const vixD = await freshDatum(deps, DATUM_KEYS.vix, now);
  const implied = await freshDatum(deps, DATUM_KEYS.impliedMove('NQ'), now);
  const reg = await regime(deps, now, reader);
  const impliedCtx: cat.ImpliedCtx = { now, data: implied ? [implied] : [], vix: vixD ? { value: vixD.value, asOf: vixD.asOf } : null };
  const skeletons = cat.buildCatalysts(events, earnings, {
    ...impliedCtx, watchlist: profile.instruments.watchlist, y10RoundLevelDistanceBp: reg?.y10RoundLevelDistanceBp ?? null, predictionMarkets: predictions,
  });

  let tried = historyTried.get(deps.store);
  if (!tried) historyTried.set(deps.store, (tried = new Map()));
  let past: CalendarEvent[] | null = null, candles: cat.CandlesByTf | null = null;
  const out: Catalyst[] = [], matched: Catalyst[] = [], pending: Catalyst[] = [], changed: Catalyst[] = [];

  for (const s of skeletons) {
    const prev = existing.get(s.id);
    const T = Date.parse(s.scheduledAt);
    let history = s.code === 'EARNINGS' ? s.history : prev?.history ?? [];
    const lastTry = tried.get(s.id);
    if (s.code !== 'EARNINGS' && s.tier < 3 && history.length === 0 && (lastTry === undefined || now - lastTry >= HISTORY_RETRY_MS)) {
      past ??= await pastEvents(deps, now);
      candles ??= await historyCandles(reader, 'NQ');
      history = cat.buildHistory(s.keyedOn ?? s.code, past, candles, 8, Math.min(now, T));
      tried.set(s.id, now);
    }
    let c: Catalyst = cat.withImpliedMove({ ...s, history }, impliedCtx);
    if (c.code === 'EARNINGS' && s.impliedMovePct !== null) c = { ...c, impliedMovePct: s.impliedMovePct, impliedMoveSource: s.impliedMoveSource };
    if (prev) c = { ...c, matrix: prev.matrix, ...(prev.reaction ? { reaction: prev.reaction } : {}) };
    const actual = s.resolution?.actual ?? null;
    if (prev?.resolution?.branchId) {
      c = { ...c, status: prev.status, resolution: prev.resolution };
    } else if (c.matrix && actual !== null && calendarCarriesKeyedMetric(c)) {
      const stamp = Date.parse(s.resolution?.resolvedAt ?? '');
      const ts = Math.min(now, Math.max(T, Number.isFinite(stamp) ? stamp : now));
      const secondary = s.secondary?.actual ?? undefined;
      const open: Catalyst = { ...c, status: 'live', resolution: null };
      const m = cat.matchRelease(open, { actual, ...(secondary !== undefined && secondary !== null ? { secondary } : {}), ts }, now);
      c = prev?.resolution && prev.resolution.actual === actual && prev.resolution.branchId === m.resolution?.branchId ? { ...m, resolution: prev.resolution, asOf: c.asOf } : m;
      if (c.resolution?.branchId) matched.push(c);
      else if (prev?.resolution?.actual !== actual) pending.push(c);
    }
    out.push(c);
  }

  // Wire headlines beat the calendar feed to the print by minutes.
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    const T = Date.parse(c.scheduledAt);
    if (!c.matrix || c.resolution || c.code === 'EARNINGS' || T > now + MIN || now - T > cat.HEADLINE_WINDOW_MS) continue;
    const headlines = await deps.store.list('headlines', { since: iso(T - MIN), until: iso(now + 1), order: 'asc' });
    for (const h of headlines) {
      const release = cat.parseReleaseHeadline(h, c);
      if (!release) continue;
      const m = cat.matchRelease(c, release, now);
      out[i] = m;
      if (m.resolution?.branchId) matched.push(m); else pending.push(m);
      break;
    }
  }

  for (const c of out) if (!same(existing.get(c.id), c)) changed.push(c);
  if (changed.length) await deps.store.put('catalysts', changed);
  // Ad-hoc catalysts are not rebuilt from the calendar; they ride along unchanged.
  const adhoc = stored.filter((c) => c.code === 'ADHOC');
  return { catalysts: [...out, ...adhoc].sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)), matched, pending };
}

/* ───────────────────────── sizing a plan ───────────────────────── */

export interface SizeCtx { now: number; reader: CandleReader; catalysts: Catalyst[]; accounts: Account[]; positions: Position[] }

export async function sizeCtx(deps: DeskDeps, now: number, reader: CandleReader, catalysts?: Catalyst[]): Promise<SizeCtx> {
  const [accts, positions, cats] = await Promise.all([
    activeAccounts(deps, now), deps.store.list('positions'),
    catalysts ? Promise.resolve(catalysts) : deps.store.list('catalysts', { since: iso(now - DAY), until: iso(now + LOOKAHEAD_MS) }),
  ]);
  return { now, reader, catalysts: cats, accounts: accts, positions };
}

/**
 * Runs the sizing engine for a plan on its account at `price`. The plan comes back with `size` filled when the account
 * can take it, and without one when it is blocked: a blocked plan never carries a stale size.
 */
export async function sizePlan(plan: TradePlan, price: number, ctx: SizeCtx, catalystId?: string): Promise<{ plan: TradePlan; sizing: SizingResult | null }> {
  const { size: _dropped, ...bare } = plan;
  const acct = ctx.accounts.find((a) => a.rules.id === plan.accountId);
  if (!acct) return { plan: bare, sizing: null };
  const entryAt = Math.max(ctx.now, plan.entry.at ? Date.parse(plan.entry.at) : ctx.now);
  const holdUntil = plan.timeStop.at ? Date.parse(plan.timeStop.at) : cat.cashCloseAfter(entryAt);
  const res = await sizeOn(acct, plan.instrument, plan.direction, price, entryAt, holdUntil, ctx, { targets: plan.targets.map((t) => t.price), ...(catalystId ? { catalystId } : {}) });
  if (res.blocked || res.maxUnits <= 0) return { plan: bare, sizing: res };
  return { plan: { ...bare, instrument: res.instrument, size: { units: res.maxUnits, notionalUsd: res.notionalUsd, leverage: res.leverage, failPrice: res.failPrice } }, sizing: res };
}

/** The smaller contract on the same underlying that the account may trade (MNQ for NQ). */
function microOf(instrument: string, rules: AccountRules): string | null {
  const spec = INSTRUMENTS[instrument];
  if (!spec || spec.pointValue <= 0) return null;
  return Object.values(INSTRUMENTS).find((i) => i.kind === 'future' && i.priceSymbol === spec.priceSymbol && i.pointValue < spec.pointValue && rules.instruments.includes(i.symbol))?.symbol ?? null;
}

/**
 * One sizing run on one account. When not even one contract of a future survives the worst case and the account
 * trades its micro, the micro is sized instead: same price series, same levels, a tenth of the risk per contract.
 */
async function sizeOn(
  acct: Account, instrument: string, direction: TradePlan['direction'], price: number, entryAt: number, holdUntil: number, ctx: SizeCtx,
  extra: { targets?: number[]; catalystId?: string } = {},
): Promise<SizingResult> {
  const run = async (sym: string): Promise<SizingResult> => sizing.sizeTrade({
    rules: acct.rules, state: acct.state, instrument: sym, direction, price, entryAt, holdUntil, now: ctx.now,
    catalysts: ctx.catalysts, ...(extra.catalystId ? { isCatalystTrade: { catalystId: extra.catalystId } } : {}),
    candles: await sizingCandles(ctx.reader, sym), ...(extra.targets ? { targets: extra.targets } : {}), openPositions: ctx.positions,
  });
  const first = await run(instrument);
  const micro = microOf(instrument, acct.rules);
  if (!micro || !first.blocked || !/is under one /.test(first.blockReason ?? '')) return first;
  const second = await run(micro);
  return second.blocked ? first : second;
}

/**
 * Active accounts that can take a trade on `instrument` entered at `entryAt`, best first: the one the sizing engine
 * gives the largest survivable notional. Accounts the sizing engine blocks are returned apart, with the reason.
 */
export async function rankAccounts(instrument: string, isDataRelease: boolean, entryAt: number, price: number, ctx: SizeCtx): Promise<{ fit: AccountRules[]; blocked: Array<{ name: string; reason: string }> }> {
  const scored: Array<{ rules: AccountRules; notional: number }> = [];
  const blocked: Array<{ name: string; reason: string }> = [];
  const unfit: AccountRules[] = [];
  for (const a of ctx.accounts) {
    const fit = cat.fitAccount([a.rules], instrument, isDataRelease, entryAt);
    if (!fit.accountId) { unfit.push(a.rules); continue; }
    const at = Math.max(ctx.now, entryAt);
    const trial = await sizeOn(a, fit.instrument, 'long', price, at, cat.cashCloseAfter(at), ctx);
    if (trial.blocked || trial.maxUnits <= 0) blocked.push({ name: a.rules.name, reason: trial.blockReason ?? 'no size' });
    else scored.push({ rules: a.rules, notional: trial.notionalUsd });
  }
  scored.sort((x, y) => y.notional - x.notional || x.rules.id.localeCompare(y.rules.id));
  // Unfit accounts stay on the list so the matrix notes say why each was passed over.
  return { fit: [...scored.map((s) => s.rules), ...unfit], blocked };
}

/* ───────────────────────── matrices ───────────────────────── */

const matrixConsensus = (m: ScenarioMatrix): number | null => (m.inputs.catalyst as { consensus?: number | null } | undefined)?.consensus ?? null;

/** Why a matrix is due now, or null. 20:00 ET the day before, 06:00 ET on the day, on demand when missing, and when the consensus moved. */
export function matrixDue(c: Catalyst, now: number): string | null {
  const T = Date.parse(c.scheduledAt);
  if (c.status !== 'upcoming' || c.tier === 3 || c.code === 'ADHOC' || T <= now || T - now > PLAN_WINDOW_MS) return null;
  if (cat.cannotPlanReason(c) !== null) return null;
  if (!c.matrix) return 'missing';
  const gen = Date.parse(c.matrix.generatedAt);
  const run = cat.matrixRunTimes(c);
  if (now >= Date.parse(run.dayOf) && gen < Date.parse(run.dayOf)) return '06:00 ET run';
  if (now >= Date.parse(run.dayBefore) && gen < Date.parse(run.dayBefore)) return '20:00 ET run';
  if (matrixConsensus(c.matrix) !== c.consensus) return 'consensus changed';
  return null;
}

export interface MatrixRun { generated: Catalyst[]; skipped: Array<{ id: string; name: string; reason: string }>; intents: NotificationIntent[] }

/** Generates every matrix that is due (all inside the 36-hour window when `force`), sizes each branch trade and stores the catalysts. */
export async function generateMatrices(deps: DeskDeps, now: number, opts: { force?: boolean; catalysts?: Catalyst[]; reader?: CandleReader } = {}): Promise<MatrixRun> {
  const reader = opts.reader ?? candleReader(deps, now);
  const all = opts.catalysts ?? await deps.store.list('catalysts', { since: iso(now - DAY), until: iso(now + LOOKAHEAD_MS), order: 'asc' });
  const run: MatrixRun = { generated: [], skipped: [], intents: [] };
  const due = all.map((c) => ({ c, why: matrixDue(c, now) ?? (opts.force && matrixDue({ ...c, matrix: null }, now) ? 'forced' : null) })).filter((x) => x.why !== null);
  if (due.length === 0) return run;

  const [profile, reg, past, predictions] = await Promise.all([
    profileOf(deps), regime(deps, now, reader), pastEvents(deps, now), deps.store.list('predictions', { since: iso(now - 2 * DAY), until: iso(now + 1) }),
  ]);
  const ctx = await sizeCtx(deps, now, reader, all);
  const us10y = await historyCandles(reader, 'US10Y');
  for (const { c } of due) {
    const instrument = c.instruments[0] ?? 'NQ';
    const price = await lastPrice(deps, instrument, now, reader);
    if (!price || !reg) { run.skipped.push({ id: c.id, name: c.name, reason: `no ${instrument} price in the store` }); continue; }
    const spec = cat.SPECS[c.code];
    if (!spec) continue;
    const entryAt = cat.entryTimeFor(c, spec);
    const ranked = await rankAccounts(instrument, spec.family !== 'earnings' && spec.family !== 'adhoc', entryAt, price.price, ctx);
    const matrix = cat.generateMatrix(c, {
      now, referencePrice: price.price, regime: reg, predictionMarkets: predictions, profile, pastEvents: past, upcoming: all,
      rateHistory: cat.buildRateHistory(c.keyedOn ?? c.code, past, us10y, 8, now),
      ...(ranked.fit.length > 0 ? { accounts: ranked.fit } : {}),
    });
    const sized: Record<string, unknown> = {};
    for (const b of matrix.branches) {
      if (!b.trade) continue;
      const r = await sizePlan(b.trade, price.price, ctx, c.id);
      b.trade = r.plan;
      if (r.sizing) sized[b.id] = { accountId: r.sizing.accountId, blocked: r.sizing.blocked, blockReason: r.sizing.blockReason, maxUnits: r.sizing.maxUnits, notionalUsd: r.sizing.notionalUsd, failPrice: r.sizing.failPrice, worstMove: r.sizing.worstMove, room: r.sizing.room, asOf: r.sizing.asOf };
    }
    matrix.inputs = { ...matrix.inputs, sizing: sized, referencePriceRead: { asOf: price.asOf, source: price.source, stale: price.stale } };
    if (price.stale) matrix.regimeNotes.push(`Reference price ${fmtNum(price.price, 2)} is stale: ${price.source}, ${price.age} old. Levels move with it.`);
    if (ctx.accounts.length === 0) matrix.regimeNotes.push('No active account with a balance entered: trades are unsized.');
    for (const b of ranked.blocked) matrix.regimeNotes.push(`${b.name} passed over: ${b.reason}`);

    if (c.matrix) {
      for (const b of matrix.branches) {
        const before = c.matrix.branches.find((x) => x.id === b.id);
        if (!before || b.probabilitySource !== 'prediction_market') continue;
        const shift = notify.branchProbabilityShift(c, b, before.probability * 100, b.probability * 100, now);
        if (shift) run.intents.push(shift);
      }
    }
    run.generated.push({ ...c, matrix });
  }
  if (run.generated.length) await deps.store.put('catalysts', run.generated);
  for (const s of run.skipped) logOf(deps).warn(`catalysts: no matrix for ${s.name}: ${s.reason}`);
  return run;
}

/* ───────────────────────── live handling ───────────────────────── */

/**
 * The push for a catalyst just resolved to a branch: the branch read, and the branch trade re-sized at the current
 * price on its account. Tier 1 is a P0 with the pre-filled ticket when the plan is sized; lower tiers are a P1.
 */
export async function resolutionIntent(deps: DeskDeps, c: Catalyst, now: number, ctx: SizeCtx): Promise<NotificationIntent | null> {
  const T = Date.parse(c.scheduledAt);
  const y10 = await y10Since(deps, T, now);
  // Levels were written the night before; re-anchor them to the price now before they are pushed or sized.
  const branchTrade = c.matrix?.branches.find((b) => b.id === c.resolution?.branchId)?.trade ?? null;
  const price = branchTrade ? await lastPrice(deps, branchTrade.instrument, now, ctx.reader) : null;
  const bn = cat.branchNotification(c, y10 ? { y10: y10.y10, y10ChangeBp: y10.y10ChangeBp } : undefined, price?.price);
  if (!bn) return null;
  let plan = bn.plan;
  if (plan && price) plan = (await sizePlan(plan, price.price, ctx, c.id)).plan;
  if (c.tier === 1) return notify.tier1Resolved(c, { lines: bn.lines, plan });
  const { ticketPrefill: _unsized, ...read } = bn.intent;
  return { ...read, deepLink: `/catalysts?id=${encodeURIComponent(c.id)}`, ...(plan?.size && bn.intent.ticketPrefill ? { ticketPrefill: { ...plan, reason: bn.intent.ticketPrefill.reason } } : {}) };
}

/** An actual is in but the branch is not decided: said once, with no trade. */
export function pendingIntent(c: Catalyst, now: number): NotificationIntent | null {
  if (c.tier !== 1 || !c.resolution || c.resolution.actual === null) return null;
  const centre = c.matrix?.inputs.centre as number | undefined;
  const what = c.code === 'FOMC' ? 'the statement tone' : 'the second number';
  return {
    class: 'P0', reason: 'tier1_pending', instrument: c.instruments[0] ?? null,
    lines: [`${c.name}: ${c.resolution.actual} vs ${centre ?? 'n/a'}.`, `No branch yet: the split needs ${what}. No trade until it is read.`],
    deepLink: `/catalysts?id=${encodeURIComponent(c.id)}`, dedupeKey: `tier1_pending:${c.id}`, ts: iso(now),
  };
}

/** 5- and 15-minute reaction readings for catalysts resolved in the last two hours, against their own history. */
export async function runReactionClock(deps: DeskDeps, now: number, catalysts: Catalyst[]): Promise<Catalyst[]> {
  const out: Catalyst[] = [];
  for (const c of catalysts) {
    const T = Date.parse(c.scheduledAt);
    if (c.status !== 'resolved' || c.code === 'ADHOC' || now < T || now - T > 2 * HOUR) continue;
    if (c.reaction?.verdict && c.reaction.m15Pct !== null && now - T > HOUR + 5 * MIN) continue;
    const candles = await fineCandles(deps, c.instruments[0] ?? 'NQ', T - 15 * MIN, now);
    const next = cat.reactionClock(c, candles, now);
    if (!same(next.reaction, c.reaction)) out.push(next);
  }
  if (out.length) await deps.store.put('catalysts', out);
  return out;
}

/**
 * A resolved branch's second-move entry: fires once, inside the hour after the entry time, and only when the store
 * can show the 10Y on the side of its pre-release level the trigger names. No rates reading, no trigger.
 */
export async function entryTriggers(deps: DeskDeps, now: number, catalysts: Catalyst[], ctx: SizeCtx): Promise<NotificationIntent[]> {
  const out: NotificationIntent[] = [];
  for (const c of catalysts) {
    const branch = c.matrix?.branches.find((b) => b.id === c.resolution?.branchId);
    const plan = branch?.trade;
    if (c.status !== 'resolved' || !branch || !plan?.entry.at || c.code === 'EARNINGS' || c.code === 'ADHOC') continue;
    const at = Date.parse(plan.entry.at);
    if (now < at || now - at > HOUR) continue;
    const y = await y10Since(deps, Date.parse(c.scheduledAt), now);
    if (!y) continue;
    const want = Math.sign(branch.ratesRead.y10Bp);
    const confirmed = want > 0 ? y.y10ChangeBp > 0 : want < 0 ? y.y10ChangeBp < 0 : plan.direction === 'long' ? y.y10ChangeBp <= 0 : y.y10ChangeBp >= 0;
    if (!confirmed) continue;
    const price = await lastPrice(deps, plan.instrument, now, ctx.reader);
    if (!price || price.stale) continue;
    const sized = (await sizePlan(plan, price.price, ctx, c.id)).plan;
    try {
      const intent = notify.entryTriggerFired(c, { price: price.price, now, plan: sized });
      if (intent) out.push(intent);
    } catch (e) {
      if (!(e instanceof notify.TradeNotificationError)) throw e;
    }
  }
  return out;
}

/**
 * Impact-3 headlines of the last two hours become ad-hoc catalysts with a two-branch matrix. No analog events are on
 * file, so each card says so; magnitudes come from the VIX when a fresh reading exists.
 */
export async function adhocCatalysts(deps: DeskDeps, now: number, ctx: SizeCtx): Promise<{ created: Catalyst[]; intents: NotificationIntent[] }> {
  const headlines: Headline[] = await deps.store.list('headlines', { since: iso(now - 2 * HOUR), until: iso(now + 1), status: '3', order: 'asc' });
  const created: Catalyst[] = [], intents: NotificationIntent[] = [];
  if (headlines.length === 0) return { created, intents };
  const profile = await profileOf(deps);
  const vixD = await freshDatum(deps, DATUM_KEYS.vix, now);
  for (const h of headlines) {
    for (const p of ctx.positions) { const i = notify.impact3Headline(h, p); if (i) intents.push(i); }
    // Same id and instrument the engine derives, checked first so a stored card is never rebuilt at a later price.
    if (await deps.store.get('catalysts', hashId('cat', 'ADHOC', h.dedupeKey))) continue;
    const instrument = h.symbols.find((s) => INSTRUMENTS[s]?.tradable) ?? 'NQ';
    const price = await lastPrice(deps, instrument, now, ctx.reader);
    if (!price) continue;
    const ranked = await rankAccounts(instrument, false, Date.parse(h.ts) + 15 * MIN, price.price, ctx);
    const c = cat.adhocCatalyst(h, {
      now, referencePrice: price.price, instrument, profile, analogEvents: [], analogCandles: await ctx.reader.closed(instrument, '1d'),
      vix: vixD ? { value: vixD.value, asOf: vixD.asOf } : null, ...(ranked.fit.length ? { accounts: ranked.fit } : {}),
    });
    if (!c?.matrix) continue;
    for (const b of c.matrix.branches) if (b.trade) b.trade = (await sizePlan(b.trade, price.price, ctx, c.id)).plan;
    if (price.stale) c.matrix.regimeNotes.push(`Reference price ${fmtNum(price.price, 2)} is stale: ${price.source}, ${price.age} old.`);
    created.push(c);
  }
  if (created.length) await deps.store.put('catalysts', created);
  return { created, intents };
}

export interface CatalystStep { catalysts: Catalyst[]; matched: Catalyst[]; intents: NotificationIntent[] }

/** The loop's catalyst step: refresh, matrices that are due, pushes for anything just resolved, reaction clock, triggers, ad-hoc. */
export async function runCatalysts(deps: DeskDeps, now: number, reader: CandleReader = candleReader(deps, now)): Promise<CatalystStep> {
  const refreshed = await refreshCatalysts(deps, now, reader);
  const matrices = await generateMatrices(deps, now, { catalysts: refreshed.catalysts, reader });
  const byId = new Map(refreshed.catalysts.map((c) => [c.id, c]));
  for (const g of matrices.generated) byId.set(g.id, g);
  const ctx = await sizeCtx(deps, now, reader, [...byId.values()]);
  const intents: NotificationIntent[] = [...matrices.intents];
  for (const c of refreshed.matched) {
    const late = now - Date.parse(c.scheduledAt);
    if (late > LATE_RESOLUTION_MS) { logOf(deps).warn(`catalysts: ${c.name} resolved ${Math.round(late / MIN)} min after the release: recorded, not pushed`); continue; }
    const i = await resolutionIntent(deps, c, now, ctx);
    if (i) intents.push(i);
  }
  for (const c of refreshed.pending) { const i = pendingIntent(c, now); if (i) intents.push(i); }
  for (const c of await runReactionClock(deps, now, [...byId.values()])) byId.set(c.id, c);
  intents.push(...await entryTriggers(deps, now, [...byId.values()], ctx));
  const adhoc = await adhocCatalysts(deps, now, ctx);
  for (const c of adhoc.created) byId.set(c.id, c);
  intents.push(...adhoc.intents);
  return { catalysts: [...byId.values()].sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)), matched: refreshed.matched, intents };
}

/** The next catalyst the trader plans around: the soonest upcoming Tier 1 or 2, else the soonest of any tier. */
export async function nextCatalyst(deps: DeskDeps, now: number): Promise<Catalyst | null> {
  const up = await deps.store.list('catalysts', { since: iso(now), until: iso(now + LOOKAHEAD_MS), status: 'upcoming', order: 'asc' });
  return up.find((c) => c.tier < 3) ?? up[0] ?? null;
}
