/** Shared context and event construction for the detectors. */
import { TF_MS, dayKey, fmtNum, hashId, hhmm, iso, type Candle, type DetectorName, type StructureEvent, type Timeframe } from '@desk/contracts';
import { atr, buildLegs, ema, fractals, type Leg, type Pivot } from './candles';

/**
 * Detector defaults. One set for every instrument, timeframe and day; nothing here is fitted to a session.
 * Sizes are in ATR(14) of the same timeframe so they scale with the instrument and the tape.
 */
export const PARAMS = {
  /** Williams fractal: 2 candles each side. */
  fractalN: 2,
  atrPeriod: 14,
  /** A leg, run or spike of at least this many ATRs is an impulse. Used by every detector that needs one. */
  impulseAtr: 3,
  /** Equal highs/lows within 0.1% are one liquidity pool (spec). */
  equalPct: 0.001,
  /** Sweep: close back inside within this many candles, counting the sweep candle. */
  reclaimWithin: 3,
  /** Confirmed setup: MSS within this many candles of the reclaim. */
  setupWithin: 20,
  /** Three-candle gaps smaller than this fraction of ATR are noise. */
  fvgMinAtr: 0.25,
  /** Order block: how far back to look for the last opposing candle. */
  obLookback: 5,
  /** First touch: price must have stayed off the EMA for this many candles first. */
  emaAway: 20,
  /** Rejection or hold: this many consecutive closes on one side. */
  emaHold: 3,
  /** A reclaim must start within this many candles of the touch. */
  emaReclaimWithin: 5,
  emaSlopeLookback: 10,
  /** Retrace under this fraction of the prior leg is a stalled bounce (spec: 50%). */
  retraceMax: 0.5,
  /** A leg stops being "the prior leg" after this many candles. */
  retraceWatch: 48,
  /** A spike is at most this many candles from base to extreme. */
  spikeMaxCandles: 3,
  /** Rejection must come within this many candles after the extreme. */
  rejectWithin: 5,
  /** Fraction of the spike given back on a close that counts as rejection. */
  rejectGiveback: 0.5,
  pennantWindow: 12,
  /** Last-hour range at or under this fraction of the session range is compression. */
  lastHourCompression: 1 / 3,
  divergenceWindow: 16,
  /** Candles per timeframe scanned for events on each run; indicators use everything passed in. */
  scan: 200,
} as const;

export interface TfContext {
  instrument: string; tf: Timeframe; tfMs: number;
  /** Closed candles, ascending. */
  c: Candle[]; n: number;
  atr: Array<number | null>;
  ema: Record<20 | 50 | 200, Array<number | null>>;
  pivots: Pivot[]; legs: Leg[];
  pivotAt: (type: Pivot['type'], i: number) => Pivot | undefined;
  /** Events are emitted for confirming candles at or after this index. */
  scanFrom: number;
}

export function buildContext(instrument: string, tf: Timeframe, closed: Candle[], scan: number = PARAMS.scan): TfContext {
  const closes = closed.map((k) => k.c);
  const atrs = atr(closed, PARAMS.atrPeriod);
  const pivots = fractals(closed, PARAMS.fractalN);
  const index = new Map<string, Pivot>();
  for (const p of pivots) index.set(`${p.type}${p.i}`, p);
  return {
    instrument, tf, tfMs: TF_MS[tf], c: closed, n: closed.length, atr: atrs,
    ema: { 20: ema(closes, 20), 50: ema(closes, 50), 200: ema(closes, 200) },
    pivots, legs: buildLegs(pivots, atrs),
    pivotAt: (type, i) => index.get(`${type}${i}`),
    scanFrom: Math.max(0, closed.length - scan),
  };
}

/** 27062.4 -> "27,062"; 4.943 -> "4.94". */
export const px = (x: number): string => fmtNum(x, Math.abs(x) >= 1000 ? 0 : 2);
export const pct = (x: number): string => `${Math.round(x * 100)}%`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthDay = (t: number): string => {
  const [, m, d] = dayKey(t).split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}`;
};
/** ET label for a candle time: "11:30", "Nov 16 11:30" when it is another day than `ref`, "Nov 16" on daily. */
export function when(tf: Timeframe, t: number, ref: number): string {
  if (tf === '1d') return monthDay(t);
  return dayKey(t) === dayKey(ref) ? hhmm(t) : `${monthDay(t)} ${hhmm(t)}`;
}

export interface EventFields {
  kind: string; level: number | null; levelHi?: number | null; bias: -1 | 0 | 1; confidence: number;
  /** Full numbers-first sentence. */
  text: string;
  /** Clause used inside a 280-character update. */
  short: string;
  /** Anchor candle times and anything else that makes this observation unique. */
  anchor: Array<string | number>;
  /** Observation key and severity for update dedupe; default is one observation per event at its confidence. */
  obsKey?: string; severity?: number;
  data?: Record<string, unknown>;
  confirmedSetup?: boolean;
}

/** Build an event confirmed by the close of candle `idx`. The id is a hash of content anchors only, so re-runs are idempotent. */
export function mkEvent(ctx: TfContext, detector: DetectorName, idx: number, f: EventFields): StructureEvent {
  const k = ctx.c[idx]!;
  return {
    id: hashId('se', ctx.instrument, ctx.tf, detector, f.kind, ...f.anchor),
    detector, kind: f.kind, instrument: ctx.instrument, tf: ctx.tf,
    ts: iso(k.t + ctx.tfMs),
    level: f.level, levelHi: f.levelHi ?? null, bias: f.bias,
    confidence: Math.round(Math.min(1, Math.max(0, f.confidence)) * 100) / 100,
    text: f.text,
    data: { ...f.data, short: f.short, candleT: k.t, obsKey: f.obsKey ?? `${detector}|${f.kind}|${ctx.tf}|${f.anchor.join(',')}`, severity: f.severity ?? f.confidence },
    confirmedSetup: f.confirmedSetup ?? false,
  };
}
