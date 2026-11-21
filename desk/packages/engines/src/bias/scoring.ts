/** Stage 2b: weights, the composite score, and the documented score -> label -> probability map. */
import { DEFAULT_WEIGHTS, FactorName, clamp, round, type BiasLabel, type CalibrationBucket, type FactorScore, type Horizon } from '@desk/contracts';
import type { CalibrationMap, RawFactor, Weights } from './types';

const FACTORS = FactorName.options;

/** What matters at each horizon: multipliers on the profile weights, renormalised afterwards. */
export const HORIZON_TILT: Record<Horizon, Weights> = {
  intraday: { catalyst: 1.2, rates: 1.2, fed: 1, regime: 0.6, breadth: 1, positioning: 0.8, news: 1.2, structure: 1.3, calendar: 0.8, cross_asset: 1 },
  swing: { catalyst: 1, rates: 1, fed: 1, regime: 1, breadth: 1, positioning: 1, news: 1, structure: 1, calendar: 1, cross_asset: 1 },
  position: { catalyst: 0.8, rates: 1, fed: 1.5, regime: 1.5, breadth: 1.2, positioning: 1.4, news: 0.7, structure: 0.6, calendar: 1.2, cross_asset: 1.2 },
};
/** |score| under this is No edge. */
export const DEAD_BAND = 0.25;
/** Strong needs |score| at or above this and STRONG_AGREEMENT independent factors at |1| or more on the same side. */
export const STRONG_SCORE = 1.0;
export const STRONG_AGREEMENT = 3;
export const P_MIN = 0.5, P_CAP = 0.85;
/** Probability at the edge of the dead band, and what each full point of score adds. */
export const P_EDGE = 0.52, P_PER_POINT = 0.22;
/** A Lean never prints above the probability a Strong starts at. */
export const LEAN_CAP = 0.68;
/** Catalyst resolved inside 2 hours: it holds at least half the weight and the composite is multiplied. */
export const CATALYST_MIN_SHARE = 0.5, CATALYST_RESOLVED_MULT = 1.25;
/** Catalyst live and not yet matched: everything else is pre-print evidence, so it is halved. */
export const CATALYST_LIVE_MULT = 0.5;

/** Factors that are the same information count once toward Strong. */
const GROUP: Record<FactorName, string> = {
  catalyst: 'catalyst', rates: 'rates', fed: 'rates', regime: 'regime', breadth: 'breadth', positioning: 'positioning',
  news: 'news', structure: 'structure', calendar: 'calendar', cross_asset: 'cross_asset',
};

export function normaliseWeights(w: Partial<Weights> | undefined): Weights {
  const out = {} as Weights;
  for (const f of FACTORS) { const x = w?.[f]; out[f] = typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : DEFAULT_WEIGHTS[f]; }
  return out;
}

/**
 * Effective weights: profile weight x horizon tilt, zero for a factor with no usable input (missing or stale),
 * the rest renormalised to 1 so the missing weight is redistributed pro rata. With a dominant catalyst the
 * catalyst is lifted to at least half.
 */
export function effectiveWeights(raw: RawFactor[], weights: Weights, horizon: Horizon, catalystDominant: boolean): Weights {
  const out = {} as Weights;
  for (const f of FACTORS) out[f] = 0;
  for (const r of raw) out[r.factor] = r.missing || r.stale ? 0 : weights[r.factor] * HORIZON_TILT[horizon][r.factor];
  const norm = (): void => {
    const total = FACTORS.reduce((a, f) => a + out[f], 0);
    if (total > 0) for (const f of FACTORS) out[f] /= total;
  };
  norm();
  if (catalystDominant && out.catalyst > 0 && out.catalyst < CATALYST_MIN_SHARE) {
    const rest = 1 - out.catalyst;
    for (const f of FACTORS) out[f] = f === 'catalyst' ? CATALYST_MIN_SHARE : rest > 0 ? (out[f] / rest) * (1 - CATALYST_MIN_SHARE) : 0;
  }
  return out;
}

export interface Composite { factors: FactorScore[]; weighted: number; multiplier: number; score: number; agreeing: number }
/** score = clamp(multiplier x sum(weight x factor score), -2, 2). */
export function combine(raw: RawFactor[], weights: Weights, horizon: Horizon, catalyst: 'resolved' | 'live' | 'none'): Composite {
  const dominant = catalyst === 'resolved' && raw.some((r) => r.factor === 'catalyst' && !r.missing && r.score !== 0);
  const w = effectiveWeights(raw, weights, horizon, dominant);
  const factors: FactorScore[] = raw.map((r) => ({ factor: r.factor, score: r.score, weight: round(w[r.factor], 4), evidence: r.evidence, asOf: r.asOf, stale: r.stale }));
  const weighted = factors.reduce((a, f) => a + f.weight * f.score, 0);
  const multiplier = dominant ? CATALYST_RESOLVED_MULT : catalyst === 'live' ? CATALYST_LIVE_MULT : 1;
  const score = round(clamp(weighted * multiplier, -2, 2), 3);
  const side = Math.sign(score);
  const agreeing = new Set(factors.filter((f) => f.weight > 0 && side !== 0 && Math.sign(f.score) === side && Math.abs(f.score) >= 1).map((f) => GROUP[f.factor])).size;
  return { factors, weighted: round(weighted, 4), multiplier, score, agreeing };
}

/**
 * Monotone map from |score| to probability: 0.50 inside the dead band; 0.52 at its edge, +0.022 per 0.1 of
 * score above it, hard-capped at 0.85 (reached at |score| 1.75).
 */
export function probabilityFromScore(absScore: number): number {
  if (absScore < DEAD_BAND) return P_MIN;
  return Math.min(P_CAP, P_EDGE + P_PER_POINT * (absScore - DEAD_BAND));
}
export function labelFromScore(score: number, agreeing: number, capAtLean: boolean): BiasLabel {
  if (Math.abs(score) < DEAD_BAND) return 'no_edge';
  const strong = !capAtLean && Math.abs(score) >= STRONG_SCORE && agreeing >= STRONG_AGREEMENT;
  return score > 0 ? (strong ? 'strong_long' : 'lean_long') : strong ? 'strong_short' : 'lean_short';
}

/* ───────── calibration map ───────── */

export const CALIBRATION_EDGES = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
export const CALIBRATION_MIN_N = 20;
export const bucketIndex = (p: number): number => clamp(Math.floor((p - 0.5) / 0.05 + 1e-9), 0, CALIBRATION_EDGES.length - 2);

/**
 * Bucket shrinkage toward the realized hit rate. A bucket with n >= 20 resolved calls gets the target
 * predicted + n/(n+20) x (realized - predicted); targets are then made non-decreasing across buckets
 * (pool adjacent violators, weighted by n) and stored as a shift. Buckets under 20 keep shift 0: identity.
 */
export function buildCalibrationMap(buckets: CalibrationBucket[]): CalibrationMap {
  const rows = buckets.map((b) => {
    const ok = b.n >= CALIBRATION_MIN_N && b.realized != null;
    return { b, ok, target: ok ? b.predicted + (b.n / (b.n + CALIBRATION_MIN_N)) * (b.realized! - b.predicted) : b.predicted };
  });
  const blocks: Array<{ sum: number; w: number; idx: number[] }> = [];
  rows.forEach((r, i) => {
    if (!r.ok) return;
    blocks.push({ sum: r.target * r.b.n, w: r.b.n, idx: [i] });
    while (blocks.length > 1 && blocks.at(-2)!.sum / blocks.at(-2)!.w > blocks.at(-1)!.sum / blocks.at(-1)!.w) {
      const top = blocks.pop()!, under = blocks.at(-1)!;
      under.sum += top.sum; under.w += top.w; under.idx.push(...top.idx);
    }
  });
  for (const blk of blocks) for (const i of blk.idx) rows[i]!.target = blk.sum / blk.w;
  return { buckets: rows.map((r) => ({ lo: r.b.lo, hi: r.b.hi, n: r.b.n, shift: r.ok ? round(r.target - r.b.predicted, 4) : 0 })) };
}
/** Apply the map; identity when there is none. The result never leaves [0.50, 0.85]. */
export function applyCalibration(map: CalibrationMap | null | undefined, p: number): number {
  const b = map?.buckets.find((x, i, all) => p >= x.lo && (p < x.hi || i === all.length - 1));
  return clamp(p + (b?.shift ?? 0), P_MIN, P_CAP);
}
