import { describe, expect, it } from 'vitest';
import { BIAS_TEXT, HOUR, iso, type ChatMessage } from '@desk/contracts';
import { callLine } from './common';
import {
  answerByRules, askSystemPrompt, askUserPrompt, buildAskContext, finalizeAnswer, mentionedInstruments, needsLiveCheck, routeQuestion,
  validateAskAnswer, type AskContext,
} from './ask';
import { NOW, at, syntheticAsk, syntheticCall, syntheticCatalyst, syntheticProfile } from './fixtures';
import { extractNumbers, numbersNotOnSheet, stripStamps } from './numbers';
import type { AskCtx } from './types';

const ASK_NOW = NOW + 4 * HOUR; // 10:30 ET

/** Every numeric token in a rules answer sits on a line with an as-of stamp and comes from a fact the message cites. */
function expectFullyStamped(msg: ChatMessage, sheet: AskContext): void {
  const citedText = sheet.facts.filter((f) => msg.citations!.some((c) => c.label === f.label && c.asOf === f.asOf)).map((f) => f.text).join('\n');
  expect(numbersNotOnSheet(msg.text, citedText)).toEqual([]);
  for (const line of msg.text.split('\n')) {
    if (extractNumbers(line).length > 0) expect(line).toMatch(/\(as of (?:[A-Z][a-z]{2} \d{1,2} )?\d{2}:\d{2} ET(?:, stale)?\)/);
  }
  expect(msg.asOf).toBeDefined();
  for (const c of msg.citations!) expect(c.source.length).toBeGreaterThan(0);
}

describe('routing', () => {
  it('classifies intents by rule', () => {
    const intent = (q: string): string => routeQuestion(q).intent;
    expect(intent('up or down today?')).toBe('up_or_down');
    expect(intent("what's the bias")).toBe('up_or_down');
    expect(intent('long or short?')).toBe('up_or_down');
    expect(intent('thoughts on SNDK')).toBe('instrument');
    expect(intent('what happened the last three times I held through earnings')).toBe('past_trades');
    expect(intent('how far is my position from the fail price')).toBe('position');
    expect(intent('what is the CPI consensus')).toBe('catalyst');
    expect(intent('when can I request a payout on apex')).toBe('account');
    expect(intent('tell me a joke')).toBe('other');
    expect(routeQuestion('NVDA or amd into the print?').instruments).toEqual(['NVDA', 'AMD']);
    expect(mentionedInstruments('nasdaq and gold')).toEqual(['NQ', 'GC']);
    expect(mentionedInstruments('NQ-PERP fail price')).toEqual(['NQ-PERP']);
    expect(mentionedInstruments('es muy bueno, mu')).toEqual([]);
  });
  it('needsLiveCheck', () => {
    expect(needsLiveCheck('check live, where is the 10Y')).toBe(true);
    expect(needsLiveCheck('where is NQ right now')).toBe(true);
    expect(needsLiveCheck('latest on NVDA')).toBe(true);
    expect(needsLiveCheck('up or down today?')).toBe(false);
  });
});

describe('fact sheet', () => {
  it('cites every fact with a source and an as-of, flags stale ones, and says "no data" for empty groups', () => {
    const sheet = buildAskContext(syntheticAsk());
    expect(sheet.facts.every((f) => f.source.length > 0 && !Number.isNaN(Date.parse(f.asOf)))).toBe(true);
    expect(sheet.primary?.id).toBe('call_syn_1');
    expect(sheet.text).toContain('CURRENT CALLS\n- NQ intraday: Lean short 0.62, expires 16:00 ET.');
    expect(sheet.text).toContain('- 10Y 4.94% −9 bp 1d (3h old) [synthetic rates, as of 07:30 ET, STALE]');
    expect(sheet.text).toContain('- 2Y 4.61% +2 bp 1d [synthetic rates, as of 06:29 ET]');
    expect(sheet.text).toContain('- NQ 27,062 +0.4% [synthetic feed, as of 10:29 ET]');
    expect(sheet.text).toContain('- Nov 25 Nov 25 08:30 ET PCE (T1): consensus 0.3%, whisper 0.2%, implied move ±1.1% (options). Branch trade: core 0.3 (p 0.45): No edge, stand aside until 09:15. Engine: Short the second move on a hot core. [synthetic calendar, as of 05:00 ET]');
    expect(sheet.text).toContain('- Overrides: −$1,240 month to date over 5 instances; plan capture 68% vs override capture 41%. [journal, as of Nov 19 17:00 ET]');
    expect(sheet.text).toContain('CONFIRMED SETUPS\n- no data');
    expect(sheet.text).toContain('MEMORY HITS\n- no data');
    expect(askUserPrompt('  up or down today? ', sheet)).toBe(`${sheet.text}\n\nQUESTION\nup or down today?`);
  });
});

describe('rules answers', () => {
  it('up or down returns the current call unchanged', () => {
    const ctx = syntheticAsk();
    const call = ctx.calls[0]!;
    const before = JSON.stringify(call);
    for (const q of ['up or down today?', "what's the bias", 'long or short?']) {
      const a = answerByRules(q, ctx);
      expect(a.text).toBe(`${callLine(call, ASK_NOW)} (as of 06:00 ET)`);
      expect(a.text).toContain(`${BIAS_TEXT[call.call]} ${call.probability.toFixed(2)}, expires 16:00 ET`);
      for (const fact of call.facts) expect(a.text).toContain(fact);
      expect(a.text).toContain(call.killCondition.text);
      expect(a.asOf).toBe(call.createdAt);
      expect(a.citations).toEqual([{ label: 'call NQ intraday', source: 'bias engine', asOf: call.createdAt }]);
      expect(a.role).toBe('desk');
    }
    expect(JSON.stringify(call)).toBe(before);
    // Asking twice gives the same call; a new answer needs a new call, not a new question.
    expect(answerByRules('up or down today?', ctx).text).toBe(answerByRules('up or down today?', { ...ctx, quotes: {} }).text);
    expect(answerByRules('up or down today?', { ...ctx, calls: [] }).text).toBe('No call on file. The bias engine has produced nothing to quote (as of 10:30 ET).');
  });

  it('Ask stamps the as-of time on every number', () => {
    const ctx = syntheticAsk({
      memoryHits: [
        { id: 'm1', kind: 'trade', ts: at(16, 0, 12), text: 'Synthetic: held NVDA through earnings, −$640, adherence 55, MAE −2.3%' },
        { id: 'm2', kind: 'trade', ts: at(16, 0, 5), text: 'Synthetic: held AMD through earnings, +$310, adherence 90' },
      ],
    });
    const sheet = buildAskContext(ctx);
    const questions = [
      'up or down today?', 'thoughts on SNDK', 'where is NQ', 'what happened the last three times I held through earnings', 'how is my position',
      'what is the PCE consensus', 'when is the CPI', 'apex payout status', 'how are my accounts', 'tell me something', 'where is the 10Y and VIX',
    ];
    for (const q of questions) {
      const a = answerByRules(q, ctx);
      expect(a.text.length, q).toBeGreaterThan(0);
      expect(a.text, q).toMatch(/\(as of /);
      expectFullyStamped(a, sheet);
    }
    // Rules path, stale input: the age is inline and the stamp says stale.
    expect(answerByRules('tell me something', ctx).text).toContain('10Y 4.94% −9 bp 1d (3h old) (as of 07:30 ET, stale)');
    // Memory hits come back with their numbers.
    const past = answerByRules('what happened the last three times I held through earnings', ctx);
    expect(past.text.split('\n')).toEqual([
      '2026-11-12 trade: Synthetic: held NVDA through earnings, −$640, adherence 55, MAE −2.3%. (as of Nov 12 16:00 ET)',
      '2026-11-05 trade: Synthetic: held AMD through earnings, +$310, adherence 90. (as of Nov 5 16:00 ET)',
    ]);
    expect(answerByRules('what happened the last time I held through earnings', { ...ctx, memoryHits: [] }).text).toBe('Nothing in the journal matches that. No trades to cite (as of 10:30 ET).');

    // LLM path: an uncited number is rejected.
    const good = 'NQ 27,062 +0.4% (synthetic feed, as of 10:29 ET). 10Y 4.94%, 3h old and stale (as of 07:30 ET). NQ intraday: Lean short 0.62, expires 16:00 ET. Kill: 15m close above 27,140 (bias engine, as of 06:00 ET).';
    expect(validateAskAnswer(good, sheet)).toEqual({ ok: true, problems: [] });
    const invented = validateAskAnswer(good.replace('27,062', '27,480'), sheet);
    expect(invented.ok).toBe(false);
    expect(invented.problems).toEqual(['numbers not on the fact sheet: 27,480']);
    expect(validateAskAnswer('NQ sits at 27,062 with support at 26,500 (as of 10:29 ET).', sheet).problems).toEqual(['numbers not on the fact sheet: 26,500']);
    // LLM path: a direction without a probability and a kill condition is rejected.
    const bare = validateAskAnswer('Go long NQ here, yields are easing (as of 10:29 ET).', sheet);
    expect(bare.ok).toBe(false);
    expect(bare.problems).toEqual(['direction ("long") without a probability in 0.50-0.85', 'direction ("long") without a kill condition']);
    expect(validateAskAnswer('It closes down today (as of 10:29 ET).', sheet).ok).toBe(false);
    expect(validateAskAnswer('Lean short 0.62 (as of 06:00 ET).', sheet).problems).toEqual(['direction ("short") without a kill condition']);
    // No as-of stamp at all, a probability above the cap, a banned phrase.
    expect(validateAskAnswer('NQ 27,062.', sheet).problems).toEqual(['no as-of stamp']);
    expect(validateAskAnswer('Short NQ, probability 0.90, kill above 27,140 (as of 06:00 ET).', sheet).problems).toEqual(expect.arrayContaining(['probability above 0.85']));
    expect(validateAskAnswer('Perhaps wait. NQ 27,062 (as of 10:29 ET).', sheet).problems).toEqual(['banned phrase: "perhaps"']);
    // Descriptions that are not recommendations pass.
    expect(validateAskAnswer('VIX is down −2.6% at 18.40; short-term noise (synthetic feed, as of 10:29 ET).', sheet).ok).toBe(true);
    // Every rules answer also passes the LLM checks when a call is on file.
    for (const q of questions) expect(validateAskAnswer(answerByRules(q, ctx).text, sheet), q).toEqual({ ok: true, problems: [] });
  });

  it('an instrument with no catalyst and no structure signal gets "No edge" with the fact that would create one, then the current call', () => {
    const ctx = syntheticAsk();
    const lines = answerByRules('thoughts on SNDK', ctx).text.split('\n');
    expect(lines[0]).toBe('SNDK: no quote on file (as of 10:30 ET).');
    expect(lines[1]).toBe('No edge on SNDK. No catalyst on the calendar for it and no confirmed setup (as of 10:30 ET).');
    expect(lines[2]).toMatch(/^What would create one: a confirmed sweep-and-reclaim with an MSS on SNDK, or the next market catalyst\. Nov 25 Nov 25 08:30 ET PCE \(T1\)/);
    expect(lines.at(-2)).toBe('Current call: none on file for SNDK; that reads as No edge (as of 10:30 ET).');
    expect(lines.at(-1)).toBe(`Desk call: ${callLine(ctx.calls[0]!, ASK_NOW)} (as of 06:00 ET)`);
    expect(answerByRules('thoughts on SNDK', { ...ctx, catalysts: [] }).text).toContain('None is scheduled in the data I hold.');

    // With a catalyst or a confirmed setup on the instrument, the answer gives those instead.
    const withCat: AskCtx = { ...ctx, catalysts: [syntheticCatalyst({ id: 'e', code: 'EARNINGS', name: 'SNDK earnings', symbol: 'SNDK', instruments: ['SNDK'], scheduledAt: at(16, 5, 24) })] };
    expect(answerByRules('thoughts on SNDK', withCat).text).not.toContain('No edge on SNDK');
    expect(answerByRules('thoughts on SNDK', withCat).text).toContain('SNDK earnings (T1)');
    const withSetup: AskCtx = { ...ctx, structure: [{ id: 's1', detector: 'sweep_reclaim', kind: 'sweep_reclaim_mss', instrument: 'SNDK', tf: '15m', ts: at(10, 15), level: 212.4, bias: 1, confidence: 0.7, text: 'Synthetic: swept 212.40 and reclaimed with an MSS', data: {}, confirmedSetup: true }] };
    expect(answerByRules('thoughts on SNDK', withSetup).text).toContain('Setup: SNDK 15m: Synthetic: swept 212.40 and reclaimed with an MSS. (as of 10:15 ET)');
  });

  it('answers about an instrument end with its current call', () => {
    const ctx = syntheticAsk({ calls: [syntheticCall(), syntheticCall({ id: 'call_nvda', instrument: 'NVDA', call: 'no_edge', probability: 0.5, trade: null, facts: ['no catalyst until the print'], killCondition: { text: 'a confirmed setup on 15m' } })] });
    const nq = ctx.calls[0]!;
    for (const q of ['where is NQ', 'how is my NQ-PERP position', 'how is my position', 'is the NQ CPI trade on']) {
      expect(answerByRules(q, ctx).text.split('\n').at(-1), q).toBe(`Current call: ${callLine(nq, ASK_NOW)} (as of 06:00 ET)`);
    }
    expect(answerByRules('thoughts on NVDA', ctx).text.split('\n').at(-1)).toBe(`Current call: ${callLine(ctx.calls[1]!, ASK_NOW)} (as of 06:00 ET)`);
    expect(answerByRules('how is my position', { ...ctx, positions: [] }).text).toBe('No open positions (as of 10:30 ET).');
  });
});

describe('LLM path', () => {
  it('the system prompt carries the voice and the hard rules', () => {
    const p = askSystemPrompt(syntheticProfile());
    for (const s of ['Direct, specific, numbers first', '"consider"', 'Answer only from the FACT SHEET', 'as-of time', 'STALE', 'between 0.50 and 0.85', 'kill condition', 'Never invent', 'last line is its current call', 'No new analysis']) expect(p).toContain(s);
  });

  it('finalizeAnswer attaches asOf and the citations of the facts used', () => {
    const sheet = buildAskContext(syntheticAsk());
    const m = finalizeAnswer(' NQ 27,062 +0.4% (synthetic feed, as of 10:29 ET). 10Y 4.94%, stale (as of 07:30 ET). ', sheet, ASK_NOW);
    expect(m.text.startsWith('NQ 27,062')).toBe(true);
    expect(m.citations!.map((c) => c.label)).toEqual(expect.arrayContaining(['NQ', '10Y']));
    expect(m.citations!.map((c) => c.label)).not.toContain('VIX');
    expect(m.asOf).toBe(iso(NOW)); // the oldest fact used: the call that also carries 4.94 and 27,062-adjacent levels is older than the 10Y print
    expect(finalizeAnswer('No data.', sheet, ASK_NOW)).toMatchObject({ asOf: iso(ASK_NOW), citations: [], role: 'desk' });
  });
});

describe('number matching', () => {
  it('reads values, not names, times or stamps', () => {
    expect(extractNumbers('10Y 4.94% −9 bp 1d (3h old), N225 50,120, Tier-1 at 08:30 ET on Nov 20, 2s10s +33 bp, 15m close, $1,240').map((n) => n.raw)).toEqual(['4.94%', '−9 bp', '50,120', '+33 bp', '$1,240']);
    expect(stripStamps('x (as of Nov 20 16:00 ET, stale) y')).toBe('x   y');
    expect(numbersNotOnSheet('62% and 27,062.0 and 4.9%', 'p 0.62, 27,062, 4.94%')).toEqual([]);
    expect(numbersNotOnSheet('4.95% and 63%', 'p 0.62, 4.94%')).toEqual(['4.95%', '63%']);
  });
});
