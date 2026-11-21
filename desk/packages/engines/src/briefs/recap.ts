/** Post-close recap (16:30 ET): under 200 words, enforced here. Pure. */
import { BIAS_TEXT, ET, dayKey, mean, type BiasCall, type Brief } from '@desk/contracts';
import { Cites, callKey, changePct, countWords, etStamp, makeBrief, px, signed, staleTag, usd, type BriefSection } from './common';
import type { RecapCtx } from './types';

export const RECAP_SECTIONS = ['call', 'happened', 'verdict', 'adherence', 'ledger', 'tomorrow'] as const;
export const RECAP_MAX_WORDS = 199;
/** A line that must survive trimming is clipped to this many words. */
const CLIP_WORDS = 26;

/** Lower priority number = kept longer. Priority 0 is never dropped, only clipped. */
interface Ranked { section: (typeof RECAP_SECTIONS)[number]; text: string; priority: number }
const TITLES: Record<(typeof RECAP_SECTIONS)[number], string> = {
  call: 'The call', happened: 'What happened', verdict: 'Right or wrong', adherence: 'Plan adherence', ledger: 'Override ledger', tomorrow: 'Tomorrow',
};

function verdict(c: BiasCall): string {
  const o = c.outcome;
  if (!o) return `${c.instrument} ${c.horizon}: not resolved yet.`;
  const move = `${signed(o.movePct, 2)}% over the call`;
  if (o.correct === null) return `${c.instrument} ${c.horizon}: unscored (${BIAS_TEXT[c.call]}), ${move}.`;
  return `${c.instrument} ${c.horizon}: ${o.correct ? 'right' : 'wrong'}, ${move}.`;
}

function clip(text: string, words: number): string {
  const w = text.split(/\s+/).filter(Boolean);
  return w.length <= words ? text : `${w.slice(0, words).join(' ')}…`;
}

function assemble(lines: Ranked[]): BriefSection[] {
  return RECAP_SECTIONS.map((key) => ({ key, title: TITLES[key], lines: lines.filter((l) => l.section === key).map((l) => l.text) }));
}
const words = (sections: BriefSection[]): number => countWords(sections.map((s) => [s.title, ...s.lines].join(' ')).join(' '));

/** Drops the lowest-priority lines first (last added first within a priority), then clips what must stay. */
export function trimToWords(lines: Ranked[], max: number): Ranked[] {
  let kept = [...lines];
  while (words(assemble(kept)) > max) {
    const worst = Math.max(...kept.map((l) => l.priority));
    if (worst === 0) break;
    const i = kept.map((l) => l.priority).lastIndexOf(worst);
    kept = kept.filter((_, j) => j !== i);
  }
  for (let n = CLIP_WORDS; words(assemble(kept)) > max && n >= 6; n -= 4) kept = kept.map((l) => ({ ...l, text: clip(l.text, n) }));
  return kept;
}

export function postCloseRecap(ctx: RecapCtx): Brief {
  const { now } = ctx;
  const cites = new Cites();
  const lines: Ranked[] = [];
  const add = (section: Ranked['section'], text: string, priority: number): void => { lines.push({ section, text, priority }); };
  const primary = ctx.profile.instruments.primary;
  const rank = (c: BiasCall): number => { const i = primary.indexOf(c.instrument); return i < 0 ? primary.length : i; };
  const calls = [...ctx.calls].sort((a, b) => rank(a) - rank(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));

  if (calls.length === 0) add('call', 'No call was made today.', 0);
  calls.forEach((c, i) => {
    cites.add(callKey(c), 'bias engine', c.createdAt);
    add('call', `${c.instrument} ${c.horizon}: ${BIAS_TEXT[c.call]} ${c.probability.toFixed(2)} at ${etStamp(c.createdAt, now)}.`, i === 0 ? 0 : 3 + i);
  });

  const main = calls[0]?.instrument ?? primary[0] ?? 'NQ';
  const q = ctx.quotes[main];
  if (q) {
    cites.add(q.symbol, q.source, q.asOf);
    const chg = changePct(q);
    add('happened', `${main} ${px(q.price)}, ${chg === null ? 'change: no data' : `${signed(chg, 2)}% on the day`}${staleTag(q, now)}.`, 0);
  } else add('happened', `${main}: no data.`, 0);
  ctx.resolved.forEach((c, i) => {
    cites.add(`catalyst ${c.name}`, c.source, c.resolution?.resolvedAt ?? c.asOf);
    const u = c.unit ?? '';
    const actual = c.resolution?.actual;
    add('happened', `${c.name}: ${actual === null || actual === undefined ? 'actual no data' : `${actual}${u}`} vs consensus ${c.consensus === null ? 'no data' : `${c.consensus}${u}`}.`, 2 + i);
  });

  if (calls.length === 0) add('verdict', 'Nothing to score.', 0);
  calls.forEach((c, i) => {
    if (c.outcome) cites.add(`outcome ${c.instrument} ${c.horizon}`, 'bias engine', c.outcome.resolvedAt);
    add('verdict', verdict(c), i === 0 ? 0 : 3 + i);
  });

  const scored = ctx.closedTickets.filter((t) => t.result !== null);
  if (scored.length === 0) add('adherence', 'No closed trades today. No adherence score.', 0);
  else {
    cites.add('plan adherence', 'journal', ctx.journalAsOf);
    const scores = scored.map((t) => t.result!.adherence);
    add('adherence', `${Math.round(mean(scores))} over ${scored.length} closed ${scored.length === 1 ? 'trade' : 'trades'}.`, 0);
    const worst = [...scored].sort((a, b) => a.result!.adherence - b.result!.adherence)[0]!;
    if (scored.length > 1) add('adherence', `Lowest: ${worst.instrument} ${worst.direction} at ${Math.round(worst.result!.adherence)}.`, 5);
  }

  const overridesToday = ctx.closedTickets.flatMap((t) => t.overrides);
  if (ctx.ledger) {
    cites.add('override ledger', 'journal', ctx.journalAsOf);
    add('ledger', `${usd(ctx.ledger.monthToDateUsd)} month to date over ${ctx.ledger.instances} overrides; ${overridesToday.length} today.`, 0);
    const { planCapturePct: p, overrideCapturePct: o } = ctx.ledger;
    if (p !== null && o !== null) add('ledger', `Plan capture ${Math.round(p)}% vs override capture ${Math.round(o)}%.`, 2);
  } else add('ledger', `Ledger: no data. ${overridesToday.length} overrides on today's closed trades.`, 0);

  const tomorrow = [...ctx.tomorrow].sort((a, b) => a.tier - b.tier || Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  if (tomorrow.length === 0) add('tomorrow', 'Nothing on the calendar.', 0);
  tomorrow.forEach((c, i) => {
    cites.add(`catalyst ${c.name}`, c.source, c.asOf);
    add('tomorrow', `${etStamp(c.scheduledAt, now)} ${c.name} (T${c.tier}), consensus ${c.consensus === null ? 'no data' : `${c.consensus}${c.unit ?? ''}`}.`, i === 0 ? 0 : 1 + i);
  });

  const kept = trimToWords(lines, RECAP_MAX_WORDS);
  const dropped = lines.length - kept.length;
  const material = [...calls.map((c) => `${c.id}|${c.outcome?.correct ?? 'open'}`), `dropped|${dropped}`];
  return makeBrief('recap', now, dayKey(now, ET), assemble(kept), cites, material);
}
