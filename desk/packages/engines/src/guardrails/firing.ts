import { hashId, iso, type GuardrailFiring, type GuardrailPattern } from '@desk/contracts';
import type { GuardrailContext } from './context';
import { ledgerLine } from './voice';

export interface FiringSpec {
  pattern: GuardrailPattern;
  /** One per pattern per episode: position id, flush date, local night, ticket id... */
  episodeKey: string;
  /** A later stage of the same episode (late night: 'ask' then 'watch') is a new statement, not a repeat. */
  stage?: string;
  text: string;
  effect: GuardrailFiring['effect'];
  capUnits?: number;
  trigger: GuardrailFiring['trigger'];
  evidence: Record<string, unknown>;
}

export const priorInEpisode = (ctx: GuardrailContext, pattern: GuardrailPattern, episodeKey: string): GuardrailFiring[] =>
  ctx.priorFirings.filter((f) => f.pattern === pattern && f.episodeKey === episodeKey);

/**
 * Builds the firing. Inside an episode the flag is stated once: a repeat keeps its effect (a block still blocks)
 * but its text is replaced by the override-ledger number alone, and `evidence.repeat` is true.
 */
export function fire(ctx: GuardrailContext, spec: FiringSpec): GuardrailFiring {
  const stage = spec.stage ?? 'flag';
  const prior = priorInEpisode(ctx, spec.pattern, spec.episodeKey);
  const repeat = prior.some((f) => (f.evidence.stage ?? 'flag') === stage);
  return {
    id: hashId('gf', spec.pattern, spec.episodeKey, spec.trigger.kind, spec.trigger.ref, ctx.now),
    ts: iso(ctx.now), pattern: spec.pattern, episodeKey: spec.episodeKey,
    text: repeat ? ledgerLine(ctx.ledger) : spec.text,
    blocks: spec.effect === 'block' || spec.effect === 'read_only',
    effect: spec.effect,
    ...(spec.capUnits !== undefined ? { capUnits: spec.capUnits } : {}),
    trigger: spec.trigger,
    evidence: { ...spec.evidence, stage, repeat, episodeFirings: prior.length, ...(repeat ? { firstStatedText: spec.text, ledger: ctx.ledger } : {}), asOf: iso(ctx.now) },
    followUp: null,
  };
}
