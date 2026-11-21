/** Weekly review (Sunday 18:00 local) and the memo proposed for profile.yaml. Pure. */
import {
  BIAS_TEXT, DAY, ET, MIN, dayKey, fromZoned, hhmm, minutesOfDay, zoned,
  type BiasCall, type Brief, type Catalyst, type GuardrailFiring,
} from '@desk/contracts';
import { Cites, callKey, etStamp, makeBrief, monthDay, signed, usd, weekdayName, type BriefSection } from './common';
import type { WeeklyCtx } from './types';

export const WEEKLY_SECTIONS = ['calibration', 'capture', 'guardrails', 'best', 'worst', 'next_week'] as const;
/** A group of calls counts as a confirmed edge in the memo at this size and hit rate. */
export const EDGE_MIN_CALLS = 3;
export const EDGE_MIN_HIT = 0.6;

/** The attributes commonality is computed from. Themes can be a pattern; trivia cannot. */
export interface ReadAttrs {
  id: string;
  catalystType: string | null;
  dominantFactor: string | null;
  timeOfDay: string;
  guardrails: string[];
  instrument: string; direction: string; horizon: string;
}

export function timeOfDay(t: string | number): string {
  const m = minutesOfDay(t, ET);
  return m < 570 ? 'pre-market' : m < 660 ? 'open' : m < 840 ? 'midday' : m < 960 ? 'afternoon' : 'after-hours';
}
const dirOf = (c: BiasCall): number => (c.call.endsWith('long') ? 1 : c.call.endsWith('short') ? -1 : 0);

export function readAttrs(c: BiasCall, catalysts: Catalyst[], firings: GuardrailFiring[]): ReadAttrs {
  const from = Date.parse(c.createdAt), to = Date.parse(c.expiresAt);
  const next = c.nextCatalyst && Date.parse(c.nextCatalyst.at) <= to ? c.nextCatalyst.id : null;
  const cat = catalysts.find((x) => x.id === c.trigger.ref) ?? catalysts.find((x) => x.id === next);
  const top = [...c.factors].sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))[0];
  const fired = firings.filter((f) => { const t = Date.parse(f.ts); return t >= from && t <= to; }).map((f) => f.pattern);
  return {
    id: c.id, catalystType: cat?.code ?? null, dominantFactor: top && top.score !== 0 ? top.factor : null,
    timeOfDay: timeOfDay(c.createdAt), guardrails: [...new Set<string>(fired)].sort(),
    instrument: c.instrument, direction: dirOf(c) > 0 ? 'long' : dirOf(c) < 0 ? 'short' : 'flat', horizon: c.horizon,
  };
}

const allSame = <T>(xs: T[]): boolean => xs.every((x) => x === xs[0]);

/** What every item shares. No theme shared by all of them means no theme is claimed. */
export function commonality(items: ReadAttrs[]): { themes: string[]; trivia: string[]; text: string } {
  if (items.length < 2) return { themes: [], trivia: [], text: items.length === 0 ? 'Nothing to compare.' : 'One read; nothing to compare it with.' };
  const first = items[0]!;
  const themes: string[] = [];
  if (allSame(items.map((i) => i.catalystType))) themes.push(first.catalystType === null ? 'no catalyst behind any of them' : `same catalyst type (${first.catalystType})`);
  if (first.dominantFactor !== null && allSame(items.map((i) => i.dominantFactor))) themes.push(`${first.dominantFactor} dominated each`);
  if (allSame(items.map((i) => i.timeOfDay))) themes.push(`same time of day (${first.timeOfDay})`);
  const sharedRails = first.guardrails.filter((g) => items.every((i) => i.guardrails.includes(g)));
  if (sharedRails.length) themes.push(`same guardrail fired (${sharedRails.join(', ')})`);
  const trivia: string[] = [];
  if (allSame(items.map((i) => i.instrument))) trivia.push(`the instrument (${first.instrument})`);
  if (allSame(items.map((i) => i.direction))) trivia.push(`the direction (${first.direction})`);
  if (allSame(items.map((i) => i.horizon))) trivia.push(`the horizon (${first.horizon})`);
  const n = items.length;
  const text = themes.length ? `In common, ${n} of ${n}: ${themes.join('; ')}.`
    : trivia.length ? `Nothing in common beyond ${trivia.join(' and ')}.` : 'Nothing in common.';
  return { themes, trivia, text };
}

/** Best: right calls by the size of the move in the call's direction. Worst: wrong calls by the move against. */
export function rankReads(calls: BiasCall[], n = 3): { best: BiasCall[]; worst: BiasCall[] } {
  const fav = (c: BiasCall): number => (c.outcome?.movePct ?? 0) * dirOf(c);
  const scored = calls.filter((c) => c.outcome && c.outcome.correct !== null && dirOf(c) !== 0);
  return {
    best: scored.filter((c) => c.outcome!.correct === true).sort((a, b) => fav(b) - fav(a)).slice(0, n),
    worst: scored.filter((c) => c.outcome!.correct === false).sort((a, b) => fav(a) - fav(b)).slice(0, n),
  };
}

function readLine(c: BiasCall, a: ReadAttrs, now: number): string {
  const tags = [a.catalystType ?? 'no catalyst', a.dominantFactor ? `${a.dominantFactor} led` : 'no factor led', a.timeOfDay, a.guardrails.length ? a.guardrails.join('+') : 'no guardrail'];
  return `${weekdayName(c.createdAt)} ${etStamp(c.createdAt, now)} ${c.instrument} ${BIAS_TEXT[c.call]} ${c.probability.toFixed(2)}: ${signed(c.outcome!.movePct, 2)}% move, ${c.outcome!.correct ? 'right' : 'wrong'}. [${tags.join(', ')}]`;
}

function readsSection(calls: BiasCall[], ctx: WeeklyCtx, cites: Cites, none: string): { lines: string[]; common: ReturnType<typeof commonality> } {
  const attrs = calls.map((c) => readAttrs(c, ctx.catalysts, ctx.firings));
  const common = commonality(attrs);
  if (calls.length === 0) return { lines: [none], common };
  calls.forEach((c) => cites.add(`outcome ${callKey(c)} ${dayKey(c.createdAt)}`, 'bias engine', c.outcome!.resolvedAt));
  return { lines: [...calls.map((c, i) => readLine(c, attrs[i]!, ctx.now)), common.text], common };
}

export function calibrationRows(ctx: Pick<WeeklyCtx, 'calibration'>): string[] {
  const rows = ctx.calibration.buckets.filter((b) => b.n > 0);
  if (rows.length === 0) return ['No scored calls yet. No calibration to show.'];
  return rows.map((b) => `${b.lo.toFixed(2)} to ${b.hi.toFixed(2)}: predicted ${b.predicted.toFixed(2)}, realized ${b.realized === null ? 'no data' : b.realized.toFixed(2)}, n=${b.n}`);
}

function captureLines(ctx: WeeklyCtx, cites: Cites): string[] {
  const l = ctx.ledger;
  if (!l) return ['Capture: no data.'];
  cites.add('override ledger', 'journal', ctx.journalAsOf);
  const pc = (x: number | null, n?: number): string => (x === null ? 'no data' : `${Math.round(x)}%${n === undefined ? '' : ` (n=${n})`}`);
  return [
    `Plan capture ${pc(l.planCapturePct, ctx.captureCounts?.plan)} vs override capture ${pc(l.overrideCapturePct, ctx.captureCounts?.override)}.`,
    `Override ledger: ${usd(l.monthToDateUsd)} month to date over ${l.instances} overrides.`,
  ];
}

function scorecardLines(ctx: WeeklyCtx, cites: Cites): string[] {
  const rows = ctx.scorecard.filter((r) => r.fired > 0 || r.retired);
  if (rows.length === 0) return ['No guardrail fired this week.'];
  cites.add('guardrail scorecard', 'journal', ctx.journalAsOf);
  return rows.map((r) => `${r.pattern}: fired ${r.fired}, complied ${r.complied}, overrode ${r.overrode}, saved ${usd(r.savedUsd)}, cost ${usd(r.costUsd)}${r.retired ? ' (retired)' : ''}`);
}

function nextWeekLines(ctx: WeeklyCtx, cites: Cites): string[] {
  const w = ctx.tier1Window ?? { beforeMin: 60, afterMin: 45 };
  const cats = [...ctx.nextWeek].sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  if (cats.length === 0) return ['Nothing on next week\'s calendar.'];
  return cats.map((c) => {
    cites.add(`catalyst ${c.name}`, c.source, c.asOf);
    const t = Date.parse(c.scheduledAt);
    const block = c.tier === 1 ? ` BLOCKED ${hhmm(t - w.beforeMin * MIN)} to ${hhmm(t + w.afterMin * MIN)} ET.` : '';
    return `${weekdayName(t)} ${monthDay(t)} ${hhmm(t)} ET ${c.name} (T${c.tier}).${block}`;
  });
}

/** Monday (local) of the week `now` falls in, as YYYY-MM-DD. */
export function weekKey(now: number, tz: string): string {
  const z = zoned(now, tz);
  return dayKey(fromZoned(z.year, z.month, z.day, 12, 0, tz) - ((z.weekday + 6) % 7) * DAY, tz);
}

export function weeklyReview(ctx: WeeklyCtx): Brief {
  const cites = new Cites();
  const { best, worst } = rankReads(ctx.calls);
  if (ctx.calibration.buckets.some((b) => b.n > 0)) cites.add('calibration', `journal (${ctx.calibration.source})`, ctx.calibration.updatedAt ?? ctx.journalAsOf);
  const sections: BriefSection[] = [
    { key: 'calibration', title: `Calibration (n=${ctx.calibration.n})`, lines: calibrationRows(ctx) },
    { key: 'capture', title: 'Plan capture vs override capture', lines: captureLines(ctx, cites) },
    { key: 'guardrails', title: 'Guardrail scorecard', lines: scorecardLines(ctx, cites) },
    { key: 'best', title: 'Three best reads', lines: readsSection(best, ctx, cites, 'No right calls scored this week.').lines },
    { key: 'worst', title: 'Three worst reads', lines: readsSection(worst, ctx, cites, 'No wrong calls scored this week.').lines },
    { key: 'next_week', title: 'Next week', lines: nextWeekLines(ctx, cites) },
  ];
  const tz = ctx.profile.timezone;
  return makeBrief('weekly', ctx.now, dayKey(ctx.now, tz), sections, cites, [weekKey(ctx.now, tz), String(ctx.calibration.n), ...ctx.calls.map((c) => c.id).sort()]);
}

function confirmedEdges(ctx: WeeklyCtx): string[] {
  const groups = new Map<string, { n: number; hits: number }>();
  for (const c of ctx.calls) {
    if (!c.outcome || c.outcome.correct === null || dirOf(c) === 0) continue;
    const a = readAttrs(c, ctx.catalysts, ctx.firings);
    for (const key of [a.catalystType ? `${a.catalystType} calls` : 'off-catalyst calls', a.dominantFactor ? `${a.dominantFactor}-led calls` : null, `${a.timeOfDay} calls`]) {
      if (!key) continue;
      const g = groups.get(key) ?? { n: 0, hits: 0 };
      groups.set(key, { n: g.n + 1, hits: g.hits + (c.outcome.correct ? 1 : 0) });
    }
  }
  return [...groups.entries()].filter(([, g]) => g.n >= EDGE_MIN_CALLS && g.hits / g.n >= EDGE_MIN_HIT)
    .sort((a, b) => b[1].hits / b[1].n - a[1].hits / a[1].n).map(([k, g]) => `${k} ${g.hits} of ${g.n} right`);
}

/**
 * The memo proposed for profile.yaml. Always `approved: false`: the trader reads and edits it in the app,
 * and only an approved memo is appended to the profile.
 */
export function weeklyMemo(ctx: WeeklyCtx): { week: string; text: string; approved: false } {
  const week = weekKey(ctx.now, ctx.profile.timezone);
  const { best, worst } = rankReads(ctx.calls);
  const scored = ctx.calls.filter((c) => c.outcome && c.outcome.correct !== null).length;
  const edges = confirmedEdges(ctx);
  const l = ctx.ledger;
  if (l && l.planCapturePct !== null && l.overrideCapturePct !== null && l.planCapturePct > l.overrideCapturePct) {
    edges.push(`following the plan captured ${Math.round(l.planCapturePct)}% vs ${Math.round(l.overrideCapturePct)}% on overrides`);
  }
  const patterns = ctx.scorecard.filter((r) => r.fired > 0).map((r) => `${r.pattern} fired ${r.fired}, overrode ${r.overrode}, cost ${usd(r.costUsd)}`);
  const attrs = (cs: BiasCall[]): ReadAttrs[] => cs.map((c) => readAttrs(c, ctx.catalysts, ctx.firings));
  const weights = (ctx.weightChanges ?? []).map((w) => `${w.factor} ${w.from.toFixed(3)} to ${w.to.toFixed(3)} (${w.evidence})`);
  const cal = ctx.calibration.buckets.filter((b) => b.n > 0 && b.realized !== null)
    .map((b) => `${b.predicted.toFixed(2)} predicted, ${b.realized!.toFixed(2)} realized, n=${b.n}`);
  const text = [
    `Week of ${week}. ${scored} scored calls.`,
    `Edges confirmed: ${edges.length ? edges.join('; ') : `none (no group reached ${EDGE_MIN_CALLS} calls at ${Math.round(EDGE_MIN_HIT * 100)}%)`}.`,
    `Patterns observed: ${patterns.length ? patterns.join('; ') : 'no guardrail fired'}.`,
    `Best reads: ${best.length ? commonality(attrs(best)).text : 'none scored.'} Worst reads: ${worst.length ? commonality(attrs(worst)).text : 'none scored.'}`,
    `Weights adjusted: ${weights.length ? weights.join('; ') : 'none proposed'}.`,
    `Evidence: calibration ${cal.length ? cal.join('; ') : 'no scored buckets'} (${ctx.calibration.source}, as of ${etStamp(ctx.calibration.updatedAt ?? ctx.journalAsOf, ctx.now)}).`,
  ].join('\n');
  return { week, text, approved: false };
}
