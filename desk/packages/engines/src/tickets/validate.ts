/**
 * Ticket validation (spec section 8, and section 1 rules 1-3 enforced in code).
 * Pure: the draft and the desk's current state in, errors or a saveable Ticket out.
 */
import { z } from 'zod';
import {
  EntryTrigger, HOUR, INSTRUMENTS, MIN, Ticket as TicketSchema, TicketDraft as TicketDraftSchema, TicketReason,
  fmtNum, hashId, iso, ms, notionalUsd, round,
  type Catalyst, type SizingResult, type StructureEvent, type Ticket, type TicketDraft, type Timeframe,
} from '@desk/contracts';
import { etClock, favorable, px, sign, sortedFills, underlying } from './position';

/** A resolved catalyst stays a valid reason for this long. */
export const CATALYST_RESOLVED_WINDOW_MS = 2 * HOUR;
/** How long a confirmed setup stays a valid reason, by the timeframe it formed on. */
export const SETUP_MAX_AGE_MS: Record<Timeframe, number> = { '1m': 2 * HOUR, '5m': 4 * HOUR, '15m': 8 * HOUR, '1h': 24 * HOUR, '1d': 72 * HOUR };
export const DEFAULT_REENTRY_COOLDOWN_MIN = 15;

export interface DraftError { field: string; message: string }
export interface ValidateContext {
  now: number;
  catalysts: Catalyst[];
  /** Confirmed setups from the chart watcher. */
  setups: StructureEvent[];
  sizing: SizingResult | null;
  accountIds: string[];
  recentTickets: Ticket[];
  /** Last price of the instrument; the reference for level checks unless the entry is a price trigger. */
  price: number;
  /** profile.circuitBreakers.reentryCooldownMin; 15 when omitted. */
  reentryCooldownMin?: number;
}
export interface DraftValidation {
  errors: DraftError[];
  ticket: Ticket | null;
  /** Error-free remarks, e.g. the size clamp. */
  notes: string[];
  /** Set while the re-entry cooldown blocks this draft. */
  reentryCooldownUntil: string | null;
  holdThroughCatalyst: { flag: boolean; catalystId: string | null };
  /** Reward to T1 over risk to invalidation. Reported, not enforced. */
  riskRewardT1: number | null;
  /** Price the levels were checked against. */
  referencePrice: number | null;
  asOf: string;
  inputs: Record<string, unknown>;
}

const NOWISH = /^(right\s+)?(now|market|mkt|at\s+(the\s+)?market|asap|immediately|immediate)?[.!]*$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const words = (s: string): number => s.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const num = (x: number): string => fmtNum(x, Number.isInteger(x) ? 0 : 2);
/** Epoch ms of a strict ISO instant (with zone), or null. */
export function parseInstant(v: unknown): number | null {
  if (typeof v !== 'string' || !ISO_INSTANT.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : null;
}

const TargetIn = z.object({ price: z.number().finite().positive(), fraction: z.number().finite().min(0).max(1).optional() });
const InvalidationIn = z.object({ price: z.number().finite().positive(), reason: z.string().optional() });

type Entry = z.infer<typeof EntryTrigger>;
function checkEntry(raw: unknown, now: number, errors: DraftError[]): Entry | null {
  const fail = (message: string): null => { errors.push({ field: 'entry', message }); return null; };
  const obj: Record<string, unknown> | null = typeof raw === 'string' ? { kind: 'condition', text: raw } : raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!obj) return fail('No entry trigger, no ticket. A price, a time, or a condition.');
  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  const kind = obj.kind;
  if (text !== '' && NOWISH.test(text)) return fail('"Now" is not a trigger. A price, a time, or a condition.');
  if (kind === 'price') {
    if (typeof obj.price !== 'number' || !Number.isFinite(obj.price) || obj.price <= 0) return fail('Price trigger with no price. Give the level.');
    return { kind, price: obj.price, text: text || `at ${px(obj.price)}` };
  }
  if (kind === 'time') {
    const at = parseInstant(obj.at);
    if (at === null) return fail('Time trigger with no time. ISO format, in the future.');
    if (at <= now) return fail(`Entry time ${etClock(at)} is already gone. Set the next one or name the condition.`);
    return { kind, at: iso(at), text: text || `at ${etClock(at)}` };
  }
  if (kind === 'condition') {
    if (text === '') return fail('"Now" is not a trigger. A price, a time, or a condition.');
    if (words(text) < 3) return fail('A condition is three words minimum: what has to happen first.');
    return { kind, text };
  }
  return fail('No entry trigger, no ticket. A price, a time, or a condition.');
}

interface ReasonCheck { reason: TicketReason; ref: string; setup: StructureEvent | null }
function checkReason(draft: TicketDraft, ctx: ValidateContext, errors: DraftError[]): ReasonCheck | null {
  const fail = (message: string): null => { errors.push({ field: 'reason', message }); return null; };
  const parsed = TicketReason.safeParse(draft.reason);
  if (!parsed.success) return fail('No catalyst, no trade. Free text is not a reason; pick a catalyst or a confirmed setup.');
  const reason = parsed.data;
  if (reason.kind === 'catalyst') {
    const c = ctx.catalysts.find((x) => x.id === reason.catalystId);
    if (!c) return fail(`Catalyst ${reason.catalystId} is not on the calendar. No catalyst, no trade.`);
    if (c.status === 'resolved') {
      const resolvedAt = ms(c.resolution?.resolvedAt ?? c.scheduledAt);
      const ageMin = Math.round((ctx.now - resolvedAt) / MIN);
      if (ctx.now - resolvedAt > CATALYST_RESOLVED_WINDOW_MS) return fail(`${c.name} resolved ${ageMin} min ago. 120 min is the limit; that trade has left.`);
    }
    return { reason, ref: c.id, setup: null };
  }
  const s = ctx.setups.find((x) => x.id === reason.setupEventId);
  if (!s || !s.confirmedSetup) return fail(`Setup ${reason.setupEventId} is not on the confirmed list. No setup, no trade.`);
  if (underlying(s.instrument) !== underlying(draft.instrument)) return fail(`That setup is on ${s.instrument}. This ticket is ${draft.instrument}.`);
  const ageMs = ctx.now - ms(s.ts);
  const limit = SETUP_MAX_AGE_MS[s.tf];
  if (ageMs > limit) return fail(`Setup is ${Math.round(ageMs / MIN)} min old. ${limit / MIN} min is the limit on a ${s.tf} setup; wait for a fresh one.`);
  if (s.bias !== 0 && s.bias !== sign(draft.direction)) return fail(`That setup is ${s.bias > 0 ? 'bullish' : 'bearish'}. The ticket is ${draft.direction}.`);
  return { reason, ref: s.id, setup: s };
}

/** Latest stop-out in the same underlying and direction, with the ticket it belonged to. */
function lastStopOut(draft: TicketDraft, tickets: Ticket[]): { at: number; ticket: Ticket } | null {
  let best: { at: number; ticket: Ticket } | null = null;
  for (const t of tickets) {
    if (t.direction !== draft.direction || underlying(t.instrument) !== underlying(draft.instrument)) continue;
    for (const f of sortedFills(t)) if (f.kind === 'stop' && (!best || ms(f.ts) > best.at)) best = { at: ms(f.ts), ticket: t };
  }
  return best;
}

/**
 * Tier-1 catalyst between entry and time stop. Macro Tier-1s count for every instrument; an earnings Tier-1
 * counts when it names the instrument or its underlying. A ticket whose reason is the catalyst itself and whose
 * trigger is a price or a condition is a reaction trade (entered on the resolution), so that catalyst is not
 * counted against it; with a time trigger the comparison is exact.
 */
export function tier1InWindow(catalysts: Catalyst[], instrumentSymbol: string, fromMs: number, toMs: number, exceptId: string | null = null): Catalyst | null {
  const u = underlying(instrumentSymbol);
  const hits = catalysts.filter((c) => {
    const at = ms(c.scheduledAt);
    if (c.tier !== 1 || c.status === 'resolved' || c.id === exceptId || at < fromMs || at > toMs) return false;
    return c.code !== 'EARNINGS' || c.symbol === instrumentSymbol || c.instruments.some((i) => i === instrumentSymbol || i === u);
  });
  hits.sort((a, b) => ms(a.scheduledAt) - ms(b.scheduledAt));
  return hits[0] ?? null;
}

export function validateDraft(draftIn: TicketDraft, ctx: ValidateContext): DraftValidation {
  const errors: DraftError[] = [];
  const notes: string[] = [];
  const cooldownMin = ctx.reentryCooldownMin ?? DEFAULT_REENTRY_COOLDOWN_MIN;
  const out: DraftValidation = {
    errors, ticket: null, notes, reentryCooldownUntil: null, holdThroughCatalyst: { flag: false, catalystId: null }, riskRewardT1: null, referencePrice: null,
    asOf: iso(ctx.now),
    inputs: { draft: draftIn, price: ctx.price, sizing: ctx.sizing, accountIds: ctx.accountIds, catalystIds: ctx.catalysts.map((c) => c.id), setupIds: ctx.setups.map((s) => s.id), recentTicketIds: ctx.recentTickets.map((t) => t.id), reentryCooldownMin: cooldownMin },
  };
  const shape = TicketDraftSchema.safeParse(draftIn);
  if (!shape.success) {
    for (const i of shape.error.issues) errors.push({ field: String(i.path[0] ?? 'ticket'), message: i.path[0] === 'units' ? 'Size is a positive number, at or under the engine max.' : `${String(i.path[0] ?? 'Ticket')} is missing or malformed.` });
    return out;
  }
  const draft = shape.data;
  const dir = sign(draft.direction);
  const side = (above: boolean): string => (above ? 'above' : 'below');

  if (!ctx.accountIds.includes(draft.accountId)) errors.push({ field: 'accountId', message: `Account ${draft.accountId} is not on the desk. Pick one that is.` });
  const spec = INSTRUMENTS[draft.instrument];
  if (!spec || !spec.tradable) errors.push({ field: 'instrument', message: `${draft.instrument} is not a tradable instrument here.` });

  const reason = checkReason(draft, ctx, errors);
  const entry = checkEntry(draft.entry, ctx.now, errors);

  /* Size: from the engine, down only. */
  const sizing = ctx.sizing;
  let units: number | null = null;
  if (!sizing) errors.push({ field: 'size', message: 'No size from the sizing engine, no ticket. Size is computed, never typed.' });
  else if (sizing.accountId !== draft.accountId || sizing.instrument !== draft.instrument || sizing.direction !== draft.direction) {
    errors.push({ field: 'size', message: `Sizing was run for ${sizing.instrument} ${sizing.direction} on ${sizing.accountId}; the ticket is ${draft.instrument} ${draft.direction} on ${draft.accountId}. Re-run it.` });
  } else if (sizing.blocked) errors.push({ field: 'size', message: sizing.blockReason ?? 'The sizing engine blocked this ticket.' });
  else {
    const whole = (spec?.pointValue ?? 0) > 0;
    const max = whole ? Math.floor(sizing.maxUnits + 1e-9) : sizing.maxUnits;
    if (!(max > 0)) errors.push({ field: 'size', message: 'Engine max is 0. Nothing survives the worst path on this account right now.' });
    else {
      const asked = draft.units ?? max;
      const sized = Math.min(whole ? Math.floor(asked + 1e-9) : asked, max);
      if (!(sized > 0)) errors.push({ field: 'size', message: 'Under 1 contract is not a size.' });
      else {
        units = sized;
        if (asked > max) notes.push(`Size cut to ${num(max)} from ${num(asked)}. Engine max is ${num(max)}; down only, never up.`);
      }
    }
  }

  const ref = entry?.kind === 'price' && entry.price !== undefined ? entry.price : ctx.price;
  const refOk = Number.isFinite(ref) && ref > 0;
  if (!refOk) errors.push({ field: 'entry', message: 'No live price to check the levels against. Fix the feed first.' });
  else out.referencePrice = ref;

  /* Targets: three, right side, in order, fractions sum to 1. */
  let targets: Ticket['targets'] | null = null;
  const rawTargets = draft.targets;
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) errors.push({ field: 'targets', message: 'No targets, no ticket. Three exits before the entry.' });
  else if (rawTargets.length !== 3) errors.push({ field: 'targets', message: `${rawTargets.length} ${rawTargets.length === 1 ? 'target' : 'targets'}. The plan is three, written before the entry.` });
  else {
    const p = z.tuple([TargetIn, TargetIn, TargetIn]).safeParse(rawTargets);
    if (!p.success) errors.push({ field: 'targets', message: 'Each target is a price and a fraction. Three of them.' });
    else {
      const given = p.data.reduce((a, t) => a + (t.fraction ?? 0), 0);
      const missing = p.data.filter((t) => t.fraction === undefined).length;
      const filled = p.data.map((t) => ({ price: t.price, fraction: t.fraction ?? (missing === 3 ? 1 / 3 : Math.max(0, 1 - given) / missing) })) as Ticket['targets'];
      const sum = filled.reduce((a, t) => a + t.fraction, 0);
      const before = errors.length;
      if (refOk) {
        const wrong = filled.findIndex((t) => favorable(draft.direction, ref, t.price) <= 0);
        if (wrong >= 0) errors.push({ field: 'targets', message: `T${wrong + 1} ${px(filled[wrong]!.price)} is on the wrong side of a ${draft.direction} from ${px(ref)}. Targets go ${side(dir > 0)}.` });
      }
      if (!(favorable(draft.direction, filled[0].price, filled[1].price) > 0 && favorable(draft.direction, filled[1].price, filled[2].price) > 0)) errors.push({ field: 'targets', message: 'Targets out of order. T1 nearest, T3 farthest.' });
      if (filled.some((t) => !(t.fraction > 0))) errors.push({ field: 'targets', message: 'A target with 0 size is not a scale-out. Every target takes something off.' });
      else if (Math.abs(sum - 1) > 0.01) errors.push({ field: 'targets', message: `Scale-out fractions sum to ${sum.toFixed(2)}. They sum to 1.` });
      if (errors.length === before) targets = filled;
    }
  }

  /* Invalidation: losing side, with the reason. */
  let invalidation: Ticket['invalidation'] | null = null;
  const inv = InvalidationIn.safeParse(draft.invalidation);
  if (!inv.success) errors.push({ field: 'invalidation', message: 'No invalidation, no ticket. One price that proves the idea wrong.' });
  else {
    const why = (inv.data.reason ?? '').trim();
    const before = errors.length;
    if (refOk && favorable(draft.direction, ref, inv.data.price) >= 0) errors.push({ field: 'invalidation', message: `Invalidation ${px(inv.data.price)} is on the winning side of a ${draft.direction} from ${px(ref)}. It goes ${side(dir < 0)}.` });
    if (words(why) < 3) errors.push({ field: 'invalidation', message: 'Invalidation needs its reason: three words minimum on why that price kills the thesis.' });
    if (errors.length === before) invalidation = { price: inv.data.price, reason: why };
  }

  /* Time stop: required, ISO, in the future. */
  let timeStop: number | null = null;
  if (draft.timeStop === undefined || draft.timeStop === null || draft.timeStop === '') errors.push({ field: 'timeStop', message: 'No time stop, no ticket. Name the latest time the thesis is still alive.' });
  else {
    const t = parseInstant(draft.timeStop);
    if (t === null) errors.push({ field: 'timeStop', message: 'Time stop is not a time. ISO with a zone, e.g. 2026-11-17T20:00:00Z.' });
    else if (t <= ctx.now) errors.push({ field: 'timeStop', message: `Time stop ${etClock(t)} is already behind us. It goes in the future.` });
    else if (entry?.kind === 'time' && entry.at !== undefined && ms(entry.at) >= t) errors.push({ field: 'timeStop', message: `Entry ${etClock(entry.at)} is at or after the time stop ${etClock(t)}. The stop comes last.` });
    else timeStop = t;
  }

  if (refOk && targets && invalidation) {
    const risk = -favorable(draft.direction, ref, invalidation.price);
    out.riskRewardT1 = risk > 0 ? round(favorable(draft.direction, ref, targets[0].price) / risk, 2) : null;
  }

  /* Hold-through-catalyst flag: set here, blocked (or not) by the sizing engine. */
  if (timeStop !== null) {
    const from = entry?.kind === 'time' && entry.at !== undefined ? ms(entry.at) : ctx.now;
    const except = entry && entry.kind !== 'time' && reason?.reason.kind === 'catalyst' ? reason.reason.catalystId : null;
    const hit = tier1InWindow(ctx.catalysts, draft.instrument, from, timeStop, except);
    out.holdThroughCatalyst = { flag: hit !== null, catalystId: hit?.id ?? null };
  }

  /* Re-entry rule. */
  const stop = lastStopOut(draft, ctx.recentTickets);
  if (stop && reason) {
    const until = stop.at + cooldownMin * MIN;
    if (ctx.now < until) {
      const prior = stop.ticket.reason;
      const fresh = reason.reason.kind === 'catalyst'
        ? !(prior.kind === 'catalyst' && prior.catalystId === reason.reason.catalystId)
        : reason.setup !== null && ms(reason.setup.ts) > stop.at && !(prior.kind === 'structure' && prior.setupEventId === reason.setup.id);
      if (!fresh) {
        out.reentryCooldownUntil = iso(until);
        const ago = Math.max(0, Math.floor((ctx.now - stop.at) / MIN));
        errors.push({ field: 'reentry', message: `Stopped out ${ago} min ago. ${cooldownMin} min cooldown, ${Math.ceil((until - ctx.now) / MIN)} left. New catalyst or new structure, or wait until ${etClock(until)}.` });
      }
    }
  }

  if (errors.length > 0 || !reason || !entry || units === null || !targets || !invalidation || timeStop === null || !sizing || !refOk) return out;

  const scale = sizing.maxUnits > 0 ? units / sizing.maxUnits : 1;
  const ticket: Ticket = {
    id: hashId('tkt', draft.accountId, draft.instrument, draft.direction, iso(ctx.now), reason.ref),
    createdAt: iso(ctx.now), accountId: draft.accountId, instrument: draft.instrument, direction: draft.direction,
    reason: reason.reason, entry,
    size: {
      engineMaxUnits: sizing.maxUnits, units, notionalUsd: round(notionalUsd(draft.instrument, units, ref), 2),
      leverage: sizing.leverage === null ? null : round(sizing.leverage * scale, 2),
      /** The engine's fail price at max size; a smaller size fails farther away, so this is the conservative one. */
      failPrice: sizing.failPrice,
    },
    targets, invalidation, timeStop: iso(timeStop),
    holdThroughCatalyst: out.holdThroughCatalyst,
    status: 'planned', fills: [], overrides: [], watcherEventIds: reason.setup ? [reason.setup.id] : [],
    closedAt: null, result: null, sizingSnapshot: sizing,
    ...(draft.notes ? { notes: draft.notes } : {}),
  };
  out.ticket = TicketSchema.parse(ticket);
  return out;
}
