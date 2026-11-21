/** Text helpers shared by the intent builders: lock-screen line fitting, price/size wording, voice lint. */
import { ET, INSTRUMENTS, fmtNum, fmtUsd, hhmm, round, zoned } from '@desk/contracts';
import type { NotificationIntent, TradePlan } from '@desk/contracts';

/** A line longer than this wraps or truncates on an iPhone lock screen. */
export const LINE_MAX = 110;

/** Phrases the desk never uses (spec section 10, Voice; profile.voice.banned). */
export const BANNED_PHRASES = ['consider', 'you may want to', 'might want to', 'perhaps', 'it could be argued'] as const;

/** Collapse whitespace and cut at a word boundary so the line fits `max` characters. */
export function clip(text: string, max: number = LINE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  if (max <= 1) return '…';
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.(-]+$/, '')}…`;
}

/** Ends a sentence unless it already ends in punctuation or was clipped. */
export const stop = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);
const bare = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');

/** 27062 -> "27,062"; 142.5 -> "142.50". */
export const px = (x: number): string => fmtNum(x, Number.isInteger(x) ? 0 : 2);
export const etTime = (t: number | string): string => `${hhmm(t, ET)} ET`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const etDayTime = (t: number | string): string => `${DAYS[zoned(t, ET).weekday]} ${etTime(t)}`;
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Contracts for futures, USD notional for perps and stocks; leverage when the venue has one. */
export function sizeText(instrument: string, size: { units: number; notionalUsd: number; leverage: number | null }): string {
  const spec = INSTRUMENTS[instrument];
  const base = spec && spec.pointValue > 0 ? `${fmtNum(size.units, Number.isInteger(size.units) ? 0 : 2)} ct` : fmtUsd(size.notionalUsd);
  return size.leverage !== null ? `${base} at ${round(size.leverage, 1)}x` : base;
}

/**
 * Lines 2 and 3 of a trade-entry notification. Together they carry every lock-screen field:
 * direction, instrument, account, size, entry trigger, then T1, invalidation and time stop.
 */
export function tradeLines(plan: TradePlan & { accountId: string; size: NonNullable<TradePlan['size']> }): [string, string] {
  const head = `${cap(plan.direction)} ${plan.instrument} on ${plan.accountId}, ${sizeText(plan.instrument, plan.size)}. Entry: `;
  const tail = `T1 ${px(plan.targets[0].price)}. Invalidation ${px(plan.invalidation.price)}. Time stop: `;
  return [
    head + stop(clip(bare(plan.entry.text), LINE_MAX - head.length - 1)),
    tail + stop(clip(bare(plan.timeStop.text), LINE_MAX - tail.length - 1)),
  ];
}

export interface ValidationResult { ok: boolean; missing: string[] }

/**
 * A trade-entry notification must be actionable from the lock screen (spec section 10): the text
 * shows instrument, direction, account, size, entry trigger, T1, invalidation and time stop, and
 * `ticketPrefill` carries the same plan so the tap opens a pre-filled ticket.
 */
export function validateTradeNotification(intent: NotificationIntent): ValidationResult {
  const p = intent.ticketPrefill;
  if (!p) return { ok: false, missing: ['ticketPrefill'] };
  const text = intent.lines.join(' ').replace(/\s+/g, ' ').toLowerCase();
  const has = (s: string): boolean => s.length > 0 && text.includes(s.toLowerCase());
  const lead = (s: string, n: number): string => bare(s).slice(0, n);
  const missing: string[] = [];
  if (!p.instrument || !has(p.instrument)) missing.push('instrument');
  if (!has(p.direction)) missing.push('direction');
  if (!p.accountId || !has(p.accountId)) missing.push('account');
  if (!p.size || !(p.size.units > 0) || !has(sizeText(p.instrument, p.size))) missing.push('size');
  if (!(has(lead(p.entry.text, 20)) || (p.entry.price !== undefined && has(px(p.entry.price))))) missing.push('entryTrigger');
  if (!has(`T1 ${px(p.targets[0].price)}`)) missing.push('t1');
  if (!has(px(p.invalidation.price))) missing.push('invalidation');
  if (!(has(lead(p.timeStop.text, 12)) || (p.timeStop.at !== undefined && has(etTime(p.timeStop.at))))) missing.push('timeStop');
  if (!intent.deepLink.startsWith('/ticket?prefill=')) missing.push('deepLink');
  return { ok: missing.length === 0, missing };
}

/** Voice and lock-screen lint. Returns the problems; empty means clean. */
export function voiceLint(lines: readonly string[]): string[] {
  const problems: string[] = [];
  if (lines.length < 1 || lines.length > 3) problems.push(`expected 1 to 3 lines, got ${lines.length}`);
  lines.forEach((line, i) => {
    if (line.trim().length === 0) problems.push(`line ${i + 1} is empty`);
    if (line.length > LINE_MAX) problems.push(`line ${i + 1} is ${line.length} chars (max ${LINE_MAX})`);
    for (const phrase of BANNED_PHRASES) {
      if (new RegExp(`\\b${phrase}`, 'i').test(line)) problems.push(`line ${i + 1} says "${phrase}"`);
    }
  });
  if (lines[0] !== undefined && !/\d/.test(lines[0])) problems.push('line 1 carries no number');
  return problems;
}
