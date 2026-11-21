/**
 * Branch templates, the sign tables and the probability model. Everything here is data: the matrix generator reads it.
 * A slot covers [centre + lo*step, centre + hi*step) on the keyed metric; null is open. Slots of a template partition the real line.
 * Two slots may share an interval when they are split on the secondary metric (FOMC tone, earnings guide): SECONDARY_RANGES.
 */
import { round } from '@desk/contracts';
import type { CalendarEvent, EventCode, PredictionMarket, ScenarioBranch } from '@desk/contracts';
import type { FedStance, Regime, Trend } from './types';

export type Family = 'inflation' | 'growth' | 'policy' | 'tone' | 'auction' | 'earnings' | 'adhoc';
/** Slot score: + = a higher print (hot, beat, hawkish tone, auction tail). Multiply by `hawkSign` for the hawk score. Earnings: + = good for the stock. */
export type Score = -2 | -1 | 0 | 1 | 2;

export interface Slot { slug: string; lo: number | null; hi: number | null; score: Score; prior: number; name: string }
export interface Spec {
  family: Family; metric: string; step: number; dp: number; unit: string;
  /** 'grid': the metric prints on a `step` grid, label by value. 'range': label by bounds. 'name': label by slot name only. */
  labels: 'grid' | 'range' | 'name';
  /** +1 when a higher print is hawkish, -1 when it is dovish (claims, unemployment). */
  hawkSign: 1 | -1;
  slots: Slot[];
  /** Minutes after the release for the second-move entry. */
  entryOffsetMin: number;
  /** Secondary metric: tick size and hawk sign, for the mixed-signal branch. */
  secondary?: { code: EventCode; step: number; hawkSign: 1 | -1; label: string };
  centre: 'consensus' | 'prior' | 'zero';
}

const s = (slug: string, lo: number | null, hi: number | null, score: Score, prior: number, name: string): Slot => ({ slug, lo, hi, score, prior, name });

const FOUR: Slot[] = [s('cool', null, -0.5, -1, 0.25, 'Cool'), s('inline', -0.5, 0.5, 0, 0.4, 'In line'), s('hot', 0.5, 1.5, 1, 0.25, 'Hot'), s('very_hot', 1.5, null, 2, 0.1, 'Very hot')];
const PPI4: Slot[] = [s('cool', null, -1.5, -1, 0.2, 'Cool'), s('inline', -1.5, 1.5, 0, 0.45, 'In line'), s('hot', 1.5, 3.5, 1, 0.25, 'Hot'), s('very_hot', 3.5, null, 2, 0.1, 'Very hot')];
const FIVE: Slot[] = [s('far_miss', null, -1.5, -2, 0.1, 'Far miss'), s('miss', -1.5, -0.5, -1, 0.2, 'Miss'), s('inline', -0.5, 0.5, 0, 0.4, 'In line'), s('beat', 0.5, 1.5, 1, 0.2, 'Beat'), s('big_beat', 1.5, null, 2, 0.1, 'Big beat')];
const THREE: Slot[] = [s('miss', null, -0.5, -1, 0.3, 'Miss'), s('inline', -0.5, 0.5, 0, 0.4, 'In line'), s('beat', 0.5, null, 1, 0.3, 'Beat')];
const LOWHIGH: Slot[] = [s('lower', null, -0.5, -1, 0.3, 'Lower'), s('inline', -0.5, 0.5, 0, 0.4, 'In line'), s('higher', 0.5, null, 1, 0.3, 'Higher')];
const FOMC4: Slot[] = [s('cut', null, -0.5, -2, 0.1, 'Cut'), s('hold_dovish', -0.5, 0.5, -1, 0.4, 'Hold, dovish'), s('hold_hawkish', -0.5, 0.5, 1, 0.4, 'Hold, hawkish'), s('hike', 0.5, null, 2, 0.1, 'Hike')];
const tone = (a: string, b: string, c: string): Slot[] => [s('dovish', null, -0.5, -1, 0.3, a), s('neutral', -0.5, 0.5, 0, 0.4, b), s('hawkish', 0.5, null, 1, 0.3, c)];
const EARN: Slot[] = [
  s('miss', null, -0.5, -2, 0.2, 'Miss'),
  s('inline_guide_cut', -0.5, 0.5, -1, 0.08, 'In line, guide cut'), s('inline_guide_held', -0.5, 0.5, 0, 0.22, 'In line, guide held or raised'),
  s('beat_guide_cut', 0.5, null, -1, 0.1, 'Beat, guide cut'), s('beat_guide_held', 0.5, null, 1, 0.2, 'Beat, guide held'), s('beat_and_raise', 0.5, null, 2, 0.2, 'Beat and raise'),
];

/** Split of a shared interval on the secondary metric: FOMC tone (<0 dovish), earnings guide (-1 cut, 0 held, +1 raised). */
export const SECONDARY_RANGES: Readonly<Record<string, { lo: number | null; hi: number | null }>> = {
  hold_dovish: { lo: null, hi: 0 }, hold_hawkish: { lo: 0, hi: null },
  inline_guide_cut: { lo: null, hi: -0.5 }, inline_guide_held: { lo: -0.5, hi: null },
  beat_guide_cut: { lo: null, hi: -0.5 }, beat_guide_held: { lo: -0.5, hi: 0.5 }, beat_and_raise: { lo: 0.5, hi: null },
};
export const MIXED_KEY = 'mixed';

const macro = (family: Family, metric: string, step: number, slots: Slot[], extra: Partial<Spec> = {}): Spec =>
  ({ family, metric, step, dp: 1, unit: '%', labels: 'grid', hawkSign: 1, slots, entryOffsetMin: 15, centre: 'consensus', ...extra });

/** In-line band widths are stated defaults in the calendar feed's units; override per code with `ctx.steps`. */
export const SPECS: Partial<Record<EventCode, Spec>> = {
  CPI: macro('inflation', 'core_cpi_mom', 0.1, FOUR, { secondary: { code: 'CPI', step: 0.1, hawkSign: 1, label: 'headline' } }),
  CORE_CPI: macro('inflation', 'core_cpi_mom', 0.1, FOUR),
  PCE: macro('inflation', 'core_pce_mom', 0.1, FOUR, { secondary: { code: 'PCE', step: 0.1, hawkSign: 1, label: 'headline' } }),
  CORE_PCE: macro('inflation', 'core_pce_mom', 0.1, FOUR),
  PPI: macro('inflation', 'ppi_mom', 0.1, PPI4, { secondary: { code: 'CORE_PPI', step: 0.2, hawkSign: 1, label: 'core' } }),
  CORE_PPI: macro('inflation', 'core_ppi_mom', 0.1, PPI4),
  NFP: macro('growth', 'nfp_k', 50, FIVE, { dp: 0, unit: 'K', labels: 'range', secondary: { code: 'UNEMPLOYMENT', step: 0.1, hawkSign: -1, label: 'unemployment' } }),
  UNEMPLOYMENT: macro('growth', 'unemployment_rate', 0.1, LOWHIGH, { hawkSign: -1 }),
  ISM_MFG: macro('growth', 'ism_mfg', 1, THREE, { unit: '', labels: 'range' }),
  ISM_SVC: macro('growth', 'ism_svc', 1, THREE, { unit: '', labels: 'range' }),
  JOLTS: macro('growth', 'jolts_m', 0.2, THREE, { unit: 'M', labels: 'range', dp: 2 }),
  RETAIL_SALES: macro('growth', 'retail_sales_mom', 0.2, THREE, { labels: 'range' }),
  CLAIMS: macro('growth', 'claims_k', 10, LOWHIGH, { dp: 0, unit: 'K', labels: 'range', hawkSign: -1 }),
  GDP: macro('growth', 'gdp_qoq', 0.4, THREE, { labels: 'range' }),
  REGIONAL_FED: macro('growth', 'regional_fed', 5, THREE, { unit: '', labels: 'range' }),
  FOMC: macro('policy', 'fed_funds_upper', 0.25, FOMC4, { dp: 2, labels: 'name', entryOffsetMin: 45, centre: 'prior' }),
  FOMC_MINUTES: macro('tone', 'tone', 1, tone('Dovish', 'No new information', 'Hawkish'), { unit: '', labels: 'name', centre: 'zero' }),
  FED_CHAIR: macro('tone', 'tone', 1, tone('Dovish', 'No new information', 'Hawkish'), { unit: '', labels: 'name', centre: 'zero' }),
  FED_SPEAKER: macro('tone', 'tone', 1, tone('Dovish', 'No new information', 'Hawkish'), { unit: '', labels: 'name', centre: 'zero' }),
  SUMMIT: macro('tone', 'tone', 1, tone('Deal or de-escalation', 'No change', 'Breakdown or escalation'), { unit: '', labels: 'name', centre: 'zero' }),
  IPO: macro('tone', 'tone', 1, tone('Prices above range', 'Prices in range', 'Prices below range or pulled'), { unit: '', labels: 'name', centre: 'zero' }),
  TREASURY_AUCTION: macro('auction', 'tail_bp', 1, tone('Stops through', 'On the screws', 'Tails'), { unit: ' bp', labels: 'name', centre: 'zero' }),
  EARNINGS: macro('earnings', 'eps_surprise_pct', 4, EARN, { labels: 'name', centre: 'zero' }),
};
export const SUPPORTED_CODES = Object.keys(SPECS) as EventCode[];

/** Catalyst code -> the calendar codes published together: the keyed metric first, the secondary second. */
export const KEYING: Partial<Record<EventCode, { primary: EventCode; secondary?: EventCode }>> = {
  CPI: { primary: 'CORE_CPI', secondary: 'CPI' }, PCE: { primary: 'CORE_PCE', secondary: 'PCE' },
  PPI: { primary: 'PPI', secondary: 'CORE_PPI' }, NFP: { primary: 'NFP', secondary: 'UNEMPLOYMENT' },
};

/* ───────────── sign logic: explicit tables ───────────── */

export const HIGH_ODDS = 0.6;
export const PRICED_ODDS = 0.8;
export type Band = 'hike_priced' | 'hiking' | 'hold' | 'hold_near_round' | 'cutting' | 'cut_priced';

/** Odds at or above HIGH_ODDS dominate the stance; a hold with the 10Y within 10 bp of a round level is its own band. */
export function regimeBand(r: Regime): Band {
  if (r.hikeProb !== null && r.hikeProb >= HIGH_ODDS) return 'hike_priced';
  if (r.cutProb !== null && r.cutProb >= HIGH_ODDS) return 'cut_priced';
  if (r.fedStance === 'hold' && r.y10RoundLevelDistanceBp !== null && Math.abs(r.y10RoundLevelDistanceBp) <= 10) return 'hold_near_round';
  const m: Record<FedStance, Band> = { hiking: 'hiking', cutting: 'cutting', hold: 'hold' };
  return m[r.fedStance];
}

type Sign = -1 | 0 | 1;
type Cell = Sign | Record<Trend, Sign>;
type Row = Partial<Record<Score, Cell>>;
const byTrend = (uptrend: Sign, correction: Sign, downtrend: Sign): Record<Trend, Sign> => ({ uptrend, correction, downtrend });

/** Index direction by regime band and slot score. +1 long, -1 short, 0 no edge. */
export const SIGN_TABLE: Record<'inflation' | 'growth', Record<Band, Row>> = {
  inflation: {
    // A hot core is bearish everywhere. In-line is only a trade when hikes are priced: the squeeze branch.
    hike_priced: { [-1]: 1, 0: 1, 1: -1, 2: -1 },
    hiking: { [-1]: 1, 0: 0, 1: -1, 2: -1 },
    hold: { [-1]: 1, 0: 0, 1: -1, 2: -1 },
    hold_near_round: { [-1]: 1, 0: 0, 1: -1, 2: -1 },
    cutting: { [-1]: 1, 0: 0, 1: -1, 2: -1 },
    cut_priced: { [-1]: 1, 0: 0, 1: -1, 2: -1 },
  },
  growth: {
    // Hiking: good news is bad news. A far miss is a growth scare unless the tape is in an uptrend.
    hike_priced: { [-2]: byTrend(1, 0, -1), [-1]: 1, 0: 0, 1: -1, 2: -1 },
    hiking: { [-2]: byTrend(1, 0, -1), [-1]: 1, 0: 0, 1: -1, 2: -1 },
    // On hold: good news is good news, unless it pushes the 10Y through a round level.
    hold: { [-2]: -1, [-1]: -1, 0: 0, 1: 1, 2: 1 },
    hold_near_round: { [-2]: -1, [-1]: 0, 0: 0, 1: -1, 2: -1 },
    // Cutting: bad news is good news until it is a growth scare; a big beat prices the cuts out.
    cutting: { [-2]: byTrend(1, 0, -1), [-1]: 1, 0: 0, 1: 0, 2: -1 },
    cut_priced: { [-2]: byTrend(1, 0, -1), [-1]: 1, 0: 0, 1: 0, 2: -1 },
  },
};
/** Policy, tone and auction slots trade against the hawk score; earnings trade with the score. */
export const SIMPLE_SIGN: Record<'policy' | 'tone' | 'auction' | 'earnings' | 'adhoc', Row> = {
  policy: { [-2]: 1, [-1]: 1, 0: 0, 1: -1, 2: -1 },
  tone: { [-1]: 1, 0: 0, 1: -1 },
  auction: { [-1]: 1, 0: 0, 1: -1 },
  earnings: { [-2]: -1, [-1]: -1, 0: 0, 1: 1, 2: 1 },
  adhoc: { [-1]: 1, 0: 0, 1: -1 },
};

export interface SignRead { sign: Sign; band: Band; rule: string }

export function signFor(family: Family, score: Score, regime: Regime): SignRead {
  const band = regimeBand(regime);
  if (family === 'inflation' || family === 'growth') {
    const cell = SIGN_TABLE[family][band][score] ?? 0;
    const sign = typeof cell === 'number' ? cell : cell[regime.trend];
    return { sign, band, rule: `${family}/${band}/${score}${typeof cell === 'number' ? '' : `/${regime.trend}`}` };
  }
  let sign = (SIMPLE_SIGN[family][score] ?? 0) as Sign;
  let rule = `${family}/${score}`;
  if (family === 'policy' && Math.abs(score) === 2) {
    const p = score === 2 ? regime.hikeProb : regime.cutProb;
    if (p !== null && p >= PRICED_ODDS) { sign = 0; rule += '/priced'; }
  }
  return { sign, band, rule };
}

const pctTxt = (p: number | null): string => (p === null ? 'not on file' : `${Math.round(p * 100)}%`);

/** The second-order read, one sentence, with the regime numbers that drove it. */
export function secondOrderFor(family: Family, slot: Slot, regime: Regime, read: SignRead): string {
  const hike = `hike odds ${pctTxt(regime.hikeProb)}`, cut = `cut odds ${pctTxt(regime.cutProb)}`;
  if (family === 'inflation') {
    if (slot.score >= 1) return read.band === 'hike_priced' ? `Hot with ${hike}: bearish, the hike gets locked in.` : read.band === 'cut_priced' || read.band === 'cutting' ? `Hot with ${cut}: bearish, cuts get priced out.` : `Hot with ${hike}: bearish, hikes get priced in.`;
    if (slot.score === 0) return read.band === 'hike_priced' ? `In line with ${hike}: the squeeze branch, shorts cover.` : `In line with ${hike}, ${cut}: nothing new is priced.`;
    return `Cool with ${hike}: bullish, yields come off.`;
  }
  if (family === 'growth') {
    const strong = slot.score > 0, flat = slot.score === 0;
    if (flat) return `In line with ${hike}, ${cut}: nothing new is priced.`;
    if (read.band === 'hike_priced' || read.band === 'hiking') return strong ? `Strong with ${hike}: good news is bad news, yields up.` : slot.score === -2 ? `Far miss in a ${regime.trend}: ${read.sign > 0 ? 'hike relief wins' : read.sign < 0 ? 'growth scare wins' : 'hike relief and growth scare cancel'}.` : `Soft with ${hike}: bad news is good news, hikes come out.`;
    if (read.band === 'cutting' || read.band === 'cut_priced') return strong ? (slot.score === 2 ? `Big beat with ${cut}: cuts get priced out.` : `Beat with ${cut}: growth fine, cuts intact, no edge.`) : slot.score === -2 ? `Far miss in a ${regime.trend}: ${read.sign > 0 ? 'bad news is good news' : read.sign < 0 ? 'growth scare, cuts do not help' : 'cut hopes and growth scare cancel'}.` : `Soft with ${cut}: bad news is good news.`;
    if (read.band === 'hold_near_round') return strong ? `Strong with the 10Y ${Math.abs(Math.round(regime.y10RoundLevelDistanceBp ?? 0))} bp from a round level: yields through it, bearish.` : `Weak near a round level in yields: ${read.sign === 0 ? 'lower yields and weaker growth cancel' : 'growth scare'}.`;
    return strong ? 'Strong with the Fed on hold: good news is good news.' : 'Weak with the Fed on hold: bad news is bad news.';
  }
  if (family === 'policy') return read.rule.endsWith('/priced') ? `${slot.name} was ${pctTxt(slot.score === 2 ? regime.hikeProb : regime.cutProb)} priced: nothing new, the trade is the presser.` : slot.score < 0 ? `${slot.name}: yields down, index bid.` : `${slot.name}: yields up, index offered.`;
  if (family === 'earnings') return slot.score > 0 ? 'A beat is not a positive reaction until the tape confirms it.' : slot.score < 0 ? 'The guide outranks the quarter.' : 'In line with the guide intact: nothing new.';
  return slot.score === 0 ? 'Nothing new.' : slot.score < 0 ? 'Risk-on read: yields ease, index bid.' : 'Risk-off read: yields up or risk premium up, index offered.';
}

/** Stated rate priors in bp by |score| (2Y, 10Y), used when no recorded 10Y sample covers the bucket. */
export const RATE_PRIOR_BP: Record<Family, Record<number, [number, number]>> = {
  inflation: { 0: [0, 0], 1: [7, 5], 2: [14, 10] },
  growth: { 0: [0, 0], 1: [5, 4], 2: [10, 8] },
  policy: { 0: [0, 0], 1: [7, 4], 2: [15, 10] },
  tone: { 0: [0, 0], 1: [3, 3], 2: [6, 5] },
  auction: { 0: [0, 0], 1: [1, 3], 2: [2, 5] },
  earnings: { 0: [0, 0], 1: [0, 0], 2: [0, 0] },
  adhoc: { 0: [0, 0], 1: [3, 4], 2: [6, 8] },
};
/** 2Y move per bp of 10Y move for data releases (stated; no 2Y series is recorded). */
export const Y2_PER_Y10 = 1.3;

/* ───────────── branch geometry ───────────── */

export const BRANCH_IDS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const r6 = (x: number): number => round(x, 6);
export const slotBounds = (slot: Slot, centre: number, step: number): { lo: number | null; hi: number | null } =>
  ({ lo: slot.lo === null ? null : r6(centre + slot.lo * step), hi: slot.hi === null ? null : r6(centre + slot.hi * step) });

export function fmtValue(x: number, spec: Pick<Spec, 'dp' | 'unit'>): string { return `${x.toFixed(spec.dp)}${spec.unit}`; }

export function slotLabel(slot: Slot, spec: Spec, centre: number, step: number): string {
  const b = slotBounds(slot, centre, step);
  if (spec.labels === 'name') return slot.name;
  if (spec.labels === 'grid') {
    const first = b.lo === null ? null : r6(b.lo + step / 2), last = b.hi === null ? null : r6(b.hi - step / 2);
    const body = first === null ? `${fmtValue(last ?? centre, spec)} or lower` : last === null ? `${fmtValue(first, spec)} or higher` : first === last ? fmtValue(first, spec) : `${fmtValue(first, spec)} to ${fmtValue(last, spec)}`;
    return `${slot.name}: ${body}`;
  }
  const body = b.lo === null ? `below ${fmtValue(b.hi ?? centre, spec)}` : b.hi === null ? `${fmtValue(b.lo, spec)} or higher` : `${fmtValue(b.lo, spec)} to below ${fmtValue(b.hi, spec)}`;
  return `${slot.name}: ${body}`;
}

/** Slot of a template that contains `offset` (value minus centre). Shared intervals return the first slot. */
export function slotOf(spec: Spec, offset: number, step: number): Slot {
  const x = offset / step;
  return spec.slots.find((sl) => (sl.lo === null || x >= sl.lo - 1e-9) && (sl.hi === null || x < sl.hi - 1e-9)) ?? spec.slots[spec.slots.length - 1]!;
}

type Range = { lo: number | null; hi: number | null };
function chainErrors(ranges: Range[], what: string): string[] {
  const errs: string[] = [];
  const sorted = [...ranges].sort((a, b) => (a.lo ?? -Infinity) - (b.lo ?? -Infinity));
  if (sorted.length === 0) return [`${what}: no ranges`];
  if (sorted[0]!.lo !== null) errs.push(`${what}: not open below`);
  if (sorted[sorted.length - 1]!.hi !== null) errs.push(`${what}: not open above`);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!, b = sorted[i + 1];
    if (a.lo !== null && a.hi !== null && a.hi <= a.lo) errs.push(`${what}: empty range ${a.lo}..${a.hi}`);
    if (b && a.hi !== b.lo) errs.push(`${what}: gap or overlap at ${a.hi} / ${b.lo}`);
  }
  return errs;
}

/**
 * Empty when the branches' match rules are exhaustive and non-overlapping: intervals chain from -inf to +inf on the keyed
 * metric, and branches sharing an interval chain over the secondary metric. The mixed-signal branch is an overlay, not a range.
 */
export function partitionErrors(branches: Array<Pick<ScenarioBranch, 'id' | 'match'>>): string[] {
  const line = branches.filter((b) => b.match.key !== MIXED_KEY);
  const groups = new Map<string, typeof line>();
  for (const b of line) { const k = `${b.match.lo}|${b.match.hi}`; groups.set(k, [...(groups.get(k) ?? []), b]); }
  const errs = chainErrors([...groups.values()].map((g) => ({ lo: g[0]!.match.lo, hi: g[0]!.match.hi })), 'primary');
  for (const [k, g] of groups) {
    const secs = g.map((b) => SECONDARY_RANGES[b.match.key ?? '']);
    if (g.length === 1) { if (secs[0]) errs.push(`${k}: lone branch has a secondary split`); continue; }
    if (secs.some((x) => !x)) errs.push(`${k}: shared interval without a secondary split`);
    else errs.push(...chainErrors(secs as Range[], `secondary ${k}`));
  }
  return errs;
}

/* ───────────── probabilities ───────────── */

export const MIN_SURPRISE_SAMPLE = 6;
export const MAX_SURPRISE_SAMPLE = 24;
export const MIXED_PRIOR = 0.08;

export interface ProbResult { probs: number[]; source: ScenarioBranch['probabilitySource']; basis: string }
const normalise = (xs: number[]): number[] => { const t = xs.reduce((a, b) => a + b, 0); return xs.map((x) => x / t); };

/** Split each interval's mass across slots that share it, in proportion to their priors. */
function spread(spec: Spec, massOfInterval: (slot: Slot) => number): number[] {
  return spec.slots.map((sl) => {
    const peers = spec.slots.filter((p) => p.lo === sl.lo && p.hi === sl.hi);
    return massOfInterval(sl) * (sl.prior / peers.reduce((a, p) => a + p.prior, 0));
  });
}

/** Prediction-market buckets on the keyed metric -> slots, by the bucket's representative value. Needs 90% of the mass in ranged buckets. */
export function probsFromMarkets(spec: Spec, centre: number, step: number, markets: PredictionMarket[]): ProbResult | null {
  for (const m of markets) {
    const ranged = m.outcomes.filter((o) => (o.lo ?? null) !== null || (o.hi ?? null) !== null);
    const total = ranged.reduce((a, o) => a + o.prob, 0);
    if (ranged.length < 2 || total < 0.9 || total > 1.1) continue;
    const mass = new Map<Slot, number>();
    for (const o of ranged) {
      const lo = o.lo ?? null, hi = o.hi ?? null;
      const rep = lo !== null && hi !== null ? (lo + hi) / 2 : lo !== null ? lo + step * 1e-3 : (hi as number) - step * 1e-3;
      const sl = slotOf(spec, rep - centre, step);
      mass.set(sl, (mass.get(sl) ?? 0) + o.prob);
    }
    return { probs: normalise(spread(spec, (sl) => mass.get(spec.slots.find((p) => p.lo === sl.lo && p.hi === sl.hi)!) ?? 0)), source: 'prediction_market', basis: `${m.venue} "${m.title}" as of ${m.asOf}` };
  }
  return null;
}

/** Empirical distribution of past surprises (actual minus consensus) over the slots, with half a count added per interval. */
export function probsFromSurprises(spec: Spec, step: number, surprises: number[]): ProbResult | null {
  const xs = surprises.slice(0, MAX_SURPRISE_SAMPLE);
  if (xs.length < MIN_SURPRISE_SAMPLE) return null;
  const count = new Map<Slot, number>();
  for (const x of xs) { const sl = slotOf(spec, x, step); count.set(sl, (count.get(sl) ?? 0) + 1); }
  const intervals = new Set(spec.slots.map((sl) => `${sl.lo}|${sl.hi}`)).size;
  const probs = spread(spec, (sl) => ((count.get(spec.slots.find((p) => p.lo === sl.lo && p.hi === sl.hi)!) ?? 0) + 0.5) / (xs.length + 0.5 * intervals));
  return { probs: normalise(probs), source: 'historical', basis: `surprise distribution of the last ${xs.length} prints` };
}

export function probsFromPrior(spec: Spec, regime: Regime): ProbResult {
  if (spec.family === 'policy' && (regime.hikeProb !== null || regime.cutProb !== null)) {
    const hike = Math.min(regime.hikeProb ?? 0.05, 0.98), cut = Math.min(regime.cutProb ?? 0.05, 0.98 - hike);
    const hold = Math.max(1 - hike - cut, 0.02);
    return { probs: normalise(spec.slots.map((sl) => (sl.slug === 'hike' ? hike : sl.slug === 'cut' ? cut : hold / 2))), source: 'prior', basis: 'Fed pricing from regime.hikeProb / cutProb; hold split evenly on tone' };
  }
  return { probs: normalise(spec.slots.map((sl) => sl.prior)), source: 'prior', basis: 'stated prior' };
}

/** Past surprises for a calendar code, newest first, using only prints before `before`. */
export function pastSurprises(events: CalendarEvent[], code: EventCode, before: number): number[] {
  return events
    .filter((e) => e.code === code && e.actual !== null && e.consensus !== null && Date.parse(e.time) < before)
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .map((e) => round((e.actual as number) - (e.consensus as number), 6));
}
