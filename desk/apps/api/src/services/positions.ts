/** Open positions and live tickets: status of each position, cross-account hedges, plan deviations, alerts and post-exit settlement. */
import {
  DAY, KV, iso, pnlUsd,
  type HedgeViolation, type NotificationIntent, type Position, type PositionRow, type PositionStatus, type PositionsView, type Ticket,
} from '@desk/contracts';
import { notify, sizing, tickets as tk } from '@desk/engines';
import { accountRows, accounts, rulesById, withOpenPnl } from './accounts';
import type { DeskDeps } from './context';
import { candleReader, fineCandles, lastPrice, priceSymbolOf, sizingCandles, type CandleReader } from './market';

export interface Held { position: Position; status: PositionStatus }
export interface PositionStep { held: Held[]; unmarked: Position[]; intents: NotificationIntent[] }

/**
 * PositionStatus for every open position. A position whose instrument has no price in the store gets no status
 * (and is returned in `unmarked`): a distance to fail computed off a missing mark would be invented.
 */
export async function runPositions(deps: DeskDeps, now: number, reader: CandleReader = candleReader(deps, now)): Promise<PositionStep> {
  const positions = await deps.store.list('positions');
  const out: PositionStep = { held: [], unmarked: [], intents: [] };
  if (positions.length === 0) { await deps.store.kvSet(KV.positionStatus, {}); return out; }
  const [accts, catalysts] = await Promise.all([accounts(deps, now), deps.store.list('catalysts', { since: iso(now - DAY), until: iso(now + 14 * DAY) })]);
  const marks = new Map<string, number>();
  for (const p of positions) {
    const sym = priceSymbolOf(p.instrument);
    if (marks.has(sym)) continue;
    const price = await lastPrice(deps, p.instrument, now, reader);
    if (price) marks.set(sym, price.price);
  }
  const openPnl = (accountId: string): number | null => {
    let sum = 0;
    for (const p of positions.filter((x) => x.accountId === accountId)) {
      const mark = marks.get(priceSymbolOf(p.instrument));
      if (mark === undefined) return null;
      sum += pnlUsd(p.instrument, p.units, p.entryPrice, mark, p.direction);
    }
    return sum;
  };
  for (const p of positions) {
    const acct = accts.find((a) => a.rules.id === p.accountId);
    const mark = marks.get(priceSymbolOf(p.instrument));
    if (!acct || mark === undefined) { out.unmarked.push(p); continue; }
    const ticket = p.ticketId ? await deps.store.get('tickets', p.ticketId) : null;
    const status: PositionStatus = sizing.monitorPosition({
      position: p, rules: acct.rules, state: withOpenPnl(acct.state, openPnl(p.accountId)), mark, now,
      holdUntil: ticket ? Date.parse(ticket.timeStop) : null, catalysts, candles: await sizingCandles(reader, p.instrument),
    });
    out.held.push({ position: p, status });
    const critical = notify.positionCritical(p, status);
    if (critical) out.intents.push(critical);
  }
  await deps.store.kvSet(KV.positionStatus, Object.fromEntries(out.held.map((h) => [h.position.id, h.status])));
  return out;
}

export async function storedHeld(deps: DeskDeps): Promise<Held[]> {
  const [positions, statuses] = await Promise.all([deps.store.list('positions'), deps.store.kvGet<Record<string, PositionStatus>>(KV.positionStatus)]);
  return positions.flatMap((position) => { const status = statuses?.[position.id]; return status ? [{ position, status }] : []; });
}

/** Opposite or correlated-opposite exposure across accounts. Pass the order about to be placed as `pending` to catch it first. */
export async function hedgeViolations(deps: DeskDeps, now: number, pending: sizing.Exposure | null = null): Promise<HedgeViolation[]> {
  const positions = await deps.store.list('positions');
  const exposures: sizing.Exposure[] = positions.map((p) => ({ accountId: p.accountId, instrument: p.instrument, direction: p.direction }));
  if (exposures.length + (pending ? 1 : 0) < 2) return [];
  const symbols = [...new Set([...exposures, ...(pending ? [pending] : [])].map((e) => priceSymbolOf(e.instrument)))];
  const daily: Record<string, Awaited<ReturnType<typeof deps.store.getCandles>>> = {};
  for (const s of symbols) daily[s] = await deps.store.getCandles(s, '1d', { to: now, limit: 200 });
  return sizing.detectHedges(exposures, pending, await rulesById(deps), sizing.correlationMatrix(daily));
}

export async function positionsView(deps: DeskDeps, now: number): Promise<PositionsView> {
  const [positions, statuses, rows, hedges] = await Promise.all([
    deps.store.list('positions'), deps.store.kvGet<Record<string, PositionStatus>>(KV.positionStatus), accountRows(deps, now), hedgeViolations(deps, now),
  ]);
  const out: PositionRow[] = [];
  for (const position of positions) {
    const ticket = position.ticketId ? await deps.store.get('tickets', position.ticketId) : null;
    const done = ticket ? ticket.fills.filter((f) => f.kind === 'scale_out').length : 0;
    out.push({ position, status: statuses?.[position.id] ?? null, ticket, nextTarget: ticket?.targets[done] ?? null });
  }
  return { asOf: iso(now), positions: out, accounts: rows, hedgeViolations: hedges };
}

export interface TicketStep { intents: NotificationIntent[]; deviated: Ticket[]; settled: Ticket[] }

/**
 * Each loop, for every live ticket: undeclared deviations are written on the ticket, an invalidation or time stop that
 * is due raises its P0, a planned ticket's price or time trigger raises its P1, and closed trades get their post-exit
 * numbers until the window (time stop plus one session) is complete.
 */
export async function runTickets(deps: DeskDeps, now: number, reader: CandleReader = candleReader(deps, now)): Promise<TicketStep> {
  const out: TicketStep = { intents: [], deviated: [], settled: [] };
  const live = await deps.store.list('tickets', { status: ['open', 'planned'] });
  const prevPrices = (await deps.store.kvGet<Record<string, number>>(KV.ticketPrices)) ?? {};
  const prices: Record<string, number> = {};

  for (const t of live) {
    const price = await lastPrice(deps, t.instrument, now, reader);
    if (!price || price.stale) continue;
    prices[t.id] = price.price;
    const prevPrice = prevPrices[t.id];
    if (t.status === 'planned') {
      const crossed = t.entry.kind === 'price' && t.entry.price !== undefined && prevPrice !== undefined
        && Math.sign(prevPrice - t.entry.price) !== Math.sign(price.price - t.entry.price);
      const timed = t.entry.kind === 'time' && t.entry.at !== undefined && now >= Date.parse(t.entry.at) && now - Date.parse(t.entry.at) < 15 * 60_000;
      if (crossed || timed) {
        try { const i = notify.entryTriggerFired(t, { price: price.price, now }); if (i) out.intents.push(i); } catch (e) { if (!(e instanceof notify.TradeNotificationError)) throw e; }
      }
      continue;
    }
    const first = tk.replayFills(t).firstEntryTs;
    let ticket = t;
    if (first !== null) {
      const candles = await fineCandles(deps, t.instrument, first, now);
      for (const d of tk.detectDeviations(t, candles, now)) {
        ticket = { ...ticket, overrides: [...ticket.overrides, { ts: d.ts, kind: d.kind, reason: `${tk.UNDECLARED}${d.reason}`, pnlImpactUsd: null }] };
      }
      if (ticket !== t) { await deps.store.put('tickets', [ticket]); out.deviated.push(ticket); }
    }
    for (const a of tk.ticketAlerts(ticket, price.price, now, prevPrice === undefined ? {} : { prevPrice })) {
      if (a.kind === 'invalidation') out.intents.push(notify.ticketInvalidationHit(ticket, price.price, now));
      else if (a.kind === 'time_stop') out.intents.push(notify.ticketTimeStopHit(ticket));
    }
  }
  await deps.store.kvSet(KV.ticketPrices, prices);

  const done = new Set((await deps.store.kvGet<string[]>(KV.ticketsSettled)) ?? []);
  const closed = (await deps.store.list('tickets', { status: 'closed', since: iso(now - 60 * DAY) })).filter((t) => !done.has(t.id) && t.result !== null && t.closedAt !== null);
  for (const t of closed) {
    const first = tk.replayFills(t).firstEntryTs ?? Date.parse(t.closedAt as string);
    const s = tk.settleResult(t, await fineCandles(deps, t.instrument, first, now), now);
    if (JSON.stringify(s.ticket) !== JSON.stringify(t)) { await deps.store.put('tickets', [s.ticket]); out.settled.push(s.ticket); }
    if (s.complete) done.add(t.id);
  }
  if (closed.length) await deps.store.kvSet(KV.ticketsSettled, [...done].slice(-2000));
  return out;
}
