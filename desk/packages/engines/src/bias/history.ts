/** Build a snapshot as of a past instant from stored history, using only what was stamped before `now`. */
import {
  DAY, DEFAULT_WEIGHTS, INSTRUMENTS, TF_MS, dayKey, iso,
  type Candle, type Catalyst, type Datum, type Headline, type Horizon, type StructureEvent, type Timeframe,
} from '@desk/contracts';
import { PEER_SYMBOLS, type BiasSnapshot, type CandleSet, type Weights } from './types';

export const candleKey = (symbol: string, tf: Timeframe): string => `${symbol}.${tf}`;
const ORDER: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];
const KEEP: Record<'15m' | '1h' | '1d', number> = { '15m': 400, '1h': 300, '1d': 800 };

export interface HistoryArgs {
  now: number; instrument: string; horizon: Horizon;
  /** Ascending candles keyed by candleKey(symbol, tf); 15m, 1h and 1d are read, 1m and 5m sharpen the in-progress bars. */
  candlesByKey: Record<string, Candle[]>;
  /** Ascending history per datum key. */
  dataHistory: Record<string, Datum[]>;
  catalysts: Catalyst[]; structure: StructureEvent[]; headlines: Headline[];
  weights?: Weights;
}

/** Bars that had fully closed by `now`. */
function closed(bars: Candle[] | undefined, now: number): Candle[] {
  if (!bars) return [];
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid]!.t + TF_MS[bars[mid]!.tf] <= now) lo = mid + 1; else hi = mid; }
  // Irregular stamps (a provider's live last bar) can break the ordering assumption; filter what the search kept.
  return bars.slice(0, lo).filter((c) => c.t + TF_MS[c.tf] <= now);
}

/**
 * Closed bars of one timeframe plus the bar in progress, rebuilt from the finest closed bars since the last
 * closed one. The recorded bar that spans `now` is never read: its high, low and close are the future.
 */
function series(by: Record<string, Candle[]>, symbol: string, tf: '15m' | '1h' | '1d', now: number): Candle[] {
  const done = closed(by[candleKey(symbol, tf)], now);
  const lastEnd = done.length ? done.at(-1)!.t + TF_MS[tf] : -Infinity;
  const start = Math.max(lastEnd, now - TF_MS[tf]);
  let partial: Candle | null = null;
  for (const finer of ORDER.slice(0, ORDER.indexOf(tf))) {
    const parts = closed(by[candleKey(symbol, finer)], now).filter((c) => c.t >= start);
    if (parts.length === 0) continue;
    partial = {
      symbol, tf, t: parts[0]!.t, o: parts[0]!.o, h: Math.max(...parts.map((c) => c.h)), l: Math.min(...parts.map((c) => c.l)),
      c: parts.at(-1)!.c, v: parts.reduce((a, c) => a + c.v, 0), source: `partial:${finer}`,
    };
    break;
  }
  const out = done.slice(-KEEP[tf]);
  return partial ? [...out, partial] : out;
}
const setFor = (by: Record<string, Candle[]>, symbol: string, now: number): CandleSet =>
  ({ m15: series(by, symbol, '15m', now), h1: series(by, symbol, '1h', now), d1: series(by, symbol, '1d', now) });

/** A catalyst as it stood at `now`: no resolution, reaction, matrix or odds from later. */
function rewind(c: Catalyst, now: number): Catalyst | null {
  if (c.adhoc && Date.parse(c.scheduledAt) > now) return null;
  const resolvedAt = c.resolution ? Date.parse(c.resolution.resolvedAt) : null;
  const resolved = resolvedAt != null && resolvedAt <= now;
  const m5 = resolved && now >= resolvedAt + 5 * 60_000, m15 = resolved && now >= resolvedAt + 15 * 60_000;
  const today = dayKey(now);
  return {
    ...c,
    status: resolved ? 'resolved' : Date.parse(c.scheduledAt) <= now ? 'live' : 'upcoming',
    resolution: resolved ? c.resolution : null,
    reaction: resolved && c.reaction ? { m5Pct: m5 ? c.reaction.m5Pct : null, m15Pct: m15 ? c.reaction.m15Pct : null, verdict: m15 ? c.reaction.verdict : null, text: m15 ? c.reaction.text : '' } : null,
    matrix: c.matrix && Date.parse(c.matrix.generatedAt) <= now ? c.matrix : null,
    history: c.history.filter((h) => h.date < today),
    predictionOdds: c.predictionOdds.filter((p) => Date.parse(p.asOf) <= now),
    asOf: Date.parse(c.asOf) <= now ? c.asOf : iso(now),
  };
}

/** Everything in the last 3 days, then the last reading of each UTC day back 400 days. */
function thin(h: Datum[], now: number): Datum[] {
  const out: Datum[] = [];
  let day = '';
  for (let i = h.length - 1; i >= 0; i--) {
    const d = h[i]!, t = Date.parse(d.asOf);
    if (t > now) continue;
    if (t < now - 400 * DAY) break;
    if (t >= now - 3 * DAY) { out.push(d); continue; }
    const k = d.asOf.slice(0, 10);
    if (k !== day) { out.push(d); day = k; }
  }
  return out.reverse();
}

export function snapshotFromHistory(args: HistoryArgs): BiasSnapshot {
  const { now, instrument, horizon, candlesByKey: by } = args;
  const priceSymbol = by[candleKey(instrument, '1d')] || by[candleKey(instrument, '15m')] || by[candleKey(instrument, '1h')] ? instrument : INSTRUMENTS[instrument]?.priceSymbol ?? instrument;
  let latest: Candle | null = null;
  for (const tf of ORDER) {
    const c = closed(by[candleKey(priceSymbol, tf)], now).at(-1);
    if (c && (!latest || c.t + TF_MS[c.tf] > latest.t + TF_MS[latest.tf])) latest = c;
  }
  if (!latest) throw new Error(`No ${priceSymbol} candles closed before ${iso(now)}`);
  const peers: BiasSnapshot['peers'] = {};
  for (const p of PEER_SYMBOLS) {
    const set = setFor(by, p, now);
    if (set.m15.length || set.h1.length || set.d1.length) peers[p] = set;
  }
  const data: Record<string, Datum> = {}, dataHistory: Record<string, Datum[]> = {};
  for (const [key, h] of Object.entries(args.dataHistory)) {
    const t = thin(h, now);
    if (t.length === 0) continue;
    dataHistory[key] = t;
    data[key] = t.at(-1)!;
  }
  return {
    now, instrument, horizon, price: latest.c,
    candles: setFor(by, priceSymbol, now), peers, data, dataHistory,
    catalysts: args.catalysts.map((c) => rewind(c, now)).filter((c): c is Catalyst => c !== null),
    structure: args.structure.filter((e) => { const t = Date.parse(e.ts); return t <= now && t > now - 5 * DAY; }),
    headlines: args.headlines.filter((h) => { const t = Date.parse(h.ts); return t <= now && t > now - DAY; }),
    weights: args.weights ?? DEFAULT_WEIGHTS,
  };
}
