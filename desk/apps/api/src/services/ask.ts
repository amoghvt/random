/**
 * Ask: the question is routed, the feeds are re-read when it asks for live data, one cited fact sheet is built from the
 * store and the memory index, the guardrails read the message, and the answer comes from the LLM only when a key is
 * configured and the answer passes the engine's checks; otherwise from the rules. Both messages are kept in the chat.
 */
import { DAY, hashId, iso, ms, type AskBody, type AskReply, type ChatMessage } from '@desk/contracts';
import { briefs as b } from '@desk/engines';
import { llmFromEnv, type LlmClient } from '@desk/feeds';
import { errText } from '../log';
import { currentCalls } from './bias';
import { logOf, profileOf, type DeskDeps } from './context';
import { checkChat } from './guardrails';
import { priceSymbolOf, quotesWithFallback, ratesStrip } from './market';
import { searchMemory } from './memory';
import { positionsView } from './positions';
import { refreshNow } from './refresh';
import { ledgerOf } from './tickets';

const BASE_QUOTES = ['NQ', 'ES', 'VIX', 'DXY'];
const MEMORY_HITS = 5;
const ANSWER_TOKENS = 700;
const HISTORY_LIMIT = 200;

const llmOf = (deps: DeskDeps): LlmClient => deps.llm ?? llmFromEnv({ ANTHROPIC_API_KEY: deps.env.ANTHROPIC_API_KEY });

/** Everything the answer may cite, read from the store as of `now`. */
export async function askContext(deps: DeskDeps, text: string, now: number): Promise<b.AskCtx> {
  const profile = await profileOf(deps);
  const route = b.routeQuestion(text);
  const symbols = [...new Set([...BASE_QUOTES, ...profile.instruments.primary, ...route.instruments].map(priceSymbolOf))];
  const until = iso(now + 1);
  const [calls, rates, quotes, catalysts, view, headlines, ledger, tickets, structure, memoryHits] = await Promise.all([
    currentCalls(deps, now), ratesStrip(deps, now), quotesWithFallback(deps, now, symbols),
    deps.store.list('catalysts', { since: iso(now - DAY), until: iso(now + 14 * DAY), order: 'asc' }),
    positionsView(deps, now), deps.store.list('headlines', { since: iso(now - DAY), until }), ledgerOf(deps, now),
    deps.store.list('tickets', { since: iso(now - 90 * DAY), until, limit: 1 }),
    deps.store.list('structure_events', { since: iso(now - DAY), until }),
    searchMemory(deps, text, now, { k: MEMORY_HITS }),
  ]);
  return {
    now, profile, calls, rates, quotes, catalysts, headlines, memoryHits,
    positions: view.positions.map((p) => ({ position: p.position, status: p.status, ticket: p.ticket })), accounts: view.accounts,
    // With no trade on the books there is no ledger to quote.
    ledger: tickets.length ? ledger : null, journalAsOf: iso(now),
    structure: structure.filter((e) => e.confirmedSetup),
  };
}

export async function ask(deps: DeskDeps, body: AskBody, now: number): Promise<AskReply> {
  const text = body.text.trim();
  const log = logOf(deps);
  if (body.checkLive === true || b.needsLiveCheck(text)) {
    // A failed re-read does not stop the answer: every fact carries its as-of, so old data reads as old.
    try { await refreshNow(deps, now); } catch (e) { log.warn(`ask: live check failed: ${errText(e)}`); }
  }
  // Memory is searched before this question is stored, so it cannot match itself.
  const ctx = await askContext(deps, text, now);
  const guardrails = await checkChat(deps, text, now);
  const question: ChatMessage = { id: hashId('chat', now, 'trader', text), ts: iso(now), role: 'trader', text };

  let engine: AskReply['engine'] = 'rules';
  let message: ChatMessage | null = null;
  const llm = llmOf(deps);
  if (llm.available) {
    try {
      const sheet = b.buildAskContext(ctx);
      const answer = await llm.complete({ system: b.askSystemPrompt(ctx.profile), messages: [{ role: 'user', content: b.askUserPrompt(text, sheet) }], maxTokens: ANSWER_TOKENS });
      const check = b.validateAskAnswer(answer, sheet);
      if (check.ok) { message = b.finalizeAnswer(answer, sheet, now); engine = 'llm'; }
      else log.warn(`ask: LLM answer discarded (${check.problems.join('; ')})`);
    } catch (e) { log.warn(`ask: LLM failed, answering by rules: ${errText(e)}`); }
  }
  message ??= b.answerByRules(text, ctx);
  // The reply sorts after the question it answers.
  const reply: ChatMessage = { ...message, ts: iso(Math.max(deps.clock(), now + 1)) };
  await deps.store.put('chat', [question, reply]);
  return { message: reply, guardrails, engine };
}

/** The conversation, oldest first. */
export async function askHistory(deps: DeskDeps, now: number): Promise<ChatMessage[]> {
  const recent = await deps.store.list('chat', { until: iso(now + DAY), limit: HISTORY_LIMIT });
  return recent.sort((x, y) => ms(x.ts) - ms(y.ts) || (x.role === y.role ? 0 : x.role === 'trader' ? -1 : 1));
}
