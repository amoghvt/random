/** Outcome scoring and the calibration table. */
import { TF_MS, mean, round, type BiasCall, type CalibrationBucket, type Candle } from '@desk/contracts';
import { CALIBRATION_EDGES, bucketIndex } from './scoring';
import type { CalibrationResult } from './types';

export type Outcome = NonNullable<BiasCall['outcome']>;
/** A directional call must move this far its way by expiry to count as right when no level decided it. */
export const OUTCOME_DEAD_BAND_PCT = 0.05;

/**
 * Score a call at its expiry from the instrument's candles (any timeframe, ascending; finer is better).
 * Returns null until the candles reach the expiry.
 *  - movePct: move from referencePrice to the last close before expiry, signed in the call's direction
 *    (raw percent for No edge).
 *  - correct, with a trade: true when T1 traded before the invalidation, false when the invalidation traded
 *    first (a bar that touches both counts as the invalidation). Neither touched, or no trade: true only when
 *    movePct is above +0.05%.
 *  - No edge: correct is null and the call stays out of calibration.
 */
export function scoreOutcome(call: BiasCall, candles: Candle[]): Outcome | null {
  const from = Date.parse(call.createdAt), to = Date.parse(call.expiresAt);
  if (!candles.some((c) => c.t + TF_MS[c.tf] >= to)) return null;
  const bars = candles.filter((c) => c.t >= from && c.t < to);
  const last = bars.at(-1);
  if (!last || !(call.referencePrice > 0)) return null;
  const raw = (last.c / call.referencePrice - 1) * 100;
  if (call.call === 'no_edge') return { resolvedAt: call.expiresAt, movePct: round(raw, 3), correct: null };
  const dir = call.call.endsWith('long') ? 1 : -1;
  const movePct = round(raw * dir, 3);
  if (call.trade) {
    const inv = call.trade.invalidation.price, t1 = call.trade.targets[0].price;
    for (const b of bars) {
      if (dir === 1 ? b.l <= inv : b.h >= inv) return { resolvedAt: call.expiresAt, movePct, correct: false };
      if (dir === 1 ? b.h >= t1 : b.l <= t1) return { resolvedAt: call.expiresAt, movePct, correct: true };
    }
  }
  return { resolvedAt: call.expiresAt, movePct, correct: movePct > OUTCOME_DEAD_BAND_PCT };
}

export const isResolvedDirectional = (c: BiasCall): boolean => c.call !== 'no_edge' && typeof c.outcome?.correct === 'boolean';

/** Predicted probability vs realized hit rate in 0.05 buckets from 0.50 to 0.85 (the last bucket includes 0.85). */
export function calibration(calls: BiasCall[]): CalibrationResult {
  const groups: BiasCall[][] = CALIBRATION_EDGES.slice(0, -1).map(() => []);
  for (const c of calls) if (isResolvedDirectional(c)) groups[bucketIndex(c.probability)]!.push(c);
  const buckets: CalibrationBucket[] = groups.map((g, i) => ({
    lo: CALIBRATION_EDGES[i]!, hi: CALIBRATION_EDGES[i + 1]!, n: g.length,
    predicted: round(g.length ? mean(g.map((c) => c.probability)) : (CALIBRATION_EDGES[i]! + CALIBRATION_EDGES[i + 1]!) / 2, 4),
    realized: g.length ? round(g.filter((c) => c.outcome!.correct).length / g.length, 4) : null,
  }));
  return { buckets, n: buckets.reduce((a, b) => a + b.n, 0) };
}
