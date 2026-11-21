/**
 * Memory layer (spec section 12): a vector index over the journal and the chat, with no external service.
 * Documents are rendered with their actual numbers, embedded as TF-IDF sparse vectors (unigrams + bigrams),
 * searched by cosine similarity plus structured filters. The index is plain JSON so it can live in kv.
 * `Embedder` is the seam for a real embedding model later; TF-IDF is the default and a full implementation.
 */
import {
  BIAS_TEXT, INSTRUMENTS, dayKey, fmtSignedUsd, ms, round,
  type BiasCall, type Catalyst, type ChatMessage, type GuardrailFiring, type JournalNote, type Ticket,
} from '@desk/contracts';
import { scoreAdherence } from './adherence';
import { px, replayFills, sortedFills, underlying } from './position';

export type MemoryKind = 'trade' | 'call' | 'event' | 'note' | 'chat' | 'catalyst';
export interface MemoryDoc {
  id: string; kind: MemoryKind; ts: string;
  /** Rendered with the actual numbers; this is what gets embedded and what Ask quotes. */
  text: string;
  instrument: string | null;
  tags: string[];
  /** Source record id (ticket id, call id, ...). */
  ref: string;
  /** The numbers behind the text, for summaries. */
  data: Record<string, number | string | boolean | null>;
}
export interface MemorySources { tickets: Ticket[]; calls: BiasCall[]; firings: GuardrailFiring[]; notes: JournalNote[]; chat: ChatMessage[]; catalysts: Catalyst[] }

const catalystLabel = (c: Catalyst): string => (c.code === 'EARNINGS' ? `${c.symbol ?? c.name} earnings` : c.code === 'ADHOC' || c.code === 'OTHER' ? c.name : c.code);
const touches = (c: Catalyst, symbol: string): boolean => c.symbol === symbol || c.instruments.includes(symbol) || c.instruments.includes(underlying(symbol));
const num = (x: number | null, dp = 2): string => (x === null ? 'n/a' : String(round(x, dp)));

function tradeDoc(t: Ticket, catalysts: Catalyst[]): MemoryDoc | null {
  const pos = replayFills(t);
  if (pos.firstEntryTs === null || pos.avgEntry === null) return null;
  const closed = t.status === 'closed' && t.result !== null;
  const endMs = pos.openUnits > 0 ? null : pos.lastExitTs;
  const cat = t.reason.kind === 'catalyst' ? catalysts.find((c) => c.id === (t.reason as { catalystId: string }).catalystId) ?? null : null;
  const reasonText = t.reason.kind === 'catalyst' ? `catalyst ${cat ? catalystLabel(cat) : t.reason.catalystId}` : `structure setup ${t.reason.setupEventId}`;
  /* Held through = the catalyst was scheduled while the position was actually on, from the fills, not from the plan-time flag. */
  const through = endMs === null ? [] : catalysts.filter((c) => ms(c.scheduledAt) > pos.firstEntryTs! && ms(c.scheduledAt) < endMs && (c.code !== 'EARNINGS' ? c.tier === 1 : touches(c, t.instrument)));
  const heldEarnings = through.some((c) => c.code === 'EARNINGS');
  const overrideKinds = [...new Set(t.overrides.map((o) => o.kind))];
  const stopped = sortedFills(t).some((f) => f.kind === 'stop');
  const adherence = t.result?.adherence ?? scoreAdherence(t).score;
  const pnl = closed ? t.result!.pnlUsd : round(pos.realizedUsd, 2);
  const exit = closed ? t.result!.exitPrice : pos.lastExitPrice;
  const entry = round(pos.avgEntry, 2);
  const tags = [
    t.direction, t.accountId, t.status, ...(overrideKinds.length ? ['override', ...overrideKinds] : closed ? ['followed_plan'] : []),
    ...(stopped ? ['stopped_out'] : []), ...(heldEarnings ? ['held_through_earnings'] : []), ...(through.length ? ['held_through_catalyst'] : []),
    ...through.map((c) => `held_through:${c.code}`), ...(cat ? [`catalyst:${cat.code}`] : ['structure']),
    ...(closed ? [pnl > 0 ? 'winner' : pnl < 0 ? 'loser' : 'flat'] : []),
  ];
  const parts = [
    `${dayKey(pos.firstEntryTs)} ${t.instrument} ${t.direction} ${t.accountId}`, reasonText, `entry ${px(entry)}`,
    exit === null ? 'still open' : `exit ${px(round(exit, 2))}`, `${fmtSignedUsd(pnl)}${closed ? '' : ' realized so far'}`, `adherence ${adherence}`,
    `override: ${overrideKinds.length ? overrideKinds.join(', ') : 'none'}`,
    `held through earnings: ${heldEarnings ? `yes (${through.filter((c) => c.code === 'EARNINGS').map(catalystLabel).join(', ')})` : 'no'}`,
    ...(stopped ? ['stopped out'] : []),
    ...(t.result && t.result.mfeAfterExitPct !== null && t.result.maeAfterExitPct !== null ? [`after exit: MFE ${t.result.mfeAfterExitPct.toFixed(2)}%, MAE ${t.result.maeAfterExitPct.toFixed(2)}%`] : []),
    ...(t.result && t.result.capturePct !== null ? [`captured ${t.result.capturePct.toFixed(0)}% of the available move`] : []),
    ...t.overrides.filter((o) => o.reason).map((o) => `${o.kind} reason: ${o.reason}`),
    ...(t.notes ? [`notes: ${t.notes}`] : []),
  ];
  return {
    id: `trade:${t.id}`, kind: 'trade', ts: new Date(pos.firstEntryTs).toISOString(), text: parts.join(', '), instrument: t.instrument, tags, ref: t.id,
    data: { entry, exit, pnlUsd: pnl, adherence, direction: t.direction, accountId: t.accountId, heldThroughEarnings: heldEarnings, stoppedOut: stopped, overrides: t.overrides.length, mfeAfterExitPct: t.result?.mfeAfterExitPct ?? null, maeAfterExitPct: t.result?.maeAfterExitPct ?? null, capturePct: t.result?.capturePct ?? null },
  };
}

/** Renders every journal record and chat message as a searchable document carrying its numbers. Tickets that never filled are skipped. */
export function toMemoryDocs(src: Partial<MemorySources>): MemoryDoc[] {
  const catalysts = src.catalysts ?? [];
  const docs: MemoryDoc[] = [];
  for (const t of src.tickets ?? []) { const d = tradeDoc(t, catalysts); if (d) docs.push(d); }
  for (const c of src.calls ?? []) {
    const outcome = c.outcome ? `outcome ${c.outcome.movePct >= 0 ? '+' : '−'}${Math.abs(c.outcome.movePct).toFixed(2)}%, ${c.outcome.correct === null ? 'unscored' : c.outcome.correct ? 'correct' : 'wrong'}` : 'outcome pending';
    docs.push({
      id: `call:${c.id}`, kind: 'call', ts: c.createdAt, instrument: c.instrument, ref: c.id,
      tags: [c.call, c.horizon, ...(c.outcome ? [c.outcome.correct === null ? 'unscored' : c.outcome.correct ? 'correct' : 'wrong'] : ['pending'])],
      text: `${dayKey(c.createdAt)} ${c.instrument} ${c.horizon} call ${BIAS_TEXT[c.call]} ${c.probability.toFixed(2)} at ${px(round(c.referencePrice, 2))}, facts: ${c.facts.join('; ') || 'none'}, kill: ${c.killCondition.text}, ${outcome}`,
      data: { probability: c.probability, referencePrice: c.referencePrice, movePct: c.outcome?.movePct ?? null, correct: c.outcome?.correct ?? null },
    });
  }
  for (const f of src.firings ?? []) {
    const fu = f.followUp;
    docs.push({
      id: `event:${f.id}`, kind: 'event', ts: f.ts, instrument: null, ref: f.id,
      tags: [f.pattern, f.effect, ...(fu?.action ? [fu.action] : [])],
      text: `${dayKey(f.ts)} guardrail ${f.pattern}: ${f.text}${fu?.action ? ` Trader ${fu.action}${fu.outcomeUsd !== null ? `, outcome ${fmtSignedUsd(fu.outcomeUsd)}` : ''}.` : ''}`,
      data: { pattern: f.pattern, blocks: f.blocks, action: fu?.action ?? null, outcomeUsd: fu?.outcomeUsd ?? null },
    });
  }
  for (const n of src.notes ?? []) docs.push({ id: `note:${n.id}`, kind: 'note', ts: n.ts, instrument: null, ref: n.id, tags: [...n.tags, n.source], text: `${dayKey(n.ts)} note: ${n.text}`, data: { source: n.source } });
  for (const m of src.chat ?? []) docs.push({ id: `chat:${m.id}`, kind: 'chat', ts: m.ts, instrument: null, ref: m.id, tags: [m.role], text: `${dayKey(m.ts)} ${m.role}: ${m.text}`, data: { role: m.role } });
  for (const c of catalysts) {
    const r = c.resolution, rx = c.reaction;
    docs.push({
      id: `catalyst:${c.id}`, kind: 'catalyst', ts: c.scheduledAt, instrument: c.symbol ?? c.instruments[0] ?? null, ref: c.id,
      tags: [c.code, `tier${c.tier}`, c.status],
      text: `${dayKey(c.scheduledAt)} ${catalystLabel(c)} (${c.name}) tier ${c.tier}, consensus ${num(c.consensus)}, prior ${num(c.prior)}, ${r ? `actual ${num(r.actual)}` : c.status}${c.impliedMovePct !== null ? `, implied move ${num(c.impliedMovePct)}%` : ''}${rx ? `, reaction 5m ${num(rx.m5Pct)}%, 15m ${num(rx.m15Pct)}%: ${rx.text}` : ''}`,
      data: { consensus: c.consensus, prior: c.prior, actual: r?.actual ?? null, tier: c.tier },
    });
  }
  return docs;
}

/* ───────────────────────── Embedding ───────────────────────── */

/** Sparse vector: feature -> weight. A dense model's output fits as { "0": x0, "1": x1, ... }. */
export type SparseVector = Record<string, number>;
/**
 * The seam for a real embedding model. `fit` learns whatever corpus state the model needs (JSON-serializable; a hosted model
 * returns {}), `embed` maps texts to vectors. Either may be async; `buildIndexWith` awaits them.
 */
export interface Embedder<S = unknown> {
  id: string;
  fit(texts: string[]): S | Promise<S>;
  embed(texts: string[], state: S): SparseVector[] | Promise<SparseVector[]>;
}

const STOP = new Set('a an the of to in on at for and or but is are was were be been it its this that these those with as by from i me my we you your do did does have has had what when where which who how so if then than there here just about into over under up down out off not no'.split(' '));
const IRREGULAR: Record<string, string> = { held: 'hold', holding: 'hold', sold: 'sell', bought: 'buy', stopped: 'stop', skipped: 'skip', added: 'add', overrode: 'override', overrides: 'override', overridden: 'override', went: 'go', took: 'take', taken: 'take', lost: 'lose', won: 'win', losses: 'loss', shorted: 'short', earnings: 'earnings' };
function stem(w: string): string {
  const irregular = IRREGULAR[w];
  if (irregular) return irregular;
  if (/^\d/.test(w) || w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}
/** Lowercased, number-normalized ("27,120" -> "27120", "$1,140" -> "1140"), stop words dropped, lightly stemmed. Underscores split, so `skipped_scale_out` matches "skipped scale out". */
export function tokenize(text: string): string[] {
  const flat = text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/[−–—]/g, '-');
  const raw = flat.match(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?/g) ?? [];
  return raw.map((w) => w.replace(/'s$/, '')).filter((w) => !STOP.has(w)).map(stem);
}
/** Unigrams and adjacent bigrams. */
export function features(text: string): string[] {
  const toks = tokenize(text);
  const out = [...toks];
  for (let i = 0; i + 1 < toks.length; i++) out.push(`${toks[i]} ${toks[i + 1]}`);
  return out;
}

export interface TfidfState { n: number; idf: Record<string, number> }
function tfidfVector(text: string, state: TfidfState): SparseVector {
  const counts = new Map<string, number>();
  for (const f of features(text)) if (state.idf[f] !== undefined) counts.set(f, (counts.get(f) ?? 0) + 1);
  const v: SparseVector = {};
  let norm = 0;
  for (const [f, c] of counts) { const w = (1 + Math.log(c)) * state.idf[f]!; v[f] = w; norm += w * w; }
  norm = Math.sqrt(norm);
  if (norm > 0) for (const f of Object.keys(v)) v[f] = round(v[f]! / norm, 5);
  return v;
}
/** Sublinear tf, smoothed idf (ln((1+N)/(1+df)) + 1), L2-normalized. Query terms the corpus never saw carry no weight. */
export interface SyncEmbedder<S> extends Embedder<S> { fit(texts: string[]): S; embed(texts: string[], state: S): SparseVector[] }
export const tfidfEmbedder: SyncEmbedder<TfidfState> = {
  id: 'tfidf-1',
  fit(texts) {
    const df = new Map<string, number>();
    for (const t of texts) for (const f of new Set(features(t))) df.set(f, (df.get(f) ?? 0) + 1);
    const idf: Record<string, number> = {};
    for (const [f, d] of df) idf[f] = round(Math.log((1 + texts.length) / (1 + d)) + 1, 5);
    return { n: texts.length, idf };
  },
  embed(texts, state) { return texts.map((t) => tfidfVector(t, state)); },
};

export function cosine(a: SparseVector, b: SparseVector): number {
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  let dot = 0, na = 0, nb = 0;
  for (const k of Object.keys(small)) { const y = large[k]; if (y !== undefined) dot += small[k]! * y; }
  for (const k of Object.keys(a)) na += a[k]! * a[k]!;
  for (const k of Object.keys(b)) nb += b[k]! * b[k]!;
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/* ───────────────────────── Index and search ───────────────────────── */

/** Plain JSON: `JSON.parse(JSON.stringify(index))` searches identically. */
export interface MemoryIndex { version: 1; embedder: string; state: unknown; docs: Array<MemoryDoc & { vec: SparseVector }> }
export interface MemoryFilters {
  kind?: MemoryKind | MemoryKind[];
  /** Matches the instrument or anything on the same underlying (NQ finds NQ-PERP and MNQ). */
  instrument?: string;
  /** Inclusive lower / exclusive upper bound on the doc's ts, ISO or epoch ms. */
  from?: string | number; to?: string | number;
  /** Every tag must be on the doc. */
  tags?: string[];
}
export interface MemoryHit { doc: MemoryDoc; score: number }

export function buildIndex(docs: MemoryDoc[]): MemoryIndex {
  const state = tfidfEmbedder.fit(docs.map((d) => d.text));
  const vecs = tfidfEmbedder.embed(docs.map((d) => d.text), state);
  return { version: 1, embedder: tfidfEmbedder.id, state, docs: docs.map((d, i) => ({ ...d, vec: vecs[i]! })) };
}
/** Same index from any embedder (a hosted model, say). Search it with `searchVector` and a query vector from that embedder. */
export async function buildIndexWith<S>(docs: MemoryDoc[], embedder: Embedder<S>): Promise<MemoryIndex> {
  const texts = docs.map((d) => d.text);
  const state = await embedder.fit(texts);
  const vecs = await embedder.embed(texts, state);
  return { version: 1, embedder: embedder.id, state, docs: docs.map((d, i) => ({ ...d, vec: vecs[i] ?? {} })) };
}

export function matchesFilters(doc: MemoryDoc, f: MemoryFilters = {}): boolean {
  if (f.kind !== undefined && !(Array.isArray(f.kind) ? f.kind : [f.kind]).includes(doc.kind)) return false;
  if (f.instrument !== undefined && (doc.instrument === null || (doc.instrument !== f.instrument && underlying(doc.instrument) !== underlying(f.instrument)))) return false;
  if (f.from !== undefined && ms(doc.ts) < ms(f.from)) return false;
  if (f.to !== undefined && ms(doc.ts) >= ms(f.to)) return false;
  return (f.tags ?? []).every((t) => doc.tags.includes(t));
}
const strip = (d: MemoryDoc & { vec?: SparseVector }): MemoryDoc => ({ id: d.id, kind: d.kind, ts: d.ts, text: d.text, instrument: d.instrument, tags: d.tags, ref: d.ref, data: d.data });

/** Cosine search with a precomputed query vector. An empty vector returns the filtered docs newest first with score 0. */
export function searchVector(index: MemoryIndex, queryVec: SparseVector, opts: { k?: number; filters?: MemoryFilters; minScore?: number } = {}): MemoryHit[] {
  const k = opts.k ?? 5;
  const pool = index.docs.filter((d) => matchesFilters(d, opts.filters));
  const empty = Object.keys(queryVec).length === 0;
  const hits = pool.map((d) => ({ doc: strip(d), score: empty ? 0 : round(cosine(queryVec, d.vec), 4) }))
    .filter((h) => empty || h.score > (opts.minScore ?? 0));
  hits.sort((a, b) => b.score - a.score || ms(b.doc.ts) - ms(a.doc.ts));
  return hits.slice(0, k);
}
/** Free-text search on a TF-IDF index. For an index built with another embedder, embed the query yourself and call `searchVector`. */
export function search(index: MemoryIndex, query: string, opts: { k?: number; filters?: MemoryFilters; minScore?: number } = {}): MemoryHit[] {
  if (index.embedder !== tfidfEmbedder.id) throw new Error(`Index was built with ${index.embedder}; embed the query with it and call searchVector.`);
  const [vec] = tfidfEmbedder.embed([query], index.state as TfidfState);
  return searchVector(index, vec ?? {}, opts);
}

/* ───────────────────────── Ask ───────────────────────── */

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };
const MACRO_CODES = ['CPI', 'PPI', 'NFP', 'FOMC', 'PCE', 'GDP', 'JOLTS'];
const TAG_RULES: Array<[RegExp, string]> = [
  [/\b(held|hold|holding|carried|carry)\b.*\bthrough\b.*\b(earnings|print|prints)\b/, 'held_through_earnings'],
  [/\b(held|hold|holding)\b.*\b(through|past)\b.*\b(invalidation|stop loss|my stop)\b/, 'held_through_invalidation'],
  [/\b(held|hold|holding)\b.*\b(through|past)\b.*\btime stop\b/, 'held_through_time_stop'],
  [/\bstopped out\b|\bstop(-| )outs?\b|\bgot stopped\b/, 'stopped_out'],
  [/\bskip(ped|ping)?\b.*\bscale/, 'skipped_scale_out'],
  [/\badd(ed|ing)?\b.*\b(loser|losing)\b/, 'added_to_loser'],
  [/\bsiz(ed|ing) up\b|\bsize up\b|\boversized\b/, 'size_up'],
  [/\b(exited|sold|closed|covered|out)\b.*\bearly\b|\bearly exits?\b/, 'early_exit'],
  [/\bfollowed (the|my) plan\b|\bplan-following\b/, 'followed_plan'],
  [/\bwinners?\b|\bwinning trades?\b/, 'winner'],
  [/\blosers?\b|\blosing trades?\b/, 'loser'],
];
export interface MemoryIntent { count: number; countStated: boolean; kind: MemoryKind | null; tags: string[]; instrument: string | null; structured: boolean }

/** Rule-based read of a memory question: how many, which kind of record, which tags, which instrument. */
export function parseMemoryQuestion(question: string): MemoryIntent {
  const q = question.toLowerCase();
  const tags: string[] = [];
  for (const [re, tag] of TAG_RULES) if (re.test(q) && !tags.includes(tag)) tags.push(tag);
  const heldThrough = /\b(held|hold|holding|carried|carry)\b.*\bthrough\b/.test(q);
  for (const code of MACRO_CODES) {
    if (!new RegExp(`\\b${code.toLowerCase()}\\b`).test(q)) continue;
    tags.push(heldThrough ? `held_through:${code}` : `catalyst:${code}`);
  }
  if (!heldThrough && /\bearnings\b/.test(q)) tags.push('catalyst:EARNINGS');
  if (/\boverr(ode|ide|ides|idden|iding)\b/.test(q) && !tags.some((t) => ['skipped_scale_out', 'added_to_loser', 'size_up', 'early_exit', 'held_through_invalidation', 'held_through_time_stop'].includes(t))) tags.push('override');
  if (/\bshort(s|ed)?\b/.test(q) && !/\blong(s)?\b/.test(q)) tags.push('short');
  if (/\blong(s)?\b/.test(q) && !/\bshort(s|ed)?\b/.test(q) && !/\b(how|so|as) long\b/.test(q)) tags.push('long');

  let instrument: string | null = null;
  for (const w of question.match(/[A-Za-z][A-Za-z0-9-]+/g) ?? []) {
    const up = w.toUpperCase();
    if (INSTRUMENTS[up] && (w === up || up.length >= 4 || up === 'NQ' || up === 'MNQ')) { instrument = up; break; }
  }

  let count = 3, countStated = false;
  const m = q.match(/\b(?:last|past|previous|recent|latest)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\b/) ?? q.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:most recent|times|trades|calls)\b/);
  if (m?.[1]) { count = NUMBER_WORDS[m[1]] ?? Number(m[1]); countStated = true; } else if (/\b(last|previous|latest) (time|trade|call)\b/.test(q)) { count = 1; countStated = true; }
  count = Math.min(20, Math.max(1, count));

  const kind: MemoryKind | null = tags.some((t) => t !== 'short' && t !== 'long') || /\btrades?\b|\btraded\b|\bposition|\bexit(ed|s)?\b|\bentr(y|ies)\b|\bp&l\b|\bpnl\b/.test(q) ? 'trade'
    : /\bcalls?\b|\bbias\b/.test(q) ? 'call' : /\bguardrails?\b|\bflag(s|ged)?\b/.test(q) ? 'event' : /\bnotes?\b/.test(q) ? 'note' : /\bcatalysts?\b|\breleases?\b/.test(q) ? 'catalyst' : null;
  return { count, countStated, kind, tags, instrument, structured: tags.length > 0 || (kind !== null && (countStated || instrument !== null)) };
}

export interface MemoryAnswer {
  question: string; intent: MemoryIntent;
  matches: MemoryHit[];
  /** How many records matched the filters before the count was applied. */
  totalMatching: number;
  /** For trades: the sums behind the first line. Null fields when there is no sample. */
  summary: { trades: number; pnlUsd: number | null; avgAdherence: number | null; winners: number | null };
  /** Desk voice: the count and the totals first, then each record with its numbers. */
  text: string;
  /** Newest record the answer rests on. */
  asOf: string | null;
}

/**
 * Answers a question about the trader's own history from the index. A question with a recognisable shape ("the last three
 * times I held through earnings", "last 2 NQ trades", "times I got stopped out") is answered by filter and recency, so the
 * trades returned are exactly the ones that match; anything else falls back to similarity search.
 */
export function answerFromMemory(index: MemoryIndex, question: string, opts: { k?: number } = {}): MemoryAnswer {
  const intent = parseMemoryQuestion(question);
  let hits: MemoryHit[]; let total: number;
  if (intent.structured) {
    const filters: MemoryFilters = { ...(intent.kind ? { kind: intent.kind } : {}), ...(intent.instrument ? { instrument: intent.instrument } : {}), tags: intent.tags };
    const all = index.docs.filter((d) => matchesFilters(d, filters)).sort((a, b) => ms(b.ts) - ms(a.ts));
    total = all.length;
    const qv = index.embedder === tfidfEmbedder.id ? tfidfEmbedder.embed([question], index.state as TfidfState)[0] ?? {} : {};
    hits = all.slice(0, opts.k ?? intent.count).map((d) => ({ doc: strip(d), score: round(cosine(qv, d.vec), 4) }));
  } else {
    hits = search(index, question, { k: opts.k ?? 5, minScore: 0.05, filters: { ...(intent.kind ? { kind: intent.kind } : {}), ...(intent.instrument ? { instrument: intent.instrument } : {}) } });
    total = hits.length;
  }
  const trades = hits.filter((h) => h.doc.kind === 'trade');
  const nums = (key: string): number[] => trades.map((h) => h.doc.data[key]).filter((v): v is number => typeof v === 'number');
  const pnls = nums('pnlUsd'), adh = nums('adherence');
  const summary = {
    trades: trades.length,
    pnlUsd: pnls.length ? round(pnls.reduce((a, b) => a + b, 0), 2) : null,
    avgAdherence: adh.length ? round(adh.reduce((a, b) => a + b, 0) / adh.length, 0) : null,
    winners: pnls.length ? pnls.filter((p) => p > 0).length : null,
  };
  const asOf = hits.length ? hits.map((h) => h.doc.ts).sort().at(-1)! : null;
  let head: string;
  if (hits.length === 0) head = 'Nothing on record matches. No sample, no answer.';
  else if (trades.length === hits.length) {
    const short = intent.structured && intent.countStated && total < intent.count ? `Only ${total} on record, not ${intent.count}. ` : '';
    const of = intent.structured && total > hits.length ? ` of ${total}` : '';
    head = `${short}${hits.length}${of} ${hits.length === 1 && !of ? 'trade' : 'trades'}, newest first: net ${fmtSignedUsd(summary.pnlUsd ?? 0)}, ${summary.winners} of ${trades.length} paid, average adherence ${summary.avgAdherence}.`;
  } else head = `${hits.length} ${hits.length === 1 ? 'record' : 'records'} on file, closest first.`;
  const text = [head, ...hits.map((h, i) => `${i + 1}. ${h.doc.text}`)].join('\n');
  return { question, intent, matches: hits, totalMatching: total, summary, text, asOf };
}
