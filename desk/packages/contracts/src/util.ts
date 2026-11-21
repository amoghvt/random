import { createHash, randomUUID } from 'node:crypto';

export const uid = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
/** Deterministic id from content; used so replays and re-runs are idempotent. */
export const hashId = (prefix: string, ...parts: Array<string | number>): string =>
  `${prefix}_${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)}`;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const round = (x: number, dp = 2): number => {
  const k = Math.pow(10, dp);
  return Math.round(x * k) / k;
};
/** 27062 -> "27,062"; 4.943 -> "4.94". */
export const fmtNum = (x: number, dp = 0): string => x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const fmtPct = (x: number, dp = 1): string => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(dp)}%`;
export const fmtUsd = (x: number): string => `${x < 0 ? '−' : ''}$${fmtNum(Math.abs(Math.round(x)))}`;
export const fmtSignedUsd = (x: number): string => `${x < 0 ? '−' : '+'}$${fmtNum(Math.abs(Math.round(x)))}`;
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
export const median = (xs: number[]): number => percentile(xs, 0.5);
export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
