/**
 * The research assistant. Works with no LLM (`answerByRules`) and with one (`askSystemPrompt`,
 * `askUserPrompt`, then `validateAskAnswer`; on failure the caller falls back to the rules answer).
 * Every answer is built from, or checked against, one cited fact sheet. Pure.
 */
import {
  INSTRUMENTS, dayKey, freshness, hashId, iso,
  type BiasCall, type ChatMessage, type Profile,
} from '@desk/contracts';
import { callKey, callLine, catalystLine, ensureDot, etStamp, quoteText, signed, sortCalls, usd, yieldText } from './common';
import { accountLine, headlineLine, positionText, topReads } from './morning';
import { extractNumbers, numberOnSheet, numbersNotOnSheet } from './numbers';
import type { AskCtx } from './types';

export type AskIntent = 'up_or_down' | 'instrument' | 'past_trades' | 'position' | 'catalyst' | 'account' | 'other';
export interface AskRoute { intent: AskIntent; instruments: string[] }
export type AskGroup = 'call' | 'rates' | 'quote' | 'catalyst' | 'structure' | 'position' | 'account' | 'headline' | 'ledger' | 'memory';
export interface AskFact { group: AskGroup; label: string; text: string; source: string; asOf: string; stale: boolean; instruments: string[] }
export interface AskContext {
  now: number; asOf: string;
  facts: AskFact[];
  /** The call for the profile's primary instrument, intraday first. */
  primary: BiasCall | null;
  /** The rendered fact sheet for the prompt. */
  text: string;
  banned: string[];
}

/* ───────────────────────── Routing ───────────────────────── */

const ALIASES: Record<string, string> = {
  nasdaq: 'NQ', nq: 'NQ', gold: 'GC', oil: 'CL', crude: 'CL', bitcoin: 'BTC', ether: 'ETH', ethereum: 'ETH', nvidia: 'NVDA', amazon: 'AMZN',
  intel: 'INTC', sandisk: 'SNDK', micron: 'MU', broadcom: 'AVGO', coreweave: 'CRWV', nebius: 'NBIS', tsmc: 'TSM', dollar: 'DXY',
};
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Symbols named in the text. Two-letter tickers must be upper case ("es" and "mu" are also words). */
export function mentionedInstruments(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (const sym of Object.keys(INSTRUMENTS).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\w-])\\$?${esc(sym)}(?![\\w-])`, sym.length >= 3 ? 'gi' : 'g');
    if (re.test(rest)) { found.push(sym); rest = rest.replace(re, ' '); }
  }
  for (const [alias, sym] of Object.entries(ALIASES)) {
    if (new RegExp(`\\b${esc(alias)}\\b`, 'i').test(rest) && !found.includes(sym)) found.push(sym);
  }
  return found;
}

const INTENT_RULES: Array<[AskIntent, RegExp]> = [
  ['up_or_down', /\bup or down\b|\bdown or up\b|\blong or short\b|\bshort or long\b|\bbuy or sell\b|\bbias\b|\bwhich way\b|\bwhat'?s the call\b|\bdirection today\b/i],
  ['past_trades', /\blast (?:\w+ )?times?\b|\bhistory\b|\bhistorically\b|\bpast trades?\b|\bprevious(?:ly)?\b|\bhave i ever\b|\bwhat happened (?:the last|when i|last)\b|\bmy (?:best|worst) trades?\b|\bhow (?:did|have) (?:i|my)\b|\bjournal\b|\bremember\b/i],
  ['position', /\bpositions?\b|\bmy (?:long|short)\b|\bfail price\b|\bliquidat\w*|\bkeep holding\b|\bhold(?:ing)? (?:it|this|through)\b|\bscale[- ]out\b|\bdistance to fail\b|\bam i safe\b/i],
  ['account', /\baccounts?\b|\bpayouts?\b|\bconsistency\b|\bdrawdown\b|\bclaim(?:able)?\b|\bbalance\b|\binactivity\b|\bvest\b|\bapex\b|\bmffu\b|\blucid\b|\btradeify\b/i],
  ['catalyst', /\bcatalysts?\b|\bcalendar\b|\bCPI\b|\bNFP\b|\bFOMC\b|\bPPI\b|\bPCE\b|\bpayrolls\b|\bearnings\b|\bconsensus\b|\bwhisper\b|\bimplied move\b|\bwhat'?s (?:on )?(?:today|tomorrow|this week)\b|\bnext (?:print|release|event)\b/i],
];

/** Rule-based intent. First matching rule wins; a bare symbol mention is `instrument`. */
export function routeQuestion(text: string): AskRoute {
  const instruments = mentionedInstruments(text);
  const hit = INTENT_RULES.find(([, re]) => re.test(text));
  return { intent: hit ? hit[0] : instruments.length ? 'instrument' : 'other', instruments };
}

/** "check live", "right now", "latest": the API re-polls the feeds before answering. */
export function needsLiveCheck(text: string): boolean {
  return /\bcheck(?:ing)? (?:it )?live\b|\blive check\b|\bright now\b|\blatest\b|\brefresh\b/i.test(text);
}

/* ───────────────────────── Fact sheet ───────────────────────── */

const GROUP_TITLES: Array<[AskGroup, string]> = [
  ['call', 'CURRENT CALLS'], ['rates', 'RATES'], ['quote', 'QUOTES'], ['catalyst', 'NEXT CATALYSTS'], ['structure', 'CONFIRMED SETUPS'],
  ['position', 'OPEN POSITIONS'], ['account', 'ACCOUNTS'], ['headline', 'HEADLINES'], ['ledger', 'OVERRIDE LEDGER'], ['memory', 'MEMORY HITS'],
];
const MAX_CATALYSTS = 6;
const MAX_HEADLINES = 5;

/** The fact with its as-of stamp, as it appears in an answer. */
export function stamped(f: AskFact, now: number): string {
  return `${f.text} (as of ${etStamp(f.asOf, now)}${f.stale ? ', stale' : ''})`;
}

const tracks = (inst: string): string => INSTRUMENTS[inst]?.priceSymbol ?? inst;
const sameUnderlying = (a: string, b: string): boolean => a === b || tracks(a) === tracks(b);

export function buildAskContext(ctx: AskCtx): AskContext {
  const { now } = ctx;
  const facts: AskFact[] = [];
  const add = (group: AskGroup, label: string, text: string, source: string, asOf: string, stale = false, instruments: string[] = []): void => {
    facts.push({ group, label, text, source, asOf, stale, instruments });
  };
  const calls = sortCalls(ctx.calls, ctx.profile.instruments.primary);
  for (const c of calls) add('call', callKey(c), callLine(c, now), 'bias engine', c.createdAt, c.factors.some((f) => f.stale), [c.instrument]);

  const r = ctx.rates;
  if (r) {
    for (const [name, st, chg] of [['10Y', r.y10, r.y10Chg1dBp], ['2Y', r.y2, r.y2Chg1dBp], ['30Y', r.y30, null]] as const) {
      if (st.value !== null && st.asOf !== null) add('rates', name, yieldText(name, st, chg, now), st.source ?? 'rates feed', st.asOf, st.stale);
    }
    if (r.spread2s10sBp !== null && r.y10.asOf) add('rates', '2s10s', `2s10s ${signed(r.spread2s10sBp, 0)} bp`, r.y10.source ?? 'rates feed', r.y10.asOf, r.y10.stale || r.y2.stale);
    const fed = [['hike', r.fed.hike], ['cut', r.fed.cut], ['hold', r.fed.hold]] as const;
    const have = fed.filter(([, st]) => st.value !== null && st.asOf !== null);
    // Odds are shown exactly as the feed stores them; this module does not assume a unit.
    if (have.length) add('rates', 'Fed pricing', `Fed pricing${r.fed.meeting ? ` for ${r.fed.meeting}` : ''}: ${have.map(([k, st]) => `${k} ${st.value}`).join(', ')}`, have[0]![1].source ?? 'fed pricing feed', have[0]![1].asOf!, have.some(([, st]) => st.stale));
  }
  for (const q of Object.values(ctx.quotes)) add('quote', q.symbol, quoteText(q.symbol, q, now), q.source, q.asOf, freshness(q, now) === 'stale', [q.symbol]);

  const upcoming = ctx.catalysts.filter((c) => c.status !== 'resolved').sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)).slice(0, MAX_CATALYSTS);
  for (const c of upcoming) {
    const engine = c.matrix ? ` Engine: ${ensureDot(c.matrix.whatIWouldDo)}` : '';
    add('catalyst', `catalyst ${c.name}`, `${catalystLine(c, now)}${engine}`, c.source, c.asOf, false, [...c.instruments, ...(c.symbol ? [c.symbol] : [])]);
  }
  for (const e of (ctx.structure ?? []).filter((x) => x.confirmedSetup)) add('structure', `setup ${e.instrument} ${e.tf}`, `${e.instrument} ${e.tf}: ${ensureDot(e.text)}`, 'chart watcher', e.ts, false, [e.instrument]);
  for (const p of ctx.positions) {
    add('position', `position ${p.position.instrument} ${p.position.accountId}`, positionText(p, now), 'position monitor', p.status?.asOf ?? p.position.openedAt, false, [p.position.instrument]);
  }
  for (const a of ctx.accounts.filter((x) => x.state.active)) add('account', `account ${a.rules.id}`, accountLine(a, now), 'account state', a.state.asOf);
  for (const h of topReads(ctx.headlines, MAX_HEADLINES)) add('headline', `headline ${h.id}`, headlineLine(h, now), h.source, h.ts, false, h.symbols);
  const l = ctx.ledger;
  if (l) {
    const capture = l.planCapturePct !== null && l.overrideCapturePct !== null ? `; plan capture ${Math.round(l.planCapturePct)}% vs override capture ${Math.round(l.overrideCapturePct)}%` : '';
    add('ledger', 'override ledger', `Overrides: ${usd(l.monthToDateUsd)} month to date over ${l.instances} instances${capture}.`, 'journal', ctx.journalAsOf ?? iso(now));
  }
  for (const m of ctx.memoryHits) add('memory', `memory ${m.id}`, `${dayKey(m.ts)} ${m.kind}: ${ensureDot(m.text)}`, m.source ?? 'journal', m.ts);

  const blocks = GROUP_TITLES.map(([g, title]) => {
    const rows = facts.filter((f) => f.group === g);
    return `${title}\n${rows.length ? rows.map((f) => `- ${f.text} [${f.source}, as of ${etStamp(f.asOf, now)}${f.stale ? ', STALE' : ''}]`).join('\n') : '- no data'}`;
  });
  const primaryInst = ctx.profile.instruments.primary;
  const primary = calls.find((c) => primaryInst.includes(c.instrument)) ?? calls[0] ?? null;
  return { now, asOf: iso(now), facts, primary, text: `FACT SHEET, built ${etStamp(now, now)}\n\n${blocks.join('\n\n')}`, banned: ctx.profile.voice.banned };
}

/* ───────────────────────── Rules answers ───────────────────────── */

const CATALYST_WORDS: Array<[RegExp, RegExp]> = [
  [/\bCPI\b/i, /CPI/i], [/\bNFP\b|\bpayrolls\b/i, /NFP|payroll/i], [/\bFOMC\b/i, /FOMC|Fed/i], [/\bPPI\b/i, /PPI/i], [/\bPCE\b/i, /PCE/i], [/\bearnings\b/i, /earnings/i],
];

/**
 * Deterministic answer for every intent. It reports what the engines already decided; it never forms a view.
 * Each line is a fact from the sheet with its as-of stamp; answers that touch an instrument end with its current call.
 */
export function answerByRules(text: string, ctx: AskCtx): ChatMessage {
  const { now } = ctx;
  const sheet = buildAskContext(ctx);
  const route = routeQuestion(text);
  const used: AskFact[] = [];
  const out: string[] = [];
  const say = (f: AskFact, prefix = ''): void => { if (!used.includes(f)) { used.push(f); out.push(`${prefix}${stamped(f, now)}`); } };
  const group = (g: AskGroup): AskFact[] => sheet.facts.filter((f) => f.group === g);
  const about = (f: AskFact, inst: string): boolean => f.instruments.some((i) => sameUnderlying(i, inst));
  const callFor = (inst: string): AskFact | undefined => group('call').find((f) => f.instruments.includes(inst)) ?? group('call').find((f) => about(f, inst));
  const primaryFact = sheet.primary ? group('call').find((f) => f.label === callKey(sheet.primary!)) : undefined;
  const nowStamp = `(as of ${etStamp(now, now)})`;
  const endWith = new Set<string>(route.instruments);

  switch (route.intent) {
    case 'up_or_down': {
      const inst = route.instruments[0];
      const f = inst ? callFor(inst) : primaryFact;
      if (f) say(f);
      else out.push(`No call on file${inst ? ` for ${inst}` : ''}. The bias engine has produced nothing to quote ${nowStamp}.`);
      endWith.clear();
      if (inst && !f) endWith.add(inst);
      break;
    }
    case 'past_trades': {
      const hits = group('memory');
      if (hits.length === 0) out.push(`Nothing in the journal matches that. No trades to cite ${nowStamp}.`);
      hits.forEach((f) => say(f));
      break;
    }
    case 'position': {
      const all = group('position');
      const mine = route.instruments.length ? all.filter((f) => route.instruments.some((i) => about(f, i))) : all;
      if (mine.length === 0) out.push(`No open position${route.instruments.length ? ` in ${route.instruments.join(', ')}` : 's'} ${nowStamp}.`);
      mine.forEach((f) => { say(f); f.instruments.forEach((i) => endWith.add(i)); });
      break;
    }
    case 'account': {
      const all = group('account');
      const named = all.filter((f) => text.toLowerCase().includes(f.label.replace('account ', '').toLowerCase()));
      const firm = all.filter((f) => f.label.replace('account ', '').split('-').some((part) => part.length > 2 && new RegExp(`\\b${esc(part)}\\b`, 'i').test(text)));
      const pick = named.length ? named : firm.length ? firm : all;
      if (pick.length === 0) out.push(`No account data on file ${nowStamp}.`);
      pick.forEach((f) => say(f));
      group('ledger').forEach((f) => say(f));
      break;
    }
    case 'catalyst': {
      const all = group('catalyst');
      const word = CATALYST_WORDS.find(([q]) => q.test(text));
      let pick = all;
      if (route.instruments.length) pick = pick.filter((f) => route.instruments.some((i) => about(f, i)));
      if (word) pick = pick.filter((f) => word[1].test(f.text));
      if (pick.length === 0) out.push(`No matching catalyst on the calendar I hold ${nowStamp}.${all.length ? ' Next on it:' : ''}`);
      // A catalyst line carries a branch trade, so the answer closes with the call on the instruments it moves.
      (pick.length ? pick : all).slice(0, 3).forEach((f) => { say(f); f.instruments.forEach((i) => endWith.add(tracks(i))); });
      break;
    }
    case 'instrument': {
      for (const inst of route.instruments) {
        const q = group('quote').find((f) => f.instruments.includes(inst)) ?? group('quote').find((f) => about(f, inst));
        if (q) say(q);
        else out.push(`${inst}: no quote on file ${nowStamp}.`);
        const cats = group('catalyst').filter((f) => about(f, inst));
        const setups = group('structure').filter((f) => about(f, inst));
        if (cats.length === 0 && setups.length === 0) {
          const next = group('catalyst')[0];
          out.push(`No edge on ${inst}. No catalyst on the calendar for it and no confirmed setup ${nowStamp}.`);
          if (next) say(next, `What would create one: a confirmed sweep-and-reclaim with an MSS on ${inst}, or the next market catalyst. `);
          else out.push(`What would create one: a confirmed sweep-and-reclaim with an MSS on ${inst}, or a catalyst landing on the calendar. None is scheduled in the data I hold.`);
        } else {
          cats.slice(0, 2).forEach((f) => say(f));
          setups.forEach((f) => say(f, 'Setup: '));
        }
        group('position').filter((f) => about(f, inst)).forEach((f) => say(f, 'Open: '));
      }
      break;
    }
    case 'other': {
      out.push('No rule covers that question and no LLM is answering. What the desk holds:');
      if (primaryFact) say(primaryFact);
      const ten = group('rates')[0];
      if (ten) say(ten);
      const next = group('catalyst')[0];
      if (next) say(next, 'Next: ');
      if (!primaryFact && !ten && !next) out.push(`No data ${nowStamp}.`);
      break;
    }
  }

  // Answers about an instrument always end with the current call.
  for (const inst of endWith) {
    const f = callFor(inst);
    if (f) { used.push(f); out.push(`Current call: ${stamped(f, now)}`); continue; }
    out.push(`Current call: none on file for ${inst}; that reads as No edge ${nowStamp}.`);
    if (primaryFact) { used.push(primaryFact); out.push(`Desk call: ${stamped(primaryFact, now)}`); }
  }

  const cited = [...new Set(used)];
  const oldest = cited.map((f) => f.asOf).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    id: hashId('chat', now, 'rules', text), ts: iso(now), role: 'desk', text: out.join('\n'), asOf: oldest ?? iso(now),
    citations: cited.map((f) => ({ label: f.label, source: f.source, asOf: f.asOf })),
  };
}

/* ───────────────────────── LLM path ───────────────────────── */

export function askSystemPrompt(profile: Profile): string {
  return [
    `You are the research desk for one trader, ${profile.trader}. Style: ${profile.style.summary}`,
    'Voice:',
    ...profile.voice.rules.map((r) => `- ${r}`),
    `Never use these phrases: ${profile.voice.banned.map((b) => `"${b}"`).join(', ')}.`,
    'Rules, all of them hard:',
    '- Answer only from the FACT SHEET in the user message. If the sheet does not hold it, say "no data". Never invent or estimate a number.',
    '- Every number you write must appear on the sheet, in the sheet\'s own format, followed by its feed and as-of time, e.g. "10Y 4.94% (rates feed, as of 14:32 ET)".',
    '- A fact marked STALE is repeated as stale with its age. Never present it as current.',
    '- Do not give a direction (long, short, buy, sell, bullish, bearish, up, down) unless the same answer states a probability between 0.50 and 0.85 and the kill condition. The only source for both is a call under CURRENT CALLS. Never state a probability above 0.85.',
    '- Asked "up or down today?", repeat the current call, its probability and its expiry. No new analysis.',
    '- An instrument with no catalyst and no confirmed setup is "No edge", plus the one fact that would create an edge.',
    '- When the answer is about an instrument, the last line is its current call, copied from the sheet with its as-of time.',
    '- One sentence of pattern, one of evidence, one of action. No lecture, no third paragraph.',
  ].join('\n');
}

export function askUserPrompt(question: string, askContext: AskContext): string {
  return `${askContext.text}\n\nQUESTION\n${question.trim()}`;
}

const DIRECTION_WORD = /\b(long|short|buy|sell|bullish|bearish)\b(?![- ](?:term|dated|weekend|run|answer|way|time|while|squeeze|covering|interest|side|of)\b)/i;
const UP_DOWN = /\b(?:going|goes|go|heads?|heading|headed|closes?|finish(?:es)?|ends?|leans?|leaning|bias(?:ed)?(?: is)?|call(?: is)?|answer(?: is)?|it(?:'s| is)|today(?: is)?|we(?:'re| are)|be)[: ]+(?:\w+ )?(up|down|higher|lower)\b(?! ?(?:[-+−$\d]|from\b|to\b|by\b))|^\s*(?:up|down)\b/i;
const PROBABILITY = /(?<![\d.])0\.(?:5\d|6\d|7\d|8[0-5])(?!\d)|(?<![\d.])(?:5\d|6\d|7\d|8[0-5])(?:\.\d+)?\s?%/;
const OVER_CAP = /\b(?:probability|confidence|conviction)\D{0,16}(?:0\.(?:8[6-9]|9\d)|1\.0+\b|(?:8[6-9]|9\d|100)(?:\.\d+)?\s?%)/i;
const KILL = /\b(?:kills?|killed|flips?|invalidat\w*|wrong (?:if|below|above|on))\b/i;
const AS_OF = /\bas of\b[^\n]{0,24}\d{1,2}:\d{2}|\(\d+\s?[smhd] old/i;

/** Post-checks on an LLM answer. Any problem means the caller discards it and uses `answerByRules`. */
export function validateAskAnswer(text: string, askContext: AskContext): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!AS_OF.test(text)) problems.push('no as-of stamp');
  const dir = DIRECTION_WORD.exec(text) ?? UP_DOWN.exec(text);
  if (dir) {
    if (!PROBABILITY.test(text)) problems.push(`direction ("${dir[0].trim()}") without a probability in 0.50-0.85`);
    if (!KILL.test(text)) problems.push(`direction ("${dir[0].trim()}") without a kill condition`);
  }
  if (OVER_CAP.test(text)) problems.push('probability above 0.85');
  for (const b of askContext.banned) if (new RegExp(`\\b${esc(b)}\\b`, 'i').test(text)) problems.push(`banned phrase: "${b}"`);
  const loose = numbersNotOnSheet(text, askContext.text);
  if (loose.length) problems.push(`numbers not on the fact sheet: ${loose.join(', ')}`);
  return { ok: problems.length === 0, problems };
}

/** Facts whose data the answer uses: its label is named, or one of its distinctive numbers appears. */
function factsUsed(text: string, askContext: AskContext): AskFact[] {
  const nums = extractNumbers(text);
  const lower = text.toLowerCase();
  return askContext.facts.filter((f) => lower.includes(f.label.toLowerCase())
    || extractNumbers(f.text).some((n) => (n.dp > 0 || n.value >= 100) && nums.some((a) => numberOnSheet(a, [n]))));
}

/** Wraps a validated LLM answer as a desk message with `asOf` (the oldest fact it used) and its citations. */
export function finalizeAnswer(text: string, askContext: AskContext, now: number): ChatMessage {
  const used = factsUsed(text, askContext);
  const oldest = used.map((f) => f.asOf).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    id: hashId('chat', now, 'llm', text), ts: iso(now), role: 'desk', text: text.trim(), asOf: oldest ?? askContext.asOf,
    citations: used.map((f) => ({ label: f.label, source: f.source, asOf: f.asOf })),
  };
}
