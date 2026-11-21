/** Entry points: what the API calls on a ticket, a chat message, the open positions and the session. */
import type { GuardrailFiring } from '@desk/contracts';
import type { GuardrailContext, TicketLike } from './context';
import { CHAT_RULES, POSITION_RULES, TICKET_RULES, circuitBreaker, claimPrompts } from './rules';
import { normalizeTicket } from './util';

const present = (f: GuardrailFiring | null): f is GuardrailFiring => f !== null;

/** Guardrails on a ticket draft or a saved ticket. `ctx.sizing` and `ctx.hedgeViolations` must be the ones computed for it. */
export function checkTicket(ticket: TicketLike, ctx: GuardrailContext): GuardrailFiring[] {
  const input = normalizeTicket(ticket, ctx);
  return TICKET_RULES.map((rule) => rule(input, ctx)).filter(present);
}

/** Guardrails on one message the trader typed. */
export function checkChat(message: string, ctx: GuardrailContext): GuardrailFiring[] {
  return CHAT_RULES.map((rule) => rule(message, ctx)).filter(present);
}

/** Guardrails on every open position (thin fail price, catalyst hold). */
export function checkPositions(ctx: GuardrailContext): GuardrailFiring[] {
  return ctx.positions.flatMap((held) => POSITION_RULES.map((rule) => rule(held, ctx)).filter(present));
}

/** Daily circuit breakers: read-only after three plan-breaking trades, and the Vest claim prompt. */
export function checkSession(ctx: GuardrailContext): GuardrailFiring[] {
  return [circuitBreaker(ctx), ...claimPrompts(ctx)].filter(present);
}

export type GuardrailEffect = GuardrailFiring['effect'];
/** Strongest first. */
export const EFFECT_ORDER: GuardrailEffect[] = ['block', 'read_only', 'downgrade_to_watch', 'cap_size', 'none'];

export interface CombinedEffect {
  effect: GuardrailEffect;
  blocks: boolean;
  /** Tightest cap across every cap_size firing; applies whenever the ticket is not stopped outright. */
  capUnits: number | null;
  /** Firings that produced the winning effect. */
  decidedBy: string[];
}

/** Strongest effect wins: block > read_only > downgrade_to_watch > cap_size > none. */
export function combineEffects(firings: GuardrailFiring[]): CombinedEffect {
  const effect = EFFECT_ORDER.find((e) => firings.some((f) => f.effect === e)) ?? 'none';
  const caps = firings.filter((f) => f.effect === 'cap_size' && f.capUnits !== undefined).map((f) => f.capUnits!);
  return {
    effect, blocks: effect === 'block' || effect === 'read_only',
    capUnits: caps.length > 0 ? Math.min(...caps) : null,
    decidedBy: effect === 'none' ? [] : firings.filter((f) => f.effect === effect).map((f) => f.id),
  };
}
