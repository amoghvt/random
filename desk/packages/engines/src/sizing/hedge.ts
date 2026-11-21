/** Cross-account hedging detector (spec section 7 and the cross_account_offset guardrail). Pure. */
import { INSTRUMENTS, dayKey, type AccountRules, type Candle, type Direction, type HedgeViolation } from '@desk/contracts';

export const HEDGE_CORRELATION_THRESHOLD = 0.6;
/** Daily returns used for the matrix. */
export const CORRELATION_LOOKBACK_DAYS = 60;
export type CorrelationMatrix = Record<string, Record<string, number>>;
export interface Exposure { accountId: string; instrument: string; direction: Direction }

const underlying = (symbol: string): string => INSTRUMENTS[symbol]?.priceSymbol ?? symbol;

/** Pearson correlation of close-to-close daily returns over the last `lookback` days both symbols traded. Keys are the symbols passed in. */
export function correlationMatrix(dailyCandlesBySymbol: Record<string, Candle[]>, lookback: number = CORRELATION_LOOKBACK_DAYS): CorrelationMatrix {
  const returns: Record<string, Map<string, number>> = {};
  for (const [sym, cs] of Object.entries(dailyCandlesBySymbol)) {
    const m = new Map<string, number>();
    for (let i = 1; i < cs.length; i++) m.set(dayKey(cs[i]!.t), cs[i]!.c / cs[i - 1]!.c - 1);
    returns[sym] = m;
  }
  const syms = Object.keys(returns);
  const out: CorrelationMatrix = {};
  for (const a of syms) {
    out[a] = {};
    for (const b of syms) {
      if (a === b) { out[a]![b] = 1; continue; }
      const days = [...returns[a]!.keys()].filter((d) => returns[b]!.has(d)).sort().slice(-lookback);
      const xs = days.map((d) => returns[a]!.get(d)!), ys = days.map((d) => returns[b]!.get(d)!);
      const n = xs.length;
      if (n < 20) { out[a]![b] = NaN; continue; }
      const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2; }
      out[a]![b] = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
    }
  }
  return out;
}

/** Correlation of two instruments; NQ, NQ-PERP and MNQ are one underlying (1). null when not on file. */
export function correlationOf(a: string, b: string, correlations: CorrelationMatrix): number | null {
  const ua = underlying(a), ub = underlying(b);
  if (ua === ub) return 1;
  const v = correlations[a]?.[b] ?? correlations[b]?.[a] ?? correlations[ua]?.[ub] ?? correlations[ub]?.[ua];
  return v === undefined || Number.isNaN(v) ? null : v;
}

function clauseOf(rules: AccountRules | undefined): string | null {
  const c = rules?.prohibited.find((r) => r.rule === 'cross_account_hedging');
  return c ? c.clause : null;
}

/**
 * Opposite, or strongly correlated-opposite, exposure across two accounts. Pass the order about to be placed as `pending`
 * so the violation fires before the second order; pass null to audit what is already open.
 */
export function detectHedges(
  positions: Exposure[], pending: Exposure | null, rulesById: Record<string, AccountRules>, correlations: CorrelationMatrix,
  threshold: number = HEDGE_CORRELATION_THRESHOLD,
): HedgeViolation[] {
  const out: HedgeViolation[] = [];
  const check = (a: Exposure, b: Exposure, isPending: boolean): void => {
    if (a.accountId === b.accountId) return;
    const corr = correlationOf(a.instrument, b.instrument, correlations);
    if (corr === null || Math.abs(corr) < threshold) return;
    const offsetting = corr > 0 ? a.direction !== b.direction : a.direction === b.direction;
    if (!offsetting) return;
    const ra = rulesById[a.accountId], rb = rulesById[b.accountId];
    const clauses = [...new Set([clauseOf(rb), clauseOf(ra)].filter((c): c is string => c !== null))];
    const clause = clauses.length > 0 ? clauses.join(' | ') : 'Cross-account hedging is prohibited at every firm (trader spec, section 7).';
    const same = underlying(a.instrument) === underlying(b.instrument);
    const relation = same ? 'same underlying' : `correlation ${corr.toFixed(2)} over ${CORRELATION_LOOKBACK_DAYS} days`;
    out.push({
      accountA: a.accountId, accountB: b.accountId, instrumentA: a.instrument, instrumentB: b.instrument, correlation: corr, clause,
      text: `${isPending ? 'Blocked' : 'Rule violation'}: ${b.direction} ${b.instrument} on ${rb?.name ?? b.accountId} offsets ${a.direction} ${a.instrument} on ${ra?.name ?? a.accountId}, ${relation}. ${clauses[0] ?? clause}`,
    });
  };
  if (pending) for (const p of positions) check(p, pending, true);
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) check(positions[i]!, positions[j]!, false);
  return out;
}
