/**
 * Position arithmetic shared by the ticket reducers. Everything is replayed from `ticket.fills`
 * (average-cost basis), so no derived state is stored on the ticket and any ticket can be re-scored.
 */
import { INSTRUMENTS, fmtNum, hhmm, instrument, ms, pnlUsd, type Candle, type Direction, type Fill, type OverrideKind, type Ticket } from '@desk/contracts';

export const EPS = 1e-9;
export const sign = (d: Direction): 1 | -1 => (d === 'long' ? 1 : -1);
/** 27338 -> "27,338"; 27338.25 -> "27,338.25"; 262.5 -> "262.5". */
export const px = (x: number): string => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
export const etClock = (t: number | string): string => `${hhmm(t)} ET`;
export const isIncrease = (f: Fill): boolean => f.kind === 'entry' || f.kind === 'add';
/** The price series an instrument tracks (NQ-PERP and MNQ are NQ). Unknown symbols stand for themselves. */
export const underlying = (symbol: string): string => INSTRUMENTS[symbol]?.priceSymbol ?? symbol;
/** Favorable distance from `from` to `to` in the trade's direction (positive = in the money). */
export const favorable = (d: Direction, from: number, to: number): number => (to - from) * sign(d);
/** True when `price` is at or beyond `level` in the given direction of travel (+1 up, -1 down). */
export const reached = (price: number, level: number, travel: 1 | -1, strict = false): boolean =>
  strict ? (price - level) * travel > EPS : (price - level) * travel >= -EPS;

export interface PositionSnapshot {
  enteredUnits: number; openUnits: number; exitedUnits: number;
  /** Average cost of the open (or last open) position; null before the first entry. */
  avgEntry: number | null;
  /** Unit-weighted average price of every reducing fill. */
  avgExit: number | null;
  realizedUsd: number;
  firstEntryTs: number | null; lastExitTs: number | null; lastExitPrice: number | null;
}

export const sortedFills = (t: Ticket): Fill[] => t.fills.map((f, i) => ({ f, i })).sort((a, b) => ms(a.f.ts) - ms(b.f.ts) || a.i - b.i).map((x) => x.f);

/** Replays fills with ts <= untilMs. Futures average by contracts, notional instruments by quantity (units / price). */
export function replayFills(t: Ticket, untilMs = Infinity): PositionSnapshot {
  const futures = instrument(t.instrument).pointValue > 0;
  const s: PositionSnapshot = { enteredUnits: 0, openUnits: 0, exitedUnits: 0, avgEntry: null, avgExit: null, realizedUsd: 0, firstEntryTs: null, lastExitTs: null, lastExitPrice: null };
  let exitNotional = 0;
  for (const f of sortedFills(t)) {
    const ts = ms(f.ts);
    if (ts > untilMs) break;
    if (isIncrease(f)) {
      const prev = s.openUnits > EPS && s.avgEntry !== null ? s.avgEntry : null;
      s.avgEntry = prev === null ? f.price
        : futures ? (prev * s.openUnits + f.price * f.units) / (s.openUnits + f.units)
        : (s.openUnits + f.units) / (s.openUnits / prev + f.units / f.price);
      s.openUnits += f.units; s.enteredUnits += f.units;
      s.firstEntryTs ??= ts;
    } else if (s.avgEntry !== null && s.openUnits > EPS) {
      const u = Math.min(f.units, s.openUnits);
      s.realizedUsd += pnlUsd(t.instrument, u, s.avgEntry, f.price, t.direction);
      s.openUnits -= u; s.exitedUnits += u; exitNotional += u * f.price;
      s.lastExitTs = ts; s.lastExitPrice = f.price;
    }
  }
  if (s.openUnits < EPS) s.openUnits = 0;
  s.avgExit = s.exitedUnits > EPS ? exitNotional / s.exitedUnits : null;
  return s;
}

/** Tolerance for matching a scale-out fill to a target: two ticks. */
export const targetTolerance = (symbol: string): number => 2 * instrument(symbol).tickSize;

export interface TargetProgress {
  /** For T1..T3: the fill (by time order) that scaled out at it, or null. */
  filledAt: [Fill | null, Fill | null, Fill | null];
  /** Scale-out fills taken before any open target had been reached. */
  earlyScaleOuts: Fill[];
}
/** Each scale-out fill is matched to the first unfilled target its price had reached. */
export function targetProgress(t: Ticket): TargetProgress {
  const out: TargetProgress = { filledAt: [null, null, null], earlyScaleOuts: [] };
  const tol = targetTolerance(t.instrument);
  for (const f of sortedFills(t)) {
    if (f.kind !== 'scale_out') continue;
    const i = t.targets.findIndex((tg, k) => out.filledAt[k] === null && favorable(t.direction, tg.price, f.price) >= -tol);
    if (i >= 0) out.filledAt[i] = f; else out.earlyScaleOuts.push(f);
  }
  return out;
}

export interface OverrideCandidate { kind: OverrideKind; ts: string; reason: string; targetIndex?: 1 | 2 | 3; price?: number }

/** Deviations provable from fills alone: size beyond the ticket, and an add while under water. Each at most once. */
export function inferFillOverrides(t: Ticket): OverrideCandidate[] {
  const out: OverrideCandidate[] = [];
  const fills = sortedFills(t);
  let entered = 0;
  for (const f of fills) {
    if (!isIncrease(f)) continue;
    const before = replayFills({ ...t, fills: fills.slice(0, fills.indexOf(f)) });
    entered += f.units;
    if (entered > t.size.units * (1 + 1e-6) + EPS && !out.some((o) => o.kind === 'size_up')) {
      out.push({ kind: 'size_up', ts: f.ts, price: f.price, reason: `Size ${fmtNum(entered, Number.isInteger(entered) ? 0 : 2)} against a ticket of ${fmtNum(t.size.units, Number.isInteger(t.size.units) ? 0 : 2)}.` });
    }
    if (f.kind === 'add' && before.openUnits > EPS && before.avgEntry !== null && favorable(t.direction, before.avgEntry, f.price) < -EPS && !out.some((o) => o.kind === 'added_to_loser')) {
      const under = -favorable(t.direction, before.avgEntry, f.price);
      out.push({ kind: 'added_to_loser', ts: f.ts, price: f.price, reason: `Added at ${px(f.price)} with the position ${px(Math.round(under * 100) / 100)} pts under water from ${px(Math.round(before.avgEntry * 100) / 100)}.` });
    }
  }
  return out;
}

/** Candles at or after the first entry fill, ascending. The candle the entry printed inside is excluded: part of its range predates the fill. */
export function candlesSince(candles: Candle[], fromMs: number, toMs = Infinity): Candle[] {
  return candles.filter((c) => c.t >= fromMs && c.t < toMs).sort((a, b) => a.t - b.t);
}
