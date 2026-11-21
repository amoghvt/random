/** Monthly re-fit of the factor weights against the journal's resolved calls. */
import { FactorName, round, type BiasCall } from '@desk/contracts';
import { isResolvedDirectional } from './outcome';
import { normaliseWeights } from './scoring';
import type { Weights } from './types';

const FACTORS = FactorName.options;
export const REFIT_MIN_CALLS = 50;
/** No weight moves more than this (absolute) in one re-fit. */
export const REFIT_MAX_STEP = 0.05;
const GAIN = 4, L2 = 1, RATE = 0.05, ITERATIONS = 3000;

export interface RefitMove {
  factor: FactorName; from: number; to: number; delta: number;
  /** Calls where the factor sided with / against the call, and how often those calls were right. */
  agreeN: number; agreeHit: number | null; againstN: number; againstHit: number | null;
  why: string;
}
export interface RefitReport { refit: boolean; n: number; reason: string; hitRate: number | null; moved: RefitMove[]; lines: string[] }

const unit = (w: Weights): Weights => {
  const total = FACTORS.reduce((a, f) => a + w[f], 0);
  const out = {} as Weights;
  for (const f of FACTORS) out[f] = total > 0 ? w[f] / total : 1 / FACTORS.length;
  return out;
};

/**
 * Constrained logistic regression of "the call was right" on the stored factor scores.
 * x_f = factor score / 2, signed toward the call's direction (0 when the factor had no weight in that call);
 * P(right) = sigmoid(b + 4 x sum(w_f x_f)). Plain gradient descent on mean log-loss + sum((w - w0)^2)
 * (L2 toward the current weights), projected to w >= 0 each step. The result is renormalised to sum to 1
 * and each weight is held within 0.05 of where it started (the current weights, normalised to sum to 1).
 * Under 50 resolved directional calls the weights come back unchanged with the reason.
 */
export function refitWeights(calls: BiasCall[], weights: Weights): { weights: Weights; report: RefitReport } {
  const used = calls.filter(isResolvedDirectional);
  const n = used.length;
  if (n < REFIT_MIN_CALLS) {
    const reason = `${n} resolved directional calls; the re-fit needs ${REFIT_MIN_CALLS}. Weights unchanged.`;
    return { weights, report: { refit: false, n, reason, hitRate: n ? round(used.filter((c) => c.outcome!.correct).length / n, 3) : null, moved: [], lines: [reason] } };
  }
  const w0 = unit(normaliseWeights(weights));
  const rows = used.map((c) => {
    const dir = c.call.endsWith('long') ? 1 : -1;
    const x = {} as Weights;
    for (const f of FACTORS) x[f] = 0;
    for (const s of c.factors) x[s.factor] = s.weight > 0 ? (dir * s.score) / 2 : 0;
    return { x, y: c.outcome!.correct ? 1 : 0 };
  });
  const w = { ...w0 };
  let b = 0;
  for (let it = 0; it < ITERATIONS; it++) {
    const g = {} as Weights;
    for (const f of FACTORS) g[f] = 0;
    let gb = 0;
    for (const r of rows) {
      const z = b + GAIN * FACTORS.reduce((a, f) => a + w[f] * r.x[f], 0);
      const err = 1 / (1 + Math.exp(-z)) - r.y;
      gb += err;
      for (const f of FACTORS) g[f] += err * GAIN * r.x[f];
    }
    b -= RATE * (gb / n);
    for (const f of FACTORS) w[f] = Math.max(0, w[f] - RATE * (g[f] / n + 2 * L2 * (w[f] - w0[f])));
  }
  // Alternate the two constraints (step bound, sum to 1) until both hold.
  let out = unit(w);
  for (let i = 0; i < 200; i++) {
    for (const f of FACTORS) out[f] = Math.min(w0[f] + REFIT_MAX_STEP, Math.max(Math.max(0, w0[f] - REFIT_MAX_STEP), out[f]));
    out = unit(out);
  }
  for (const f of FACTORS) out[f] = round(out[f], 4);

  const hit = (xs: typeof rows): number | null => (xs.length ? round(xs.filter((r) => r.y === 1).length / xs.length, 3) : null);
  const pc = (x: number | null): string => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  const moved: RefitMove[] = FACTORS.map((f) => {
    const agree = rows.filter((r) => r.x[f] > 0), against = rows.filter((r) => r.x[f] < 0);
    const delta = round(out[f] - w0[f], 4);
    const aH = hit(agree), gH = hit(against);
    const why = agree.length + against.length === 0
      ? 'never had a score in these calls; moved only by renormalising'
      : `calls it sided with hit ${pc(aH)} (${agree.length}), calls it opposed hit ${pc(gH)} (${against.length})`;
    return { factor: f, from: round(w0[f], 4), to: out[f], delta, agreeN: agree.length, agreeHit: aH, againstN: against.length, againstHit: gH, why };
  }).filter((m) => Math.abs(m.delta) >= 0.001).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta));
  const hitRate = hit(rows);
  const reason = `Re-fit on ${n} resolved directional calls, ${pc(hitRate)} right.`;
  const lines = [reason, ...moved.map((m) => `${m.factor} ${m.from.toFixed(3)} to ${m.to.toFixed(3)} (${m.delta >= 0 ? '+' : '−'}${Math.abs(m.delta).toFixed(3)}): ${m.why}.`)];
  if (moved.length === 0) lines.push('No weight moved by 0.001 or more.');
  return { weights: out, report: { refit: true, n, reason, hitRate, moved, lines } };
}
