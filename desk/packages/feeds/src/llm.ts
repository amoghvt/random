/**
 * Generic LLM client shared by the headline classifier, matrix prose, guardrail wording and Ask.
 * `complete` returns the reply text; pass `schema` to get schema-constrained JSON text back
 * (structured outputs), which the caller still validates with zod.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { Env } from './types';

/** Most capable current model: prose (matrix text, briefs, Ask). */
export const DEFAULT_PROSE_MODEL = 'claude-fable-5-2';
/** Small, fast current model: classification. */
export const DEFAULT_CLASSIFY_MODEL = 'claude-haiku-5-5';

export interface LlmMessage { role: 'user' | 'assistant'; content: string }
export interface LlmRequest {
  system: string; messages: LlmMessage[]; maxTokens: number;
  /** Defaults to DEFAULT_PROSE_MODEL. */
  model?: string;
  /** When set, the reply is JSON text constrained to this schema. */
  schema?: z.ZodType;
  effort?: 'low' | 'medium' | 'high';
}
export interface LlmClient {
  /** False for `nullLlm`: callers use their rules/template path instead of calling. */
  readonly available: boolean;
  complete(req: LlmRequest): Promise<string>;
}

export class LlmUnavailableError extends Error {}

/** No key, no calls. `complete` rejects so a caller that forgot to check `available` still falls back. */
export const nullLlm: LlmClient = {
  available: false,
  complete: () => Promise.reject(new LlmUnavailableError('No LLM configured (ANTHROPIC_API_KEY is not set)')),
};

/** Models that accept the server-side refusal fallback; on these a policy decline re-runs on the routed fallback model. */
const SERVER_FALLBACK = /^claude-(fable-5-[12]|opus-5(-5)?)$/;

export class AnthropicLlm implements LlmClient {
  readonly available = true;
  private readonly client: Anthropic;
  constructor(opts: { apiKey?: string; client?: Anthropic } = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async complete(req: LlmRequest): Promise<string> {
    const model = req.model ?? DEFAULT_PROSE_MODEL;
    const output_config = { ...(req.effort ? { effort: req.effort } : {}), ...(req.schema ? { format: zodOutputFormat(req.schema) } : {}) };
    const base = { model, max_tokens: req.maxTokens, system: req.system, messages: req.messages, ...(Object.keys(output_config).length ? { output_config } : {}) };
    const res = SERVER_FALLBACK.test(model)
      ? await this.client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await this.client.messages.create(base);
    if (res.stop_reason === 'refusal') throw new Error(`LLM declined the request (${model})`);
    if (res.stop_reason === 'max_tokens') throw new Error(`LLM reply truncated at ${req.maxTokens} tokens (${model})`);
    let text = '';
    for (const block of res.content) if (block.type === 'text') text += block.text;
    if (!text) throw new Error(`LLM returned no text (${model})`);
    return text;
  }
}

/** Anthropic client when ANTHROPIC_API_KEY is set, otherwise `nullLlm`. */
export function llmFromEnv(env: Env): LlmClient {
  return env.ANTHROPIC_API_KEY ? new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY }) : nullLlm;
}
