/**
 * The ticket pipeline behind the routes. The form is not trusted: every draft is sized by the sizing engine, validated by
 * the tickets engine and passed through the guardrails here, and only what survives all three is written to the journal.
 */
import {
  DAY, INSTRUMENTS, MIN, TicketDraft as TicketDraftSchema, TicketReason, hhmm, iso, ms, pnlUsd,
  type Fill, type GuardrailFiring, type OverrideKind, type OverrideLedger, type OverridePrompt, type Position, type SizingResult,
  type StructureEvent, type Ticket, type TicketDraft, type TicketPreview, type TicketSaveResult,
} from '@desk/contracts';
import { catalyst as cat, guardrails as g, sizing, tickets as tk } from '@desk/engines';
import { HttpError } from '../http';
import { accounts } from './accounts';
import { sizeCtx } from './catalysts';
import { killSwitchOn, profileOf, readOnlyState, type DeskDeps } from './context';
import { checkTicket } from './guardrails';
import { candleReader, fineCandles, lastPrice, priceSymbolOf, sizingCandles } from './market';
import { hedgeViolations, runPositions } from './positions';

/** The contract's preview plus the engine's error-free remarks (the size clamp is one). */
export interface TicketPreviewEx extends TicketPreview { notes: string[] }
export interface TicketSaveResultEx extends TicketSaveResult { notes: string[] }

/** How far back a confirmed setup or a stop-out can still matter to a new draft. */
const SETUP_LOOKBACK_MS = 3 * DAY;
const TICKET_LOOKBACK_MS = 30 * DAY;
/** An override is accepted this long after its prompt was shown. */
export const OVERRIDE_PROMPT_TTL_MS = 15 * MIN;
const KV_PROMPTS = 'tickets.override_prompts';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why the desk takes no new ticket right now, or null. The kill switch outranks the circuit breaker. */
export async function sessionBlock(deps: DeskDeps, now: number): Promise<string | null> {
  if (await killSwitchOn(deps.store)) return 'Kill switch is on. No new tickets until it is off.';
  const ro = await readOnlyState(deps.store, now);
  if (!ro.readOnly) return null;
  return ro.reason ?? `Desk is read-only until ${hhmm(ro.until ?? now)} ET.`;
}

/** The window the sizing engine sizes over: from the entry trigger (now unless it is a later time) to the time stop. */
function holdWindow(draft: TicketDraft, now: number): { entryAt: number; holdUntil: number; timeEntry: boolean } {
  const at = isRecord(draft.entry) && draft.entry.kind === 'time' ? tk.parseInstant(draft.entry.at) : null;
  const entryAt = at !== null && at > now ? at : now;
  const stop = tk.parseInstant(draft.timeStop);
  // Without a usable time stop the draft cannot save; the size shown meanwhile is for a hold to the cash close.
  return { entryAt, holdUntil: stop !== null && stop > entryAt ? stop : cat.cashCloseAfter(entryAt), timeEntry: at !== null };
}

function targetPrices(draft: TicketDraft): number[] {
  if (!Array.isArray(draft.targets)) return [];
  return draft.targets.flatMap((t: unknown) => (isRecord(t) && typeof t.price === 'number' && Number.isFinite(t.price) ? [t.price] : []));
}

interface Evaluation { preview: TicketPreviewEx; ticket: Ticket | null }

async function evaluate(deps: DeskDeps, body: unknown, now: number, save: boolean): Promise<Evaluation> {
  const session = await sessionBlock(deps, now);
  const sessionErrors = session ? [{ field: 'session', message: session }] : [];
  const shape = TicketDraftSchema.safeParse(body);
  if (!shape.success) {
    const v = tk.validateDraft(body as TicketDraft, { now, catalysts: [], setups: [], sizing: null, accountIds: [], recentTickets: [], price: Number.NaN });
    return { ticket: null, preview: { ok: false, errors: [...sessionErrors, ...v.errors], sizing: null, guardrails: [], wouldSaveAs: 'blocked', reentryCooldownUntil: null, notes: [] } };
  }
  const draft = shape.data;
  const reader = candleReader(deps, now);
  const [profile, accts, price, ctx, events, recent] = await Promise.all([
    profileOf(deps), accounts(deps, now), lastPrice(deps, draft.instrument, now, reader), sizeCtx(deps, now, reader),
    deps.store.list('structure_events', { instrument: priceSymbolOf(draft.instrument), since: iso(now - SETUP_LOOKBACK_MS), until: iso(now + 1) }),
    deps.store.list('tickets', { since: iso(now - TICKET_LOOKBACK_MS), until: iso(now + 1) }),
  ]);
  const setups: StructureEvent[] = events.filter((e) => e.confirmedSetup);
  const acct = accts.find((a) => a.rules.id === draft.accountId);
  const window = holdWindow(draft, now);
  const reason = TicketReason.safeParse(draft.reason);
  // A ticket that cites the catalyst and waits for a price or a condition is the reaction trade; one timed ahead of the print is a hold through it.
  const catalystTrade = reason.success && reason.data.kind === 'catalyst' && !window.timeEntry ? { catalystId: reason.data.catalystId } : null;

  let sized: SizingResult | null = null;
  if (acct && price && INSTRUMENTS[draft.instrument]) {
    sized = sizing.sizeTrade({
      rules: acct.rules, state: acct.state, instrument: draft.instrument, direction: draft.direction, price: price.price,
      entryAt: window.entryAt, holdUntil: window.holdUntil, now, catalysts: ctx.catalysts, ...(catalystTrade ? { isCatalystTrade: catalystTrade } : {}),
      candles: await sizingCandles(reader, draft.instrument), targets: targetPrices(draft), openPositions: ctx.positions,
    });
  }

  const vctx: tk.ValidateContext = {
    now, catalysts: ctx.catalysts, setups, sizing: sized, accountIds: accts.map((a) => a.rules.id), recentTickets: recent,
    price: price?.price ?? Number.NaN, reentryCooldownMin: profile.circuitBreakers.reentryCooldownMin,
  };
  let v = tk.validateDraft(draft, vctx);

  // Guardrails see the size the ticket would carry: the request clamped to the engine's number, never above it.
  const clamped = sized && draft.units !== undefined ? sizing.clampUnits(draft.units, sized) : 0;
  const checked: TicketDraft = clamped > 0 ? { ...draft, units: clamped } : draft;
  const hedges = await hedgeViolations(deps, now, { accountId: draft.accountId, instrument: draft.instrument, direction: draft.direction });
  const firings: GuardrailFiring[] = await checkTicket(deps, checked, now, {
    ...(sized ? { sizing: sized } : {}), hedgeViolations: hedges, reentryCleared: v.reentryCooldownUntil === null,
    // A draft the session refuses is not journaled: nothing was decided on it.
    save: save && !session,
  });
  const effect = g.combineEffects(firings);
  if (effect.capUnits !== null && effect.capUnits > 0 && (draft.units === undefined || draft.units > effect.capUnits)) {
    v = tk.validateDraft({ ...draft, units: effect.capUnits }, vctx);
  }

  const errors = [...sessionErrors, ...v.errors];
  const blocked = errors.length > 0 || effect.blocks || v.ticket === null;
  const wouldSaveAs: TicketPreview['wouldSaveAs'] = blocked ? 'blocked' : effect.effect === 'downgrade_to_watch' ? 'watch' : 'planned';
  const ticket = blocked || !v.ticket ? null : wouldSaveAs === 'watch' ? { ...v.ticket, status: 'watch' as const } : v.ticket;
  return {
    ticket,
    preview: { ok: !blocked, errors, sizing: sized, guardrails: firings, wouldSaveAs, reentryCooldownUntil: v.reentryCooldownUntil, notes: v.notes },
  };
}

/** What saving this draft would do, without writing anything to the journal. */
export async function previewTicket(deps: DeskDeps, body: unknown, now: number): Promise<TicketPreviewEx> {
  return (await evaluate(deps, body, now, false)).preview;
}

/** Saves the draft as a planned ticket, or as a watch when a guardrail downgrades it. A refused draft returns the reasons and no ticket. */
export async function saveTicket(deps: DeskDeps, body: unknown, now: number): Promise<TicketSaveResultEx> {
  const { preview, ticket } = await evaluate(deps, body, now, true);
  if (ticket) await deps.store.put('tickets', [ticket]);
  return { ...preview, ticket };
}

export async function ticketOr404(deps: DeskDeps, id: string): Promise<Ticket> {
  const t = await deps.store.get('tickets', id);
  if (!t) throw new HttpError(404, 'No such ticket');
  return t;
}

export async function ledgerOf(deps: DeskDeps, now: number): Promise<OverrideLedger> {
  const [profile, tickets] = await Promise.all([profileOf(deps), deps.store.list('tickets', { since: iso(now - 90 * DAY), until: iso(now + 1) })]);
  const { monthToDateUsd, instances, lastPaidAt, planCapturePct, overrideCapturePct, pendingInstances } = tk.overrideLedger(tickets, now, profile.timezone);
  return { monthToDateUsd, instances, lastPaidAt, planCapturePct, overrideCapturePct, pendingInstances };
}

export async function ticketDetail(deps: DeskDeps, id: string, now: number): Promise<{ ticket: Ticket; ledger: OverrideLedger; events: StructureEvent[] }> {
  const ticket = await ticketOr404(deps, id);
  const found = await Promise.all(ticket.watcherEventIds.slice(-100).map((e) => deps.store.get('structure_events', e)));
  const events = found.filter((e): e is StructureEvent => e !== null).sort((a, b) => ms(b.ts) - ms(a.ts));
  return { ticket, ledger: await ledgerOf(deps, now), events };
}

const positionIdOf = (ticketId: string): string => `pos_${ticketId}`;

/** Keeps the position row of a ticket in step with its fills: open units at the average entry, gone when flat. */
async function syncPosition(deps: DeskDeps, ticket: Ticket, now: number): Promise<void> {
  const id = positionIdOf(ticket.id);
  const snap = tk.replayFills(ticket);
  const prev = await deps.store.get('positions', id);
  if (ticket.status !== 'open' || snap.openUnits <= tk.EPS || snap.avgEntry === null) {
    if (prev) await deps.store.remove('positions', id);
  } else {
    const position: Position = {
      id, accountId: ticket.accountId, ticketId: ticket.id, instrument: ticket.instrument, direction: ticket.direction,
      units: snap.openUnits, entryPrice: snap.avgEntry, openedAt: prev?.openedAt ?? iso(snap.firstEntryTs ?? now),
      liquidationPrice: prev?.liquidationPrice ?? null, leverage: prev?.leverage ?? ticket.size.leverage,
    };
    await deps.store.put('positions', [position]);
  }
  await runPositions(deps, now);
}

const stateError = (e: unknown): never => {
  if (e instanceof tk.TicketStateError) throw new HttpError(409, e.message);
  throw e;
};

/** Finishes a trade that is flat: undeclared deviations on the path become overrides and the result block is computed. */
async function closeOut(deps: DeskDeps, ticket: Ticket, exit: { price: number; ts: string }): Promise<Ticket> {
  const first = tk.replayFills(ticket).firstEntryTs ?? ms(exit.ts);
  const candles = await fineCandles(deps, ticket.instrument, first, ms(exit.ts));
  try { return tk.closeTicket(ticket, exit, candles); } catch (e) { return stateError(e); }
}

/**
 * Records one fill the trader confirmed. Deviations the fill itself proves (size past the ticket, an add under water, an
 * exit short of the plan) are logged as undeclared until the trader gives the reason through the override prompt.
 */
export async function fillTicket(deps: DeskDeps, id: string, fill: Fill, now: number): Promise<Ticket> {
  const ticket = await ticketOr404(deps, id);
  if (ticket.status === 'watch') throw new HttpError(409, 'A watch is not a trade. It takes no fills.');
  if (ms(fill.ts) > now + MIN) throw new HttpError(400, 'Fill time is in the future.');
  const out = tk.applyFill(ticket, fill, now);
  if (out.rejected) throw new HttpError(409, out.rejected);
  let next = out.ticket;
  for (const c of out.candidates) next = tk.recordOverride(next, c.kind, `${tk.UNDECLARED}${c.reason}`, now);
  if (out.flat) next = await closeOut(deps, next, { price: fill.price, ts: fill.ts });
  await deps.store.put('tickets', [next]);
  const state = await deps.store.get('account_states', next.accountId);
  if (state && (state.lastTradeAt === null || ms(state.lastTradeAt) < ms(fill.ts))) await deps.store.put('account_states', [{ ...state, lastTradeAt: iso(ms(fill.ts)) }]);
  await syncPosition(deps, next, now);
  return next;
}

export async function closeTicketAt(deps: DeskDeps, id: string, exit: { price: number; ts?: string }, now: number): Promise<Ticket> {
  const ticket = await ticketOr404(deps, id);
  const at = exit.ts === undefined ? now : tk.parseInstant(exit.ts);
  if (at === null) throw new HttpError(400, 'Close time is not a time. ISO with a zone.');
  if (at > now + MIN) throw new HttpError(400, 'Close time is in the future.');
  const closed = await closeOut(deps, ticket, { price: exit.price, ts: iso(at) });
  await deps.store.put('tickets', [closed]);
  await syncPosition(deps, closed, now);
  return closed;
}

export async function cancelTicketById(deps: DeskDeps, id: string, now: number): Promise<Ticket> {
  const ticket = await ticketOr404(deps, id);
  let cancelled: Ticket;
  try { cancelled = tk.cancelTicket(ticket, now); } catch (e) { return stateError(e); }
  await deps.store.put('tickets', [cancelled]);
  return cancelled;
}

/** Realized plus marked P&L of the ticket; null with no fills or no price to mark against. */
async function livePnl(deps: DeskDeps, ticket: Ticket, now: number): Promise<number | null> {
  const snap = tk.replayFills(ticket);
  if (snap.firstEntryTs === null) return null;
  if (snap.openUnits <= tk.EPS || snap.avgEntry === null) return Math.round(snap.realizedUsd * 100) / 100;
  const price = await lastPrice(deps, ticket.instrument, now);
  if (!price) return null;
  return Math.round((snap.realizedUsd + pnlUsd(ticket.instrument, snap.openUnits, snap.avgEntry, price.price, ticket.direction)) * 100) / 100;
}

/** The one screen shown before an override: the plan, the live P&L, the month's ledger. Showing it is what opens the override. */
export async function overridePromptFor(deps: DeskDeps, id: string, now: number): Promise<OverridePrompt> {
  const ticket = await ticketOr404(deps, id);
  const [profile, ledger, live] = await Promise.all([profileOf(deps), ledgerOf(deps, now), livePnl(deps, ticket, now)]);
  const shown = (await deps.store.kvGet<Record<string, string>>(KV_PROMPTS)) ?? {};
  const fresh = Object.fromEntries(Object.entries(shown).filter(([, at]) => now - ms(at) < OVERRIDE_PROMPT_TTL_MS));
  await deps.store.kvSet(KV_PROMPTS, { ...fresh, [id]: iso(now) });
  return { ticket, livePnlUsd: live, ledger, text: tk.overridePrompt(ticket, live, ledger, profile.timezone) };
}

/** Kinds logged once per ticket by the engine; the rest stack, so an undeclared one of those is claimed here instead of doubled. */
const ONCE: OverrideKind[] = ['size_up', 'held_through_invalidation', 'held_through_time_stop', 'added_to_loser'];

/** Logs the override with the trader's one-line reason. Refused until the prompt for this ticket has been shown. */
export async function overrideTicket(deps: DeskDeps, id: string, kind: OverrideKind, reason: string, now: number): Promise<Ticket> {
  const ticket = await ticketOr404(deps, id);
  const shownAt = (await deps.store.kvGet<Record<string, string>>(KV_PROMPTS))?.[id];
  if (!shownAt || now - ms(shownAt) >= OVERRIDE_PROMPT_TTL_MS) throw new HttpError(409, 'Override prompt first: the plan, the live P&L, the ledger. Then the reason.');
  let next: Ticket;
  const undeclared = ONCE.includes(kind) ? -1 : ticket.overrides.findIndex((o) => o.kind === kind && o.reason.startsWith(tk.UNDECLARED));
  if (undeclared >= 0) next = { ...ticket, overrides: ticket.overrides.map((o, i) => (i === undeclared ? { ...o, reason } : o)) };
  else { try { next = tk.recordOverride(ticket, kind, reason, now); } catch (e) { return stateError(e); } }
  await deps.store.put('tickets', [next]);
  return next;
}
