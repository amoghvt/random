/** Guardrails over the journal: the context every rule reads, the four entry points, firings persisted once per episode. */
import {
  BIAS_TEXT, DAY, KV, MIN, fromZoned, iso, median, zoned,
  type Candle, type GuardrailFiring, type HedgeViolation, type NotificationIntent, type SizingResult, type Ticket, type TicketDraft,
} from '@desk/contracts';
import { bias, guardrails as g, tickets as tk } from '@desk/engines';
import { accounts } from './accounts';
import { profileOf, type DeskDeps } from './context';
import { priceSymbolOf } from './market';
import { storedHeld, type Held } from './positions';

export interface ContextExtras {
  /** For a ticket check: the sizing result and hedge violations computed for that ticket. */
  sizing?: SizingResult;
  hedgeViolations?: HedgeViolation[];
  /** True when the draft cites a new catalyst or a new confirmed setup, which lifts the re-entry cooldown. */
  reentryCleared?: boolean;
  /** Fresh position statuses from this loop; the stored ones are read when omitted. */
  held?: Held[];
}

/** Everything a guardrail may look at, assembled from the store as of `now`. */
export async function guardrailContext(deps: DeskDeps, now: number, extra: ContextExtras = {}): Promise<g.GuardrailContext> {
  const profile = await profileOf(deps);
  const tz = profile.timezone;
  const [tickets, held, structure, catalysts, laggedFacts, priorFirings, accts, calls, thresholds] = await Promise.all([
    deps.store.list('tickets', { since: iso(now - 90 * DAY), until: iso(now + 1) }),
    extra.held ? Promise.resolve(extra.held) : storedHeld(deps),
    deps.store.list('structure_events', { since: iso(now - DAY), until: iso(now + 1) }),
    deps.store.list('catalysts', { since: iso(now - DAY), until: iso(now + 14 * DAY), order: 'asc' }),
    deps.store.list('lagged_facts', { since: iso(now - 200 * DAY) }),
    deps.store.list('guardrail_firings', { since: iso(now - 35 * DAY), until: iso(now + 1) }),
    accounts(deps, now),
    deps.store.list('bias_calls', { since: iso(now - 30 * DAY), until: iso(now + 1) }),
    deps.store.kvGet<Partial<g.Thresholds>>(KV.guardrailThresholds),
  ]);

  const symbols = new Set<string>(profile.instruments.primary.map(priceSymbolOf));
  for (const t of tickets) if (t.status === 'open' || t.status === 'planned') symbols.add(priceSymbolOf(t.instrument));
  for (const h of held) symbols.add(priceSymbolOf(h.position.instrument));
  const d1: Record<string, Candle[]> = {}, m1: Record<string, Candle[]> = {};
  const confirmationDays: Record<string, g.FlushState[]> = {};
  const th = { ...g.DEFAULT_THRESHOLDS, ...(thresholds ?? {}) };
  for (const s of symbols) {
    d1[s] = await deps.store.getCandles(s, '1d', { to: now, limit: 120 });
    m1[s] = await deps.store.getCandles(s, '1m', { to: now, limit: 60 });
    confirmationDays[s] = g.findFlushes(d1[s], now, th);
  }

  const cooldownMin = profile.circuitBreakers.reentryCooldownMin;
  const reentry: g.ReentryCooldown[] = tickets.flatMap((t) => {
    if (t.status !== 'closed' || !tk.stoppedOut(t)) return [];
    const at = tk.replayFills(t).lastExitTs;
    if (at === null || now - at >= cooldownMin * MIN) return [];
    return [{ accountId: t.accountId, instrument: t.instrument, direction: t.direction, stoppedAt: iso(at), until: iso(at + cooldownMin * MIN), cleared: extra.reentryCleared === true }];
  });

  const sized = tickets.filter((t) => t.status !== 'cancelled' && t.status !== 'watch' && t.size.notionalUsd > 0).slice(0, 20).map((t) => t.size.notionalUsd);
  const correctReads: g.CorrectRead[] = calls.filter((c) => bias.isResolvedDirectional(c) && c.outcome?.correct === true)
    .map((c) => ({ ts: c.createdAt, instrument: c.instrument, what: `${c.instrument} ${BIAS_TEXT[c.call].toLowerCase()}`, sourceId: c.id }));

  return {
    now, tz, profile, ledger: tk.overrideLedger(tickets, now, tz), tickets, positions: held, structure, catalysts,
    candles: { d1, m1 }, hedgeViolations: extra.hedgeViolations ?? [], ...(extra.sizing ? { sizing: extra.sizing } : {}),
    laggedFacts, priorFirings, confirmationDays,
    accountStates: accts.map((a) => a.state), medianNotional20: sized.length ? median(sized) : null,
    accountRules: accts.map((a) => ({ id: a.rules.id, firm: a.rules.firm, claimPromptGainPct: a.rules.claimPromptGainPct })),
    reentry, correctReads, thresholds: thresholds ?? {},
  };
}

/** A flag is stated once per episode. In the loop a repeat is the same statement again and is not written twice. */
async function persist(deps: DeskDeps, firings: GuardrailFiring[], keepRepeats: boolean): Promise<GuardrailFiring[]> {
  const kept = keepRepeats ? firings : firings.filter((f) => f.evidence.repeat !== true);
  if (kept.length) await deps.store.put('guardrail_firings', kept);
  return kept;
}

/** Guardrails on a draft or a saved ticket. `save: false` previews without writing to the journal. */
export async function checkTicket(deps: DeskDeps, ticket: Ticket | TicketDraft, now: number, extra: ContextExtras & { save?: boolean } = {}): Promise<GuardrailFiring[]> {
  const firings = g.checkTicket(ticket, await guardrailContext(deps, now, extra));
  if (extra.save !== false) await persist(deps, firings, true);
  await applyReadOnly(deps, firings, now);
  return firings;
}

/** Guardrails on one message the trader typed. Every firing is journaled, repeats included (they carry the ledger line). */
export async function checkChat(deps: DeskDeps, message: string, now: number): Promise<GuardrailFiring[]> {
  const firings = g.checkChat(message, await guardrailContext(deps, now));
  await persist(deps, firings, true);
  return firings;
}

/** End of the local day the breaker fired on: the desk reopens tomorrow. */
function endOfLocalDay(now: number, tz: string): number {
  const z = zoned(now, tz);
  return fromZoned(z.year, z.month, z.day + 1, 0, 0, tz);
}

async function applyReadOnly(deps: DeskDeps, firings: GuardrailFiring[], now: number): Promise<void> {
  const breaker = firings.find((f) => f.effect === 'read_only');
  if (!breaker) return;
  const profile = await profileOf(deps);
  await deps.store.kvSet(KV.readOnlyUntil, iso(endOfLocalDay(now, profile.timezone)));
  if (breaker.evidence.repeat !== true) await deps.store.kvSet(KV.readOnlyReason, breaker.text);
}

export interface GuardrailStep { firings: GuardrailFiring[]; intents: NotificationIntent[]; flags: Record<string, string> }

/**
 * The loop's guardrail pass over open positions and the session. Returns the new firings, a P2 for a claim prompt or
 * the circuit breaker, and `flags`: the pattern line per position id, for line 3 of that position's own notification.
 */
export async function runGuardrails(deps: DeskDeps, now: number, held?: Held[]): Promise<GuardrailStep> {
  const ctx = await guardrailContext(deps, now, held ? { held } : {});
  const position = g.checkPositions(ctx);
  const session = g.checkSession(ctx);
  await applyReadOnly(deps, session, now);
  const firings = await persist(deps, [...position, ...session], false);
  const flags: Record<string, string> = {};
  for (const f of firings) if (f.trigger.kind === 'position') flags[f.trigger.ref] = f.text;
  const intents: NotificationIntent[] = firings.filter((f) => f.pattern === 'claim_prompt' || f.pattern === 'circuit_breaker').map((f) => {
    const [first = f.text, ...rest] = g.sentences(f.text);
    return {
      class: 'P2' as const, reason: f.pattern, instrument: null, lines: [first, rest.join(' ')].filter((l) => l.length > 0),
      deepLink: f.pattern === 'claim_prompt' ? `/positions?id=${encodeURIComponent(f.trigger.ref)}` : '/journal',
      dedupeKey: `${f.pattern}:${f.episodeKey}`, ts: f.ts,
    };
  });
  return { firings, intents, flags };
}

/** The acknowledgement the fairness rule allows, when the journal has a recent correct read or plan-followed winner. */
export async function acknowledgement(deps: DeskDeps, now: number): Promise<g.Acknowledgement | null> {
  return g.acknowledgeCorrectRead(await guardrailContext(deps, now));
}
