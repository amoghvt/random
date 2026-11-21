/**
 * Flush and confirmation day, from daily candles only.
 *
 * Flush: a completed daily session that closes down `flushDownPct` (default 2%) or more versus the prior close.
 * Confirmation day: the first later completed session that closes up on the day (close above the prior close)
 *   AND closes above the flush day's midpoint ((high + low) / 2). One green close under the midpoint is a bounce.
 * Session close is taken as 16:00 ET on the candle's date (the cash close); "hours since the flush" counts from there.
 * A session is complete once that time has passed, so the in-progress daily candle never confirms anything.
 */
import { ET, HOUR, dayKey, fromZoned, type Candle } from '@desk/contracts';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';

export interface FlushState {
  instrument: string;
  /** 'YYYY-MM-DD' of the flush session. */
  flushDate: string;
  /** Epoch ms of the flush session's 16:00 ET close. */
  closeAt: number;
  dropPct: number;
  low: number; high: number; midpoint: number; close: number;
  confirmation: { date: string; close: number } | null;
  /** First later session, before any confirmation, that traded under the flush-day low. */
  lowUndercut: { date: string; low: number } | null;
}

/** Yahoo stamps daily bars at local midnight (futures) or 00:00 UTC (crypto); +12h lands on the right date either way. */
export const sessionDate = (c: Candle): string => dayKey(c.t + 12 * HOUR, ET);
export function sessionCloseAt(c: Candle): number {
  const [y, m, d] = sessionDate(c).split('-').map(Number) as [number, number, number];
  return fromZoned(y, m, d, 16, 0, ET);
}

/** All flushes in the last `flushLookbackSessions` completed sessions, ascending, each with its confirmation state as of `now`. */
export function findFlushes(d1: Candle[], now: number, thresholds: Pick<Thresholds, 'flushDownPct' | 'flushLookbackSessions'> = DEFAULT_THRESHOLDS): FlushState[] {
  const done = d1.filter((c) => sessionCloseAt(c) <= now).sort((a, b) => a.t - b.t);
  const out: FlushState[] = [];
  for (let i = Math.max(1, done.length - thresholds.flushLookbackSessions); i < done.length; i++) {
    const c = done[i]!, prev = done[i - 1]!;
    const dropPct = (c.c / prev.c - 1) * 100;
    if (dropPct > -thresholds.flushDownPct) continue;
    const midpoint = (c.h + c.l) / 2;
    let confirmation: FlushState['confirmation'] = null;
    let lowUndercut: FlushState['lowUndercut'] = null;
    for (let k = i + 1; k < done.length; k++) {
      const s = done[k]!;
      if (!lowUndercut && s.l < c.l) lowUndercut = { date: sessionDate(s), low: s.l };
      if (s.c > done[k - 1]!.c && s.c > midpoint) { confirmation = { date: sessionDate(s), close: s.c }; break; }
    }
    out.push({ instrument: c.symbol, flushDate: sessionDate(c), closeAt: sessionCloseAt(c), dropPct, low: c.l, high: c.h, midpoint, close: c.c, confirmation, lowUndercut });
  }
  return out;
}

export const hoursSince = (f: FlushState, now: number): number => (now - f.closeAt) / HOUR;
