/**
 * Headline dedupe and classification (spec section 4): category, market impact 0-3, direction for NQ, symbols.
 * The rules path needs no key. With ANTHROPIC_API_KEY a small model classifies in batches and any
 * failure (network, refusal, schema mismatch) falls back to the rules for that batch.
 *
 * Impact 3 creates an ad-hoc catalyst, so it is reserved for confirmed events: a CEO/founder exit at a
 * mega-cap, an export-control action, a central-bank surprise, a geopolitical strike between states that
 * move oil or chips, a Tier-1 print far from consensus. Rumour wording caps a headline at 2.
 */
import { z } from 'zod';
import { DEFAULT_WATCHLIST, hashId, type Headline, type HeadlineCategory } from '@desk/contracts';
import { DEFAULT_CLASSIFY_MODEL, type LlmClient } from './llm';

export interface RawHeadline { title: string; ts: string; source: string; url?: string }
export interface ClassifyCtx { watchlist?: string[] }
type Dir = -1 | 0 | 1;

/* ───────────── dedupe ───────────── */

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'by', 'at', 'is', 'are', 'was', 'be', 'as', 'with', 'from', 'that', 'this', 'its', 'it', 'has', 'have', 'will', 'says', 'said', 'say']);
export const cleanTitle = (title: string): string => title.replace(/^\s*(financialjuice|fj|breaking|update|alert)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
export function titleTokens(title: string): string[] {
  return cleanTitle(title).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9.%$+-]+/g, ' ').split(' ').map((t) => t.replace(/^[.-]+|[.-]+$/g, '')).filter((t) => t && !STOP.has(t));
}
/** Normalized-title hash: case, punctuation, stop words and the wire prefix do not change it. */
export const dedupeKey = (title: string): string => hashId('hl', titleTokens(title).join(' '));

export function similarity(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Drop exact repeats and collapse near-duplicates (token Jaccard >= 0.75 inside 30 minutes; the earliest wins).
 * `seen` carries recent stored headlines so a repeat across polls is also dropped.
 */
export function dedupeHeadlines<T extends { title: string; ts: string }>(raws: T[], seen: Array<{ title: string; ts: string }> = []): T[] {
  const kept: Array<{ tokens: string[]; key: string; t: number }> = seen.map((s) => ({ tokens: titleTokens(s.title), key: dedupeKey(s.title), t: Date.parse(s.ts) }));
  const out: T[] = [];
  for (const r of [...raws].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const tokens = titleTokens(r.title), key = dedupeKey(r.title), t = Date.parse(r.ts);
    if (tokens.length === 0) continue;
    if (kept.some((k) => k.key === key || (Math.abs(k.t - t) <= 30 * 60_000 && similarity(k.tokens, tokens) >= 0.75))) continue;
    kept.push({ tokens, key, t });
    out.push(r);
  }
  return out;
}

/* ───────────── rules ───────────── */

const NAMES: Array<[RegExp, string]> = [
  [/\bnvidia\b/i, 'NVDA'], [/\bamazon\b|\baws\b/i, 'AMZN'], [/\bintel\b/i, 'INTC'], [/\bcoreweave\b/i, 'CRWV'], [/\bnebius\b/i, 'NBIS'],
  [/\bsandisk\b/i, 'SNDK'], [/\btake-two\b|\btake two interactive\b/i, 'TTWO'], [/\badvanced micro devices\b/i, 'AMD'], [/\bbroadcom\b/i, 'AVGO'],
  [/\bmicron\b/i, 'MU'], [/\btsmc\b|\btaiwan semiconductor\b/i, 'TSM'],
  [/\bnasdaq\b|\bnq futures\b|\bus tech stocks\b/i, 'NQ'], [/\bs&p ?500\b|\bs&p\b|\bspx\b/i, 'ES'], [/\bdow jones\b|\bdow\b(?! chemical)/i, 'YM'], [/\brussell 2000\b/i, 'RTY'],
  [/\bsemiconductor index\b|\bsox\b/i, 'SOX'], [/\bgold\b/i, 'GC'], [/\bwti\b|\bcrude\b|\bbrent\b|\boil prices?\b/i, 'CL'], [/\bbitcoin\b|\bbtc\b/i, 'BTC'], [/\bether(eum)?\b|\beth\b/i, 'ETH'],
];
/** Names above 5% index weight or equivalent: an executive exit here is an index event. */
const MEGA_CAP = /\b(nvidia|apple|microsoft|amazon|alphabet|google|meta|tesla|broadcom|tsmc|taiwan semiconductor|openai|anthropic)\b/i;
const CHIPS = ['NVDA', 'AMD', 'AVGO', 'MU', 'TSM', 'INTC'];

const RUMOUR = /\b(rumou?rs?|rumou?red|reportedly|unconfirmed|speculation|sources?\b|people familiar|said to|could|may|might|consider(s|ing)?|weigh(s|ing)?|mull(s|ing)?|in talks|plans? to discuss|possible|potential(ly)?|denies|denied|no immediate confirmation)\b/i;

const RE = {
  firm: /\b(my ?funded ?futures|mffu|apex trader funding|topstep|lucid trading|tradeify|vest markets|prop firm)\b/i,
  firmRule: /\b(rule|rules|payout|drawdown|consistency|policy|terms|leverage)\b/i,
  fed: /\b(fed|fomc|federal reserve|powell|fed chair|fed's|fed governor|fed vice chair)\b/i,
  otherCb: /\b(ecb|boj|boe|pboc|snb|bank of (japan|england|canada)|lagarde|ueda|bailey)\b/i,
  print: /\bactual\b.*\b(forecast|consensus|expected|est)\b/i,
  macro: /\b(cpi|ppi|pce|inflation|payrolls|nfp|non-?farm|jobless claims|unemployment rate|gdp|ism|pmi|retail sales|jolts|durable goods|consumer (confidence|sentiment)|treasury (auction|yields?)|\d+-year (note|bond) auction|yields?|tariffs?|debt ceiling|government shutdown)\b/i,
  earnings: /\b(earnings|eps|revenue|guidance|guides|outlook|q[1-4]\b|quarterly results|beats?|miss(es)?)\b/i,
  company: /\b(ceo|cfo|chief executive|founder|acquire[sd]?|acquisition|merger|buyback|layoffs?|recall|lawsuit|antitrust|upgrade[sd]?|downgrade[sd]?|price target|stake|ipo)\b/i,
  geo: /\b(iran|israel|gaza|hamas|hezbollah|houthis?|russia|ukraine|taiwan|north korea|china|nato|strait of hormuz|red sea|missile|drone|airstrikes?|strikes? on|military|troops|ceasefire|sanctions?|war|nuclear|invasion|blockade)\b/i,
  exec: /\b(ceo|chief executive|founder|co-founder)\b/i,
  exit: /\b(resigns?|resigned|resignation|steps? down|stepping down|stepped down|ousted|fired|removed as|to leave|departs?|departure|dies|died|passed away)\b/i,
  exportCtl: /\bexport (controls?|curbs?|restrictions?|bans?|licen[cs]es?|rules?)\b|\bentity list\b|\bchip (ban|curbs?|restrictions?)\b/i,
  exportAct: /\b(imposes?|imposed|announces?|announced|bans?|banned|restricts?|restricted|tightens?|tightened|expands?|expanded|revokes?|revoked|halts?|halted|blocks?|blocked|adds?|added|issues?|issued|finali[sz]es?|finali[sz]ed|to take effect|eases?|eased|lifts?|lifted)\b/i,
  cbSurprise: /\b(emergency|unscheduled|inter-?meeting|surprise|unexpected(ly)?|shock)\b.*\b(rate )?(cut|cuts|hike|hikes|meeting|move|decision)\b|\b(cut|cuts|hike|hikes|raises?|lowers?)\b.*\b(unexpected(ly)?|in (a )?surprise|emergency)\b/i,
  strike: /\b(declares? war|invades?|invaded|invasion of|launch(es|ed)? (air ?|missile |military )?(strikes?|attack) (on|against)|(air ?)?strikes? (hit|hits|on) (iran|israel|taiwan|saudi|qatar|uae|us (base|forces|troops)|u\.s\. (base|forces|troops))|attack(s|ed)? (us|u\.s\.) (base|forces|troops|warship)|(closes?|closed|shuts?|blockades?) (the )?strait of hormuz|blockade of taiwan|nuclear (test|detonation|strike))\b/i,
  deEsc: /\b(ceasefire|truce|peace (deal|agreement|talks)|de-?escalat\w+|lasting deal|agrees? to (talks|deal)|reopens?)\b/i,
  esc: /\b(strike|strikes|attack|attacks|attacked|missile|drone|explosion|ablaze|escalat\w+|retaliat\w+|sanctions?|blockade|mine|act of war)\b/i,
};

interface Print { name: string; actual: number; forecast: number; tier1: boolean; far: boolean; inflation: boolean }
const NUM = String.raw`(-?\d+(?:\.\d+)?)\s*(%|k|m|b)?`;
/** FinancialJuice print format: "US CPI MoM Actual 0.5% (Forecast 0.3%, Previous 0.2%)". */
export function parsePrint(title: string): Print | null {
  const m = new RegExp(String.raw`^(.*?)\bactual:?\s*${NUM}.*?\b(?:forecast|consensus|expected|est\.?):?\s*${NUM}`, 'i').exec(cleanTitle(title).replace(/,(?=\d{3})/g, ''));
  if (!m) return null;
  const name = m[1]!.trim(), actual = Number(m[2]), forecast = Number(m[4]);
  const scale = (u: string | undefined): number => (u?.toLowerCase() === 'm' ? 1000 : 1);
  const n = name.toLowerCase();
  const inflation = /\b(cpi|ppi|inflation)\b/.test(n);
  const jobs = /non-?farm|payrolls|nfp/.test(n), unemp = /unemployment rate/.test(n);
  const tier1 = /^(us|u\.s\.|united states)\b/.test(n) && (inflation || jobs || unemp);
  const gap = Math.abs(actual * scale(m[3]) - forecast * scale(m[5]));
  // "Far": 0.2 pt on a monthly inflation rate, 0.3 pt on an annual one, 75k on payrolls, 0.2 pt on unemployment.
  const far = tier1 && (jobs ? gap >= 75 : unemp ? gap >= 0.2 - 1e-9 : /yoy|y\/y|annual/.test(n) ? gap >= 0.3 - 1e-9 : gap >= 0.2 - 1e-9);
  return { name, actual, forecast, tier1, far, inflation };
}

export function tagSymbols(title: string, watchlist: string[] = DEFAULT_WATCHLIST): string[] {
  const out = new Set<string>();
  for (const s of watchlist) if (new RegExp(String.raw`(?:^|[^A-Za-z])\$?${s.replace(/[^A-Z0-9.-]/g, '')}(?![A-Za-z])`).test(title)) out.add(s);
  for (const [re, s] of NAMES) if (re.test(title)) out.add(s);
  return [...out];
}

/** Rules-based classification. Deterministic; needs no key. */
export function classifyHeadline(raw: RawHeadline, ctx: ClassifyCtx = {}): Headline {
  const title = cleanTitle(raw.title);
  const symbols = new Set(tagSymbols(title, ctx.watchlist));
  const rumour = RUMOUR.test(title);
  const print = parsePrint(title);
  const megaCap = MEGA_CAP.test(title);
  const stock = [...symbols].some((s) => (ctx.watchlist ?? DEFAULT_WATCHLIST).includes(s));

  let category: HeadlineCategory = 'other', impact = 0, direction: Dir = 0;
  if (RE.firm.test(title) && RE.firmRule.test(title)) {
    category = 'firm-rules'; impact = 1;
  } else if (RE.exportCtl.test(title)) {
    category = 'geopolitical'; CHIPS.forEach((s) => symbols.add(s)); symbols.add('NQ');
    const eases = /\b(eases?|eased|lifts?|lifted|relax(es|ed)?|exempt(s|ed|ion)?)\b/i.test(title);
    impact = RE.exportAct.test(title) ? 3 : 2; direction = eases ? 1 : -1;
  } else if (RE.exec.test(title) && RE.exit.test(title) && (megaCap || stock)) {
    category = 'company'; impact = megaCap ? 3 : 2; direction = -1;
    if (megaCap) symbols.add('NQ');
  } else if (print) {
    category = RE.fed.test(print.name) ? 'fed' : 'macro';
    impact = print.far ? 3 : print.tier1 ? 2 : 1;
    if (print.inflation && print.actual !== print.forecast) direction = print.actual > print.forecast ? -1 : 1;
    if (print.tier1) symbols.add('NQ');
  } else if (RE.fed.test(title) || RE.otherCb.test(title)) {
    const isFed = RE.fed.test(title);
    category = isFed ? 'fed' : 'macro';
    const surprise = RE.cbSurprise.test(title);
    impact = surprise ? 3 : isFed && /\b(powell|fed chair|fomc (statement|decision)|rate decision)\b/i.test(title) ? 2 : 1;
    if (/\b(cuts?|lowers?|dovish|easing|pause)\b/i.test(title)) direction = 1;
    else if (/\b(hikes?|raises?|hawkish|tightening|higher for longer)\b/i.test(title)) direction = -1;
    if (isFed && impact >= 2) symbols.add('NQ');
  } else if (RE.earnings.test(title) && (stock || megaCap)) {
    category = 'earnings'; impact = megaCap ? 2 : 1;
    if (/\b(beats?|tops?|raises? (guidance|outlook|forecast)|above (estimates|expectations))\b/i.test(title)) direction = 1;
    else if (/\b(miss(es)?|cuts? (guidance|outlook|forecast)|below (estimates|expectations)|warns?)\b/i.test(title)) direction = -1;
  } else if (RE.geo.test(title)) {
    category = 'geopolitical';
    const strike = RE.strike.test(title);
    impact = strike ? 3 : RE.esc.test(title) || RE.deEsc.test(title) ? 1 : 0;
    if (/\b(strait of hormuz|oil tanker|us (base|forces)|u\.s\. (base|forces)|f-16|taiwan)\b/i.test(title) && impact === 1) impact = 2;
    direction = RE.deEsc.test(title) && !strike ? 1 : RE.esc.test(title) || strike ? -1 : 0;
    if (impact >= 2) symbols.add('NQ');
  } else if (RE.macro.test(title)) {
    category = 'macro'; impact = /\btariffs?\b/i.test(title) && megaCap ? 2 : 1;
    if (/\btariffs?\b/i.test(title)) direction = /\b(pauses?|paused|delays?|removes?|lifts?|exempt\w*|cuts?)\b/i.test(title) ? 1 : /\b(imposes?|raises?|new|hikes?|threatens?)\b/i.test(title) ? -1 : 0;
  } else if (stock || megaCap || RE.company.test(title)) {
    category = 'company'; impact = (stock || megaCap) && RE.company.test(title) ? 1 : 0;
    if (/\bupgrade[sd]?\b/i.test(title)) direction = 1; else if (/\bdowngrade[sd]?\b/i.test(title)) direction = -1;
  }
  if (rumour) impact = Math.min(impact, 2);
  const key = dedupeKey(title);
  return { id: key, ts: raw.ts, source: raw.source, title, ...(raw.url ? { url: raw.url } : {}), category, impact, direction, symbols: [...symbols], classifier: 'rules', dedupeKey: key };
}

/* ───────────── LLM path ───────────── */

const LlmOut = z.object({ items: z.array(z.object({
  i: z.number().int(), category: z.enum(['macro', 'fed', 'earnings', 'company', 'geopolitical', 'firm-rules', 'other']),
  impact: z.number().int().min(0).max(3), direction: z.number().int().min(-1).max(1), symbols: z.array(z.string()),
})) });

const SYSTEM = `You classify market headlines for one Nasdaq-100 futures trader. Return one item per headline, keyed by its index i.

category: macro (data prints, Treasury, tariffs, non-Fed central banks), fed (Federal Reserve policy and speakers), earnings, company, geopolitical, firm-rules (prop-firm rule or payout changes), other.

impact, the expected effect on NQ over the next hour:
0 = noise. 1 = context, no trade. 2 = moves the index or a watchlist name, tradable.
3 = regime event that needs its own scenario plan. Only these qualify, and only when reported as fact: a CEO or founder exit at a mega-cap; an export-control action taken (not floated); a central-bank surprise (unscheduled move, or a decision against pricing); a military strike between states that reprices oil or chips; a Tier-1 US print (CPI, PPI, NFP) far from consensus.
A rumour, a "sources say", a "considering", a denial, or an unconfirmed report is never 3. When unsure between two levels, pick the lower.

direction for NQ: 1 risk-on, -1 risk-off, 0 unclear. Hotter inflation, hawkish Fed, escalation and export curbs are -1.

symbols: tickers from the watchlist that the headline is about, plus NQ, ES, CL, GC, BTC when the headline is about that market. Empty when none.`;

/** Classify with the model in batches of 25; any batch that fails or fails validation is classified by rules. */
export async function classifyHeadlines(raws: RawHeadline[], llm: LlmClient, ctx: ClassifyCtx = {}, model = DEFAULT_CLASSIFY_MODEL): Promise<Headline[]> {
  const rules = raws.map((r) => classifyHeadline(r, ctx));
  if (!llm.available) return rules;
  const allowed = new Set([...(ctx.watchlist ?? DEFAULT_WATCHLIST), 'NQ', 'ES', 'YM', 'RTY', 'SOX', 'CL', 'GC', 'BTC', 'ETH']);
  const out = [...rules];
  for (let start = 0; start < rules.length; start += 25) {
    const batch = rules.slice(start, start + 25);
    try {
      const text = await llm.complete({
        model, maxTokens: 8000, effort: 'low', schema: LlmOut, system: SYSTEM,
        messages: [{ role: 'user', content: `Watchlist: ${[...allowed].join(', ')}\n\nHeadlines:\n${batch.map((h, i) => `${i}. ${h.title}`).join('\n')}` }],
      });
      const parsed = LlmOut.parse(JSON.parse(text));
      if (parsed.items.length !== batch.length) throw new Error('LLM returned a different number of items');
      for (const it of parsed.items) {
        const base = batch[it.i];
        if (!base) throw new Error('LLM returned an unknown index');
        out[start + it.i] = { ...base, category: it.category, impact: it.impact, direction: it.direction as Dir, symbols: it.symbols.filter((s) => allowed.has(s)), classifier: 'llm' };
      }
    } catch {
      for (let i = 0; i < batch.length; i++) out[start + i] = batch[i] as Headline;
    }
  }
  return out;
}
