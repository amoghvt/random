import { describe, expect, it } from 'vitest';
import { iso, type BiasCall, type Catalyst, type ChatMessage, type Fill, type GuardrailFiring, type JournalNote, type Ticket } from '@desk/contracts';
import {
  answerFromMemory, applyFill, buildIndex, buildIndexWith, closeTicket, cosine, features, parseMemoryQuestion, recordOverride, search, searchVector,
  tfidfEmbedder, toMemoryDocs, tokenize, validateDraft, type Embedder, type MemoryDoc, type SparseVector,
} from './index';
import { NOW, ctx, shortDraft, syntheticCatalyst, syntheticSizing } from './fixtures.test-util';

/* Every ticket below is synthetic: hand-written fills that exercise the renderer and the index. */
const earnings = (id: string, symbol: string, scheduledAt: string): Catalyst => syntheticCatalyst({ id, code: 'EARNINGS', symbol, name: `${symbol} Q3 earnings (synthetic)`, tier: 1, instruments: [symbol, 'NQ'], scheduledAt, status: 'resolved', resolution: { actual: null, branchId: null, resolvedAt: scheduledAt } });
const catalysts: Catalyst[] = [
  syntheticCatalyst({ id: 'cat_cpi', scheduledAt: '2026-11-17T13:30:00Z' }),
  earnings('cat_nvda', 'NVDA', '2026-11-18T21:20:00Z'), earnings('cat_amzn', 'AMZN', '2026-10-29T20:05:00Z'),
  earnings('cat_amd', 'AMD', '2026-11-03T21:15:00Z'), earnings('cat_intc', 'INTC', '2026-10-22T20:05:00Z'),
];
interface Spec { instrument: string; direction: 'long' | 'short'; accountId: string; catalystId: string; units: number; entry: [string, number]; exits: Array<[string, number, number, Fill['kind']]>; targets: [number, number, number]; inv: number; timeStop: string; overrides?: Array<[Parameters<typeof recordOverride>[1], string]> }
function syntheticTrade(s: Spec): Ticket {
  const now = Date.parse(s.entry[0]) - 60_000;
  const cat = catalysts.find((c) => c.id === s.catalystId)!;
  const r = validateDraft(
    shortDraft({ instrument: s.instrument, direction: s.direction, accountId: s.accountId, reason: { kind: 'catalyst', catalystId: s.catalystId }, entry: { kind: 'price', price: s.entry[1], text: `at ${s.entry[1]}` }, targets: s.targets.map((price) => ({ price })), invalidation: { price: s.inv, reason: 'thesis is wrong here' }, timeStop: s.timeStop }),
    ctx({ now, price: s.entry[1], catalysts: [{ ...cat, status: 'live', resolution: null }], accountIds: [s.accountId], sizing: syntheticSizing({ accountId: s.accountId, instrument: s.instrument, direction: s.direction, maxUnits: s.units }) }),
  );
  if (!r.ticket) throw new Error(r.errors.map((e) => e.message).join(' | '));
  let t = applyFill(r.ticket, { kind: 'entry', ts: s.entry[0], price: s.entry[1], units: s.units, source: 'manual' }, Date.parse(s.entry[0])).ticket;
  for (const [ts, price, units, kind] of s.exits.slice(0, -1)) t = applyFill(t, { kind, ts, price, units, source: 'manual' }, Date.parse(ts)).ticket;
  for (const [kind, reason] of s.overrides ?? []) t = recordOverride(t, kind, reason, Date.parse(s.entry[0]) + 60_000);
  const last = s.exits.at(-1)!;
  return closeTicket(t, { price: last[1], ts: last[0] }, []);
}

const tickets: Ticket[] = [
  // NQ-PERP short on CPI: the brief's example shape. $60,000 notional, three scale-outs.
  syntheticTrade({ instrument: 'NQ-PERP', direction: 'short', accountId: 'vest-instant', catalystId: 'cat_cpi', units: 60000, entry: ['2026-11-17T14:30:00Z', 27120], exits: [['2026-11-17T14:40:00Z', 27050, 20000, 'scale_out'], ['2026-11-17T15:10:00Z', 26980, 40000, 'exit']], targets: [27050, 26980, 26900], inv: 27200, timeStop: '2026-11-17T20:00:00Z', overrides: [['skipped_scale_out', 'wanted the flush']] }),
  // Three stock longs carried through the print, one stock long closed before it.
  syntheticTrade({ instrument: 'NVDA', direction: 'long', accountId: 'vest-instant', catalystId: 'cat_nvda', units: 20000, entry: ['2026-11-18T19:00:00Z', 180], exits: [['2026-11-19T14:35:00Z', 171, 20000, 'stop']], targets: [184, 188, 195], inv: 176, timeStop: '2026-11-18T20:55:00Z', overrides: [['held_through_time_stop', 'the print will be huge']] }),
  syntheticTrade({ instrument: 'AMD', direction: 'long', accountId: 'vest-instant', catalystId: 'cat_amd', units: 10000, entry: ['2026-11-03T19:30:00Z', 250], exits: [['2026-11-04T14:40:00Z', 262.5, 10000, 'exit']], targets: [255, 260, 270], inv: 244, timeStop: '2026-11-03T20:55:00Z', overrides: [['held_through_time_stop', 'guide looks strong']] }),
  syntheticTrade({ instrument: 'AMZN', direction: 'long', accountId: 'vest-instant', catalystId: 'cat_amzn', units: 15000, entry: ['2026-10-29T18:00:00Z', 200], exits: [['2026-10-30T14:31:00Z', 188, 15000, 'stop']], targets: [204, 208, 214], inv: 196, timeStop: '2026-10-29T19:55:00Z', overrides: [['held_through_time_stop', 'AWS will beat']] }),
  syntheticTrade({ instrument: 'INTC', direction: 'long', accountId: 'vest-instant', catalystId: 'cat_intc', units: 10000, entry: ['2026-10-21T15:00:00Z', 40], exits: [['2026-10-22T19:00:00Z', 42, 10000, 'exit']], targets: [41, 42, 44], inv: 38.5, timeStop: '2026-10-22T19:55:00Z' }),
];
const call: BiasCall = { id: 'call_1', instrument: 'NQ', horizon: 'intraday', call: 'lean_short', probability: 0.62, score: -0.8, factors: [], facts: ['10Y +6 bp after CPI'], trade: null, killCondition: { text: 'reclaims 27,300' }, nextCatalyst: null, expiresAt: '2026-11-17T21:00:00Z', createdAt: '2026-11-17T13:45:00Z', trigger: { kind: 'print', ref: 'cat_cpi' }, firstMoveUntrusted: false, referencePrice: 27150, inputs: {}, outcome: { resolvedAt: '2026-11-17T21:00:00Z', movePct: -0.4, correct: true } };
const firing: GuardrailFiring = { id: 'gf_1', ts: '2026-11-18T20:50:00Z', pattern: 'catalyst_hold', episodeKey: 'e1', text: 'Holding NVDA into the print. Implied move 7%; fail price 4% away. Flat by 15:55 ET.', blocks: false, effect: 'none', trigger: { kind: 'position', ref: 'p1' }, evidence: {}, followUp: { action: 'overrode', outcomeUsd: -1000 } };
const note: JournalNote = { id: 'n1', ts: '2026-11-01T12:00:00Z', text: 'my best trades are catalyst plus timing', tags: ['edge'], source: 'seed' };
const chat: ChatMessage = { id: 'm1', ts: '2026-11-19T15:00:00Z', role: 'trader', text: 'if I had held the NQ short I would have doubled' };
const docs = toMemoryDocs({ tickets, calls: [call], firings: [firing], notes: [note], chat: [chat], catalysts });
const index = buildIndex(docs);
const byRef = (ref: string): MemoryDoc => docs.find((d) => d.ref === ref)!;

describe('toMemoryDocs', () => {
  it('renders a trade with its actual numbers', () => {
    const d = byRef(tickets[0]!.id);
    // 20,000 x 70/27,120 + 40,000 x 140/27,120 = $258
    expect(d.text).toBe('2026-11-17 NQ-PERP short vest-instant, catalyst CPI, entry 27,120, exit 26,980, +$258, adherence 90, override: skipped_scale_out, held through earnings: no, skipped_scale_out reason: wanted the flush');
    expect(d).toMatchObject({ kind: 'trade', instrument: 'NQ-PERP', ts: '2026-11-17T14:30:00.000Z' });
    expect(d.tags).toEqual(expect.arrayContaining(['short', 'override', 'skipped_scale_out', 'catalyst:CPI', 'winner']));
    expect(d.data).toMatchObject({ entry: 27120, exit: 26980, adherence: 90, heldThroughEarnings: false });
    expect(d.data.pnlUsd).toBeCloseTo(258.11, 1);
  });

  it('tags held-through-earnings from the fills, not from the plan', () => {
    const nvda = byRef(tickets[1]!.id), intc = byRef(tickets[4]!.id);
    expect(nvda.text).toContain('entry 180, exit 171, −$1,000, adherence 80, override: held_through_time_stop, held through earnings: yes (NVDA earnings), stopped out');
    expect(nvda.tags).toEqual(expect.arrayContaining(['held_through_earnings', 'held_through_catalyst', 'held_through:EARNINGS', 'stopped_out', 'loser', 'catalyst:EARNINGS']));
    expect(intc.text).toContain('entry 40, exit 42, +$500, adherence 100, override: none, held through earnings: no');
    expect(intc.tags).toContain('followed_plan');
    expect(intc.tags).not.toContain('held_through_earnings');
  });

  it('renders calls, guardrail events, notes, chat and catalysts; skips tickets that never filled', () => {
    expect(docs.map((d) => d.kind).sort()).toEqual(['call', 'catalyst', 'catalyst', 'catalyst', 'catalyst', 'catalyst', 'chat', 'event', 'note', 'trade', 'trade', 'trade', 'trade', 'trade']);
    expect(byRef('call_1').text).toBe('2026-11-17 NQ intraday call Lean short 0.62 at 27,150, facts: 10Y +6 bp after CPI, kill: reclaims 27,300, outcome −0.40%, correct');
    expect(byRef('gf_1').text).toMatch(/guardrail catalyst_hold: Holding NVDA into the print\..* Trader overrode, outcome −\$1,000\.$/);
    expect(byRef('n1').text).toBe('2026-11-01 note: my best trades are catalyst plus timing');
    const unfilled = validateDraft(shortDraft(), ctx()).ticket!;
    expect(toMemoryDocs({ tickets: [unfilled] })).toEqual([]);
  });
});

describe('TF-IDF embedder and index', () => {
  it('tokenizes numbers, drops stop words, stems, and emits bigrams', () => {
    expect(tokenize('Entry 27,120, exit 26,980: +$1,140 on the skipped_scale_out')).toEqual(['entry', '27120', 'exit', '26980', '1140', 'skip', 'scale']);
    expect(features('held through earnings')).toEqual(['hold', 'through', 'earnings', 'hold through', 'through earnings']);
  });

  it('weights rare terms above common ones and normalizes to unit length', () => {
    const state = tfidfEmbedder.fit(['nq short cpi', 'nq long fomc', 'nq short nfp']);
    expect(state.n).toBe(3);
    expect(state.idf.cpi!).toBeGreaterThan(state.idf.short!);
    expect(state.idf.short!).toBeGreaterThan(state.idf.nq!);
    expect(state.idf.nq).toBeCloseTo(1, 5); // ln(4/4) + 1
    expect(state.idf.cpi).toBeCloseTo(Math.log(4 / 2) + 1, 4);
    const [v] = tfidfEmbedder.embed(['nq short cpi'], state);
    expect(Math.sqrt(Object.values(v!).reduce((a, x) => a + x * x, 0))).toBeCloseTo(1, 3);
    expect(tfidfEmbedder.embed(['words the corpus never saw'], state)).toEqual([{}]);
    expect(cosine(v!, v!)).toBeCloseTo(1, 3);
    expect(cosine(v!, {})).toBe(0);
  });

  it('ranks by cosine similarity and applies structured filters', () => {
    expect(search(index, 'catalyst plus timing best trades', { k: 1 })[0]?.doc.ref).toBe('n1');
    expect(search(index, 'held would have doubled', { k: 1 })[0]?.doc.kind).toBe('chat');
    const top = search(index, 'NQ-PERP short CPI entry 27,120', { k: 3 });
    expect(top[0]?.doc.ref).toBe(tickets[0]!.id);
    expect(top[0]!.score).toBeGreaterThan(top[1]!.score);
    expect(search(index, 'earnings', { k: 10, filters: { kind: 'trade' } }).every((h) => h.doc.kind === 'trade')).toBe(true);
    expect(search(index, 'earnings', { k: 10, filters: { kind: ['trade', 'event'], tags: ['held_through_earnings', 'stopped_out'] } }).map((h) => h.doc.instrument).sort()).toEqual(['AMZN', 'NVDA']);
    expect(search(index, 'short', { k: 10, filters: { instrument: 'NQ', kind: 'trade' } }).map((h) => h.doc.instrument)).toEqual(['NQ-PERP']); // same underlying
    expect(search(index, '', { k: 10, filters: { kind: 'trade', from: '2026-11-01T00:00:00Z', to: '2026-11-18T00:00:00Z' } }).map((h) => h.doc.instrument)).toEqual(['NQ-PERP', 'AMD']);
    expect(search(index, 'zzzz qqqq')).toEqual([]);
  });

  it('survives a JSON round trip unchanged', () => {
    const revived = JSON.parse(JSON.stringify(index)) as typeof index;
    expect(revived).toEqual(index);
    expect(search(revived, 'held through earnings stopped out', { k: 5 })).toEqual(search(index, 'held through earnings stopped out', { k: 5 }));
  });

  it('accepts another embedder through the Embedder interface', async () => {
    /** Synthetic stand-in for a dense model: a 2-dim vector, [mentions earnings, mentions cpi]. */
    const toy: Embedder<Record<string, never>> = { id: 'toy-dense', fit: async () => ({}), embed: async (texts) => texts.map((t): SparseVector => ({ 0: /earnings/i.test(t) ? 1 : 0, 1: /cpi/i.test(t) ? 1 : 0 })) };
    const idx = await buildIndexWith(docs, toy);
    expect(idx.embedder).toBe('toy-dense');
    expect(searchVector(idx, { 1: 1 }, { k: 1, filters: { kind: 'trade' } })[0]?.doc.instrument).toBe('NQ-PERP');
    expect(() => search(idx, 'cpi')).toThrow(/searchVector/);
  });
});

describe('answerFromMemory', () => {
  it('parses count, kind, tags and instrument with simple rules', () => {
    expect(parseMemoryQuestion('what happened the last three times I held through earnings')).toMatchObject({ count: 3, countStated: true, kind: 'trade', tags: ['held_through_earnings'], instrument: null, structured: true });
    expect(parseMemoryQuestion('last 2 NQ trades')).toMatchObject({ count: 2, kind: 'trade', instrument: 'NQ', tags: [] });
    expect(parseMemoryQuestion('when did I last get stopped out on NVDA?')).toMatchObject({ tags: ['stopped_out'], instrument: 'NVDA' });
    expect(parseMemoryQuestion('show me the times I skipped a scale-out on shorts')).toMatchObject({ tags: ['skipped_scale_out', 'short'] });
    expect(parseMemoryQuestion('what did I say about timing').structured).toBe(false);
  });

  it('Ask answers a question about a past trade with its numbers', () => {
    const a = answerFromMemory(index, 'what happened the last three times I held through earnings');
    // Exactly the three carried through a print, newest first; the INTC long closed before its print and the NQ CPI short are out.
    expect(a.matches.map((m) => m.doc.instrument)).toEqual(['NVDA', 'AMD', 'AMZN']);
    expect(a.matches.map((m) => m.doc.ref)).toEqual([tickets[1]!.id, tickets[2]!.id, tickets[3]!.id]);
    expect(a.totalMatching).toBe(3);
    expect(a.summary).toEqual({ trades: 3, pnlUsd: -1400, avgAdherence: 80, winners: 1 });
    const lines = a.text.split('\n');
    expect(lines[0]).toBe('3 trades, newest first: net −$1,400, 1 of 3 paid, average adherence 80.');
    expect(lines[1]).toContain('1. 2026-11-18 NVDA long vest-instant, catalyst NVDA earnings, entry 180, exit 171, −$1,000, adherence 80');
    expect(lines[2]).toContain('2. 2026-11-03 AMD long vest-instant, catalyst AMD earnings, entry 250, exit 262.5, +$500, adherence 80');
    expect(lines[3]).toContain('3. 2026-10-29 AMZN long vest-instant, catalyst AMZN earnings, entry 200, exit 188, −$900, adherence 80');
    expect(a.asOf).toBe('2026-11-18T19:00:00.000Z');

    const one = answerFromMemory(index, 'what happened the last time I held through earnings?');
    expect(one.matches.map((m) => m.doc.instrument)).toEqual(['NVDA']);
    expect(one.text.split('\n')[0]).toBe('1 of 3 trades, newest first: net −$1,000, 0 of 1 paid, average adherence 80.');

    const nq = answerFromMemory(index, 'what was my last NQ trade?');
    expect(nq.matches).toHaveLength(1);
    expect(nq.text).toContain('entry 27,120, exit 26,980, +$258');
  });

  it('says so when the sample is short or empty', () => {
    const five = answerFromMemory(index, 'last five times I held through earnings');
    expect(five.matches).toHaveLength(3);
    expect(five.text.startsWith('Only 3 on record, not 5. 3 trades, newest first')).toBe(true);
    const none = answerFromMemory(index, 'the last three times I added to a loser');
    expect(none).toMatchObject({ matches: [], totalMatching: 0, asOf: null, summary: { trades: 0, pnlUsd: null, avgAdherence: null, winners: null } });
    expect(none.text).toBe('Nothing on record matches. No sample, no answer.');
    const free = answerFromMemory(index, 'what did I write about catalyst plus timing');
    expect(free.intent.structured).toBe(false);
    expect(free.matches[0]?.doc.ref).toBe('n1');
    expect(answerFromMemory(buildIndex([]), 'last three trades').text).toBe('Nothing on record matches. No sample, no answer.');
  });

  it('is deterministic', () => {
    expect(iso(NOW)).toBe('2026-11-17T14:25:00.000Z');
    expect(answerFromMemory(index, 'last three times I held through earnings')).toEqual(answerFromMemory(buildIndex(toMemoryDocs({ tickets, calls: [call], firings: [firing], notes: [note], chat: [chat], catalysts })), 'last three times I held through earnings'));
  });
});
