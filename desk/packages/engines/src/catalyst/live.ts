import { BIAS_TEXT, HOUR, MIN, fmtPct, hashId, hhmm, iso, percentile, round } from '@desk/contracts';
import type { Candle, Catalyst, Headline, NotificationIntent, ScenarioBranch, ScenarioMatrix, TradePlan } from '@desk/contracts';
import { MIXED_KEY, SECONDARY_RANGES, SPECS, fmtValue } from './branches';
import type { Spec } from './branches';
import { priceAt } from './history';
import { STRONG_CONVICTION, branchConviction, fmtPrice, isMixed } from './matrix';
import type { MixedParams } from './matrix';
import type { CatalystEx, HistoricalReactionEx } from './types';

export interface Release { actual: number; secondary?: number; ts: string | number; headlineId?: string }

const inRange = (x: number, lo: number | null, hi: number | null): boolean => (lo === null || x >= lo) && (hi === null || x < hi);

/** The one branch a print lands in, or null when a split on the secondary metric cannot be decided without it. */
export function matchBranch(catalyst: Pick<Catalyst, 'code'>, matrix: ScenarioMatrix, actual: number, secondary?: number): ScenarioBranch | null {
  const spec = SPECS[catalyst.code];
  const mixed = matrix.branches.find((b) => b.match.key === MIXED_KEY);
  const params = matrix.inputs.mixed as MixedParams | null | undefined;
  const step = matrix.inputs.step as number | undefined;
  if (mixed && params && spec && step !== undefined && secondary !== undefined && isMixed(spec, step, params, actual, secondary)) return mixed;
  const hits = matrix.branches.filter((b) => b.match.key !== MIXED_KEY && inRange(actual, b.match.lo, b.match.hi));
  if (hits.length <= 1) return hits[0] ?? null;
  if (secondary === undefined) return null;
  return hits.find((b) => { const r = SECONDARY_RANGES[b.match.key ?? '']; return r !== undefined && inRange(secondary, r.lo, r.hi); }) ?? null;
}

/** Resolve a catalyst against its matrix. Synchronous; the caller pushes `branchNotification` of the result. */
export function matchRelease<T extends CatalystEx>(catalyst: T, release: Release, now: number): T {
  const branch = catalyst.matrix ? matchBranch(catalyst, catalyst.matrix, release.actual, release.secondary) : null;
  const pendingSplit = catalyst.matrix !== null && branch === null;
  return {
    ...catalyst,
    status: pendingSplit ? 'live' : 'resolved',
    resolution: { actual: release.actual, branchId: branch?.id ?? null, resolvedAt: iso(typeof release.ts === 'number' ? release.ts : Date.parse(release.ts)), ...(release.headlineId ? { headlineId: release.headlineId } : {}) },
    ...(catalyst.secondary && release.secondary !== undefined ? { secondary: { ...catalyst.secondary, actual: release.secondary } } : {}),
    asOf: iso(now),
  };
}

/* ───────────── wire-headline parsing ───────────── */

const NUM = String.raw`([+-]?\d+(?:\.\d+)?)`;
const VS = String.raw`(?:\s*(?:vs\.?|versus|v\.?)\s*${NUM}\s*(?:%|k)?\s*(?:expected|exp\.?|est\.?|estimate|forecast|consensus))?`;
const MOM = String.raw`\s*\(?(?:mom|m\/m)\)?`;
const pctAfter = (alias: string): RegExp => new RegExp(String.raw`${alias}${MOM}[\s:]*${NUM}\s*%${VS}`, 'gi');

interface Pattern { primary: RegExp; secondary?: RegExp }
const PATTERNS: Partial<Record<Catalyst['code'], () => Pattern>> = {
  CPI: () => ({ primary: pctAfter(String.raw`\bcore (?:cpi|inflation(?: rate)?)`), secondary: pctAfter(String.raw`(?<!core )\b(?:cpi|inflation rate)`) }),
  CORE_CPI: () => ({ primary: pctAfter(String.raw`\bcore (?:cpi|inflation(?: rate)?)`) }),
  PCE: () => ({ primary: pctAfter(String.raw`\bcore pce(?: price index)?`), secondary: pctAfter(String.raw`(?<!core )\bpce(?: price index)?`) }),
  CORE_PCE: () => ({ primary: pctAfter(String.raw`\bcore pce(?: price index)?`) }),
  PPI: () => ({ primary: pctAfter(String.raw`(?<!core )\bppi`), secondary: pctAfter(String.raw`\bcore ppi`) }),
  CORE_PPI: () => ({ primary: pctAfter(String.raw`\bcore ppi`) }),
  NFP: () => ({
    primary: new RegExp(String.raw`\b(?:non-?farm payrolls|nfp)[\s:]*${NUM}\s*k\b${VS}`, 'gi'),
    secondary: new RegExp(String.raw`\bunemployment rate[\s:]*${NUM}\s*%${VS}`, 'gi'),
  }),
};
const NOT_A_PRINT = /\b(preview|ahead of|expected to|seen at|forecast to|what to watch|will|could|may|might|if)\b|\?/i;
export const HEADLINE_WINDOW_MS = 12 * HOUR;

function single(re: RegExp, text: string): { value: number; consensus: number | null } | null {
  const ms = [...text.matchAll(re)];
  if (ms.length === 0) return null;
  const vals = new Set(ms.map((m) => m[1]));
  if (vals.size !== 1) return null;
  const m = ms[0]!;
  return { value: Number(m[1]), consensus: m[2] !== undefined ? Number(m[2]) : null };
}

/**
 * Pull the actual from a wire headline such as "US Core CPI MoM 0.3% vs 0.2% expected". Strict: the headline must be
 * stamped at or after the release, name the keyed MoM series, carry a unit, and, when it quotes a consensus, quote the
 * one on the catalyst. Anything else returns null and the calendar feed is waited for.
 */
export function parseReleaseHeadline(headline: Headline, catalyst: CatalystEx): Release | null {
  const ts = Date.parse(headline.ts), T = Date.parse(catalyst.scheduledAt);
  if (!(ts >= T - MIN && ts <= T + HEADLINE_WINDOW_MS)) return null;
  const text = headline.title.replace(/[−–]/g, '-').replace(/\s+/g, ' ');
  if (NOT_A_PRINT.test(text)) return null;
  if (catalyst.code === 'FOMC') {
    if (!/\b(fed|fomc|federal reserve)\b/i.test(text) || catalyst.prior === null) return null;
    const cut = /\b(?:cuts?|lowers?)\b[^.;]*?\b(\d{2,3})\s*(?:bps?|basis points)/i.exec(text);
    const hike = /\b(?:raises?|hikes?|lifts?)\b[^.;]*?\b(\d{2,3})\s*(?:bps?|basis points)/i.exec(text);
    const hold = /\b(?:holds?|leaves?|keeps?)\b[^.;]*\b(?:rates?|unchanged|steady)\b|\brates? unchanged\b/i.test(text);
    if (Number(Boolean(cut)) + Number(Boolean(hike)) + Number(hold) !== 1) return null;
    const actual = cut ? catalyst.prior - Number(cut[1]) / 100 : hike ? catalyst.prior + Number(hike[1]) / 100 : catalyst.prior;
    return { actual: round(actual, 4), ts: headline.ts, headlineId: headline.id };
  }
  const pattern = PATTERNS[catalyst.code]?.();
  const spec = SPECS[catalyst.code];
  if (!pattern || !spec) return null;
  const prim = single(pattern.primary, text);
  if (!prim) return null;
  const tol = (spec as Spec).step / 2 - 1e-9;
  if (prim.consensus !== null && catalyst.consensus !== null && Math.abs(prim.consensus - catalyst.consensus) > tol) return null;
  if (catalyst.consensus !== null && Math.abs(prim.value - catalyst.consensus) > spec.step * 12) return null;
  const sec = pattern.secondary && catalyst.secondary ? single(pattern.secondary, text) : null;
  const secOk = sec !== null && !(sec.consensus !== null && catalyst.secondary?.consensus != null && Math.abs(sec.consensus - catalyst.secondary.consensus) > 0.05);
  return { actual: prim.value, ...(secOk && sec ? { secondary: sec.value } : {}), ts: headline.ts, headlineId: headline.id };
}

/* ───────────── the push ───────────── */

const SHORT: Partial<Record<Catalyst['code'], string>> = { CPI: 'Core CPI', CORE_CPI: 'Core CPI', PCE: 'Core PCE', CORE_PCE: 'Core PCE', PPI: 'PPI', CORE_PPI: 'Core PPI', NFP: 'Payrolls', FOMC: 'Fed funds', CLAIMS: 'Claims' };

export interface BranchNotification {
  lines: [string, string, string];
  branchId: string;
  plan: TradePlan | null;
  /** Ready for the notification router: P0 for Tier 1, P1 otherwise, with the pre-filled ticket when the branch trades. */
  intent: NotificationIntent;
}

/**
 * The three lines for the push and the plan for the pre-filled ticket. Null until the catalyst is resolved to a branch.
 * `live` is the measured 10Y after the print; without it line 3 carries the branch's expected rates read.
 */
/**
 * The plan moved to a new reference price with every distance kept. Matrix trades are written the night before from
 * that evening's price; by the release NQ can be hundreds of points away, which left stops and targets on the wrong
 * side of the entry. Levels round to the 0.25 tick.
 */
export function reanchorPlan(plan: TradePlan, price: number): TradePlan {
  const d = price - plan.referencePrice;
  if (!Number.isFinite(d) || d === 0) return plan;
  const s = (x: number): number => Math.round((x + d) * 4) / 4;
  return {
    ...plan, referencePrice: price,
    entry: plan.entry.price != null ? { ...plan.entry, price: s(plan.entry.price) } : plan.entry,
    targets: plan.targets.map((t) => ({ ...t, price: s(t.price) })) as TradePlan['targets'],
    invalidation: { ...plan.invalidation, price: s(plan.invalidation.price) },
  };
}

/** `price`: the instrument's price now; when given, the branch trade's levels are re-anchored to it before they are shown. */
export function branchNotification(catalyst: CatalystEx, live?: { y10: number; y10ChangeBp: number }, price?: number): BranchNotification | null {
  const res = catalyst.resolution, matrix = catalyst.matrix;
  const branch = matrix?.branches.find((b) => b.id === res?.branchId);
  if (!res || !matrix || !branch || res.actual === null) return null;
  const spec = SPECS[catalyst.code] ?? { dp: 2, unit: '' };
  const centre = matrix.inputs.centre as number | undefined;
  const fact = spec.unit === '' && catalyst.code !== 'FOMC' && (SPECS[catalyst.code]?.labels === 'name')
    ? `${catalyst.name}: ${branch.label}.`
    : `${SHORT[catalyst.code] ?? catalyst.name} ${fmtValue(res.actual, spec)} vs ${centre !== undefined ? fmtValue(centre, spec) : 'n/a'}${matrix.inputs.centreBasis === 'prior' ? ' prior' : ''}.`;
  const sec = catalyst.secondary;
  const line1 = sec && sec.actual !== null && sec.consensus !== null ? `${fact} ${SPECS[catalyst.code]?.secondary?.label === 'unemployment' ? 'Unemployment' : sec.code === 'CPI' || sec.code === 'PCE' ? 'Headline' : 'Core'} ${sec.actual.toFixed(1)}% vs ${sec.consensus.toFixed(1)}%.` : fact;
  const t = branch.trade && price ? reanchorPlan(branch.trade, price) : branch.trade;
  const conviction = branchConviction(matrix, branch.id);
  const call = t && conviction !== null ? `${BIAS_TEXT[`${conviction >= STRONG_CONVICTION ? 'strong' : 'lean'}_${t.direction}`]} ${t.instrument} ${conviction.toFixed(2)}` : '';
  const line2 = t
    ? `Branch ${branch.id}: ${call}, entry on second move after ${t.entry.at ? hhmm(t.entry.at) : 'the print'} ET, T1 ${fmtPrice(t.targets[0].price)}, out ${fmtPrice(t.invalidation.price)}, ${t.timeStop.text.charAt(0).toLowerCase()}${t.timeStop.text.slice(1).replace(/\.$/, '')}${t.accountId ? `, ${t.accountId}` : ''}.`
    : `Branch ${branch.id}: ${branch.noTradeReason ?? 'No edge.'}`;
  const line3 = live
    ? `10Y ${live.y10ChangeBp >= 0 ? '+' : '−'}${Math.abs(Math.round(live.y10ChangeBp))} bp to ${live.y10.toFixed(2)}%. ${branch.secondOrder}`
    : `${branch.secondOrder} Expected: ${branch.ratesRead.text}`;
  const lines: [string, string, string] = [line1, line2, line3];
  const intent: NotificationIntent = {
    class: catalyst.tier === 1 ? 'P0' : 'P1', reason: catalyst.tier === 1 ? 'tier1_resolved' : 'catalyst_resolved',
    instrument: t?.instrument ?? catalyst.instruments[0] ?? null, lines, deepLink: `/catalysts/${catalyst.id}`,
    ...(t ? { ticketPrefill: { ...t, reason: { kind: 'catalyst' as const, catalystId: catalyst.id, branchId: branch.id } } } : {}),
    dedupeKey: hashId('ntf', catalyst.id, branch.id, res.resolvedAt), ts: res.resolvedAt,
  };
  return { lines, branchId: branch.id, plan: t, intent };
}

/* ───────────── reaction clock ───────────── */

export const MIN_BASE_RATE_SAMPLE = 4;
export const MUTED_PERCENTILE = 0.25;
export const EXTREME_PERCENTILE = 0.9;

/**
 * Verdict of |move| against the historical |moves| at the same horizon: muted below their 25th percentile, extreme above
 * their 90th, otherwise normal. Null with fewer than 4 samples.
 */
export function verdictFor(move: number, sample: number[]): 'normal' | 'muted' | 'extreme' | null {
  if (sample.length < MIN_BASE_RATE_SAMPLE) return null;
  const xs = sample.map(Math.abs), a = Math.abs(move);
  return a < percentile(xs, MUTED_PERCENTILE) ? 'muted' : a > percentile(xs, EXTREME_PERCENTILE) ? 'extreme' : 'normal';
}

/**
 * 5-minute and 15-minute moves after the release against the historical table. The reference is the last 1m close at or
 * before the release. The verdict uses the longest horizon already printed that has a base rate (15m, then 5m; the
 * first hour once it is in and the shorter horizons have no base rate).
 */
export function reactionClock<T extends CatalystEx>(catalyst: T, candles1m: Candle[], now: number): T {
  const T0 = Date.parse(catalyst.scheduledAt);
  const bars = candles1m.filter((c) => c.t + 60_000 <= now);
  const p0 = priceAt(bars, T0, 5 * MIN);
  const move = (mins: number): number | null => {
    if (p0 === null || now < T0 + mins * MIN) return null;
    const p = priceAt(bars, T0 + mins * MIN, 3 * MIN);
    return p === null ? null : round((p / p0 - 1) * 100, 3);
  };
  const m5 = move(5), m15 = move(15), h1 = move(60);
  const rows = catalyst.history as HistoricalReactionEx[];
  const sample = (f: (r: HistoricalReactionEx) => number | null | undefined): number[] => rows.map(f).filter((x): x is number => x !== null && x !== undefined);
  const horizons: Array<{ name: string; move: number | null; sample: number[] }> = [
    { name: '15m', move: m15, sample: sample((r) => r.m15Pct) },
    { name: '5m', move: m5, sample: sample((r) => r.m5Pct) },
    { name: 'first hour', move: h1, sample: sample((r) => r.h1Pct) },
  ];
  const sym = catalyst.instruments[0] ?? '';
  const read = [m5 !== null ? `5m ${fmtPct(m5, 2)}` : null, m15 !== null ? `15m ${fmtPct(m15, 2)}` : null, h1 !== null ? `1h ${fmtPct(h1, 2)}` : null].filter((x): x is string => x !== null);
  if (read.length === 0) return { ...catalyst, reaction: { m5Pct: null, m15Pct: null, verdict: null, text: p0 === null ? `No ${sym} price at the release.` : 'Reaction clock running: first reading at +5 minutes.' } };
  const scored = horizons.find((h) => h.move !== null && h.sample.length >= MIN_BASE_RATE_SAMPLE);
  const verdict = scored ? verdictFor(scored.move as number, scored.sample) : null;
  const text = scored && verdict
    ? `${sym} ${read.join(', ')}. ${verdict.charAt(0).toUpperCase()}${verdict.slice(1)}: ${scored.name} median is ${round(percentile(scored.sample.map(Math.abs), 0.5), 2)}% over ${scored.sample.length} prints.`
    : `${sym} ${read.join(', ')}. No base rate yet: ${Math.max(...horizons.filter((h) => h.move !== null).map((h) => h.sample.length))} of the ${MIN_BASE_RATE_SAMPLE} prints needed at this horizon.`;
  return { ...catalyst, reaction: { m5Pct: m5, m15Pct: m15, verdict, text } };
}
