/** Shared formatting for briefs and Ask: citations, as-of stamps, stale tags. Pure. */
import {
  BIAS_TEXT, ET, ageLabel, dayKey, fmtNum, freshness, hashId, hhmm, iso, zoned,
  type BiasCall, type Brief, type Catalyst, type Quote, type Stamped,
} from '@desk/contracts';

export type Citation = Brief['citations'][number];
export type BriefSection = Brief['sections'][number];

/** Collects one citation per label; the first source/as-of for a label wins. */
export class Cites {
  private readonly m = new Map<string, Citation>();
  add(label: string, source: string, asOf: string): void {
    if (!this.m.has(label)) this.m.set(label, { label, source, asOf });
  }
  list(): Citation[] { return [...this.m.values()]; }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function monthDay(t: number | string, tz: string = ET): string {
  const z = zoned(t, tz);
  return `${MONTHS[z.month - 1]} ${z.day}`;
}
export function weekdayName(t: number | string, tz: string = ET): string {
  return DAYS[zoned(t, tz).weekday] ?? '';
}
/** "14:32 ET", or "Nov 20 14:32 ET" when the instant is not on the same ET day as `now`. */
export function etStamp(t: number | string, now: number): string {
  const time = `${hhmm(t, ET)} ET`;
  return dayKey(t, ET) === dayKey(now, ET) ? time : `${monthDay(t)} ${time}`;
}

/** Prices: thousands get no decimals, everything else two. */
export const px = (x: number): string => fmtNum(x, Math.abs(x) >= 1000 ? 0 : 2);
export const signed = (x: number, dp: number): string => `${x >= 0 ? '+' : '−'}${fmtNum(Math.abs(x), dp)}`;
export const usd = (x: number): string => `${x < 0 ? '−' : ''}$${fmtNum(Math.abs(Math.round(x)))}`;
export const signedUsd = (x: number): string => `${x < 0 ? '−' : '+'}$${fmtNum(Math.abs(Math.round(x)))}`;
export const countWords = (s: string): number => s.split(/\s+/).filter(Boolean).length;
export const ensureDot = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** " (3h old)" when the value is older than 3x its cadence, else "". */
export function staleTag(d: { asOf: string; cadenceSec: number }, now: number): string {
  return freshness(d, now) === 'stale' ? ` (${ageLabel(d.asOf, now)} old)` : '';
}

/** Day change in percent, from the previous close when present, else the feed's own figure. */
export function changePct(q: Quote): number | null {
  if (q.prevClose !== null && q.prevClose !== 0) return (q.price / q.prevClose - 1) * 100;
  return q.changePct;
}

/** "DXY 99.80 +0.2%" with a stale tag; registers the citation. */
export function quoteText(name: string, q: Quote | null | undefined, now: number, cites?: Cites): string {
  if (!q) return `${name} no data`;
  cites?.add(q.symbol, q.source, q.asOf);
  const chg = changePct(q);
  return `${name} ${px(q.price)} ${chg === null ? '(change: no data)' : `${signed(chg, 1)}%`}${staleTag(q, now)}`;
}

/** "10Y 4.94% −9 bp 1d (3h old)". */
export function yieldText(name: string, st: Stamped<number> | null | undefined, chg1dBp: number | null | undefined, now: number, cites?: Cites): string {
  if (!st || st.value === null || st.asOf === null) return `${name} no data`;
  cites?.add(name, st.source ?? 'rates feed', st.asOf);
  const chg = chg1dBp === null || chg1dBp === undefined ? '' : ` ${signed(chg1dBp, 0)} bp 1d`;
  return `${name} ${st.value.toFixed(2)}%${chg}${st.stale ? ` (${ageLabel(st.asOf, now)} old)` : ''}`;
}

export const callKey = (c: BiasCall): string => `call ${c.instrument} ${c.horizon}`;

/** The call as the trader reads it: label, probability, expiry, the three facts, the kill condition. */
export function callLine(c: BiasCall, now: number): string {
  const expired = Date.parse(c.expiresAt) <= now;
  const head = `${c.instrument} ${c.horizon}: ${BIAS_TEXT[c.call]} ${c.probability.toFixed(2)}, ${expired ? 'expired' : 'expires'} ${etStamp(c.expiresAt, now)}.`;
  const facts = c.facts.length ? ` Facts: ${c.facts.join('; ')}.` : ' Facts: none recorded.';
  const untrusted = c.firstMoveUntrusted ? ' First move, not yet trusted.' : '';
  const stale = c.factors.filter((f) => f.stale).map((f) => f.factor);
  const staleNote = stale.length ? ` Stale inputs: ${stale.join(', ')}.` : '';
  return `${head}${facts}${untrusted} Kill: ${ensureDot(c.killCondition.text)}${staleNote}`;
}

const HORIZON_ORDER = { intraday: 0, swing: 1, position: 2 } as const;
/** Primary instruments first, then intraday before swing before position. */
export function sortCalls(calls: BiasCall[], primary: string[]): BiasCall[] {
  const rank = (c: BiasCall): number => {
    const i = primary.indexOf(c.instrument);
    return (i < 0 ? primary.length : i) * 10 + HORIZON_ORDER[c.horizon];
  };
  return [...calls].sort((a, b) => rank(a) - rank(b) || a.instrument.localeCompare(b.instrument));
}

/** The matrix collapsed to its most probable branch and that branch's trade. */
export function branchTrade(cat: Catalyst): string {
  const m = cat.matrix;
  if (!m) return 'no matrix';
  const top = [...m.branches].sort((a, b) => b.probability - a.probability)[0];
  if (!top) return 'no matrix';
  const head = `${top.label} (p ${top.probability.toFixed(2)})`;
  if (!top.trade) return `${head}: No edge, ${top.noTradeReason ?? 'stand aside'}`;
  const t = top.trade;
  return `${head}: ${t.direction} ${t.instrument}, ${t.entry.text}, invalidation ${px(t.invalidation.price)}`;
}

/** "08:30 ET CPI (T1): consensus 0.3%, whisper 0.2%, implied move ±1.1% (options). Branch trade: ..." */
export function catalystLine(cat: Catalyst, now: number, cites?: Cites): string {
  cites?.add(`catalyst ${cat.name}`, cat.source, cat.asOf);
  if (cat.matrix) cites?.add(`matrix ${cat.name}`, 'catalyst engine', cat.matrix.generatedAt);
  const u = cat.unit ?? '';
  const num = (v: number | null): string => (v === null ? 'no data' : `${v}${u}`);
  const implied = cat.impliedMovePct === null ? 'no data' : `±${cat.impliedMovePct.toFixed(1)}% (${cat.impliedMoveSource ?? 'source not given'})`;
  const actual = cat.resolution ? `, actual ${num(cat.resolution.actual)}` : '';
  return `${etStamp(cat.scheduledAt, now)} ${cat.name} (T${cat.tier}): consensus ${num(cat.consensus)}, whisper ${num(cat.whisper)}, implied move ${implied}${actual}. Branch trade: ${ensureDot(branchTrade(cat))}`;
}

export function makeBrief(kind: Brief['kind'], now: number, forDay: string, sections: BriefSection[], cites: Cites, material: string[]): Brief {
  const wordCount = countWords(sections.map((s) => [s.title, ...s.lines].join(' ')).join(' '));
  // The id hashes only what is material, so an unchanged regeneration keeps the same id.
  return { id: hashId('brief', kind, forDay, ...material), kind, ts: iso(now), forDay, sections, citations: cites.list(), wordCount };
}

/** Plain text for the push body and for Ask. */
export function renderBriefText(brief: Brief): string {
  return brief.sections.map((s) => [s.title.toUpperCase(), ...s.lines].join('\n')).join('\n\n');
}
