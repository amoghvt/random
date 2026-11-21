/** Tone rules in code (spec section 11): three sentences at most, short, no hedging, no lecture. */
import { fmtNum, type OverrideLedger } from '@desk/contracts';

export const MAX_SENTENCES = 3;
export const MAX_CHARS = 320;
/** Seeded from profile.yaml `voice.banned`; the profile's own list is passed in at runtime. */
export const DEFAULT_BANNED = ['consider', 'you may want to', 'might want to', 'perhaps', 'it could be argued'];
/** Moralizing and sarcasm markers. "A glove, not a parent." */
export const MORALIZING = ['you always', 'you never', 'told you', 'should know better', 'learn your lesson', 'discipline', 'reckless', 'irresponsible', 'greedy', 'shame', 'once again', 'as usual', 'good luck with that', 'genius'];

/** Sentence ends at . ! ? followed by whitespace and a capital, digit, quote or sign; "1.2%" and "incl. opposite" do not end one. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?]["'”)]?)\s+(?=["“(+−$]?[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
}

const escapeRe = (s: string): string => s.replace(/[^a-z0-9 ]/gi, (ch) => `\\${ch}`);

/** Problems with a trader-facing line; empty means it passes. */
export function lintVoice(text: string, banned: string[] = DEFAULT_BANNED): string[] {
  const problems: string[] = [];
  const lower = text.toLowerCase();
  for (const phrase of banned) if (new RegExp(`(?:^|[^a-z])${escapeRe(phrase.toLowerCase())}`).test(lower)) problems.push(`banned phrase: "${phrase}"`);
  for (const phrase of MORALIZING) if (lower.includes(phrase)) problems.push(`moralizing or sarcastic: "${phrase}"`);
  const n = sentences(text).length;
  if (n > MAX_SENTENCES) problems.push(`${n} sentences, max ${MAX_SENTENCES}`);
  if (text.length > MAX_CHARS) problems.push(`${text.length} characters, max ${MAX_CHARS}`);
  if (/\n\s*\n/.test(text)) problems.push('more than one paragraph');
  if (text.trim().length === 0) problems.push('empty');
  return problems;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-11-06' -> 'Nov 6'. */
export function shortDate(day: string): string {
  const [, m, d] = day.slice(0, 10).split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}`;
}
export const joinAnd = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
export const plural = (n: number, one: string, many = `${one}s`): string => `${fmtNum(n)} ${n === 1 ? one : many}`;
/** 3 -> "Three" for small counts at the start of a sentence; digits otherwise. */
export const countWord = (n: number): string => ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'][n] ?? fmtNum(n);
/** 0.33 -> "one-third"; other fractions print as a percent. */
export function fractionWord(f: number): string {
  if (Math.abs(f - 1 / 3) < 0.02) return 'one-third';
  if (Math.abs(f - 0.5) < 0.005) return 'half';
  if (Math.abs(f - 0.25) < 0.005) return 'a quarter';
  if (Math.abs(f - 1) < 0.005) return 'all';
  return `${Math.round(f * 100)}%`;
}
/** First sentence of a firm clause, without the trailing period, capped so the quote fits the line. */
export function clauseQuote(clause: string, max = 140): string {
  const first = (sentences(clause)[0] ?? clause).replace(/[.\s]+$/, '').replace(/"/g, "'");
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}

export const signedUsd = (x: number): string => `${x < 0 ? '−' : x > 0 ? '+' : ''}$${fmtNum(Math.abs(Math.round(x)))}`;
/** "overrides are −$6,400 MTD across 7" as a clause; null when nothing is logged, so the clause is dropped. */
export function ledgerClause(ledger: OverrideLedger): string | null {
  return ledger.instances > 0 ? `overrides are ${signedUsd(ledger.monthToDateUsd)} MTD across ${fmtNum(ledger.instances)}` : null;
}
/** The one line that replaces a repeated flag: the override ledger number alone. */
export function ledgerLine(ledger: OverrideLedger): string {
  return ledger.instances > 0 ? `Overrides ${signedUsd(ledger.monthToDateUsd)} MTD across ${fmtNum(ledger.instances)}.` : 'No overrides logged this month.';
}
/** "Plan exits captured 61% of available moves; overrides 23%." with each half only when its number exists. */
export function captureLine(ledger: OverrideLedger): string | null {
  const plan = ledger.planCapturePct, over = ledger.overrideCapturePct;
  if (plan != null && over != null) return `Plan exits captured ${Math.round(plan)}% of available moves this month; overrides ${Math.round(over)}%.`;
  if (plan != null) return `Plan exits captured ${Math.round(plan)}% of available moves this month; no override exits to compare yet.`;
  if (over != null) return `Override exits captured ${Math.round(over)}% of available moves this month; no plan exits scored yet.`;
  return null;
}
