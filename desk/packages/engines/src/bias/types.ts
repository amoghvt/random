/**
 * Bias engine types (spec section 6). The engine is two pure stages:
 *   extractInputs(snapshot) -> BiasInputs   (compact numbers, serializable)
 *   decideFromInputs(inputs, prev, opts) -> BiasCall
 * The call stores its BiasInputs, weights, calibration map and the reference to the previous call,
 * so `replayCall(call)` reproduces it exactly.
 */
import type {
  BiasLabel, CalibrationBucket, Candle, Catalyst, Datum, FactorName, Headline, Horizon, StructureEvent, Timeframe, TradePlan,
} from '@desk/contracts';

export const PEER_SYMBOLS = ['ES', 'SOX', 'VIX', 'US10Y', 'DXY', 'CL', 'GC', 'BTC', 'RSP', 'QQQ', 'XLP', 'XLU'] as const;
export type PeerSymbol = (typeof PEER_SYMBOLS)[number];

export interface CandleSet { m15: Candle[]; h1: Candle[]; d1: Candle[] }
export type Weights = Record<FactorName, number>;

/** Everything the engine reads for one instrument at one instant. Nothing in it may be stamped after `now`. */
export interface BiasSnapshot {
  /** Epoch ms. */
  now: number;
  instrument: string;
  horizon: Horizon;
  price: number;
  /** Candles of the instrument's price series, ascending; the last bar may be in progress. */
  candles: CandleSet;
  /** Peer series as available; a missing peer is normal on free data. */
  peers: Partial<Record<PeerSymbol, CandleSet>>;
  /** Latest value per datum key (rates, fed odds, vol, options, flows, positioning). */
  data: Record<string, Datum>;
  /** Ascending history per datum key, for changes and z-scores. Optional: candles are the fallback for rates and VIX. */
  dataHistory?: Record<string, Datum[]>;
  /** Upcoming and recently resolved. */
  catalysts: Catalyst[];
  /** Recent watcher events. */
  structure: StructureEvent[];
  /** Last 24h. */
  headlines: Headline[];
  /** Profile weights. */
  weights: Weights;
}

/* ───────── compact factor inputs ───────── */

export interface YieldIn {
  level: number; asOf: string; source: string; stale: boolean;
  chg1hBp: number | null; chg1dBp: number | null; chg5dBp: number | null; chg20dBp: number | null;
}
export interface RatesIn {
  y10: YieldIn | null; y2: YieldIn | null;
  /** Instrument change over the same lookbacks, percent. */
  idx: { chg1hPct: number | null; chg1dPct: number | null; chg5dPct: number | null; chg20dPct: number | null };
}
export interface FedIn {
  asOf: string | null; stale: boolean; source: string | null;
  hike: number | null; cut: number | null; impliedRate: number | null;
  /** Changes in probability (0-1 units) and implied rate (bp). */
  dHike1d: number | null; dCut1d: number | null; dHike5d: number | null; dCut5d: number | null;
  dImplied1dBp: number | null; dImplied5dBp: number | null;
}
export interface CatalystIn {
  id: string; name: string; code: string; tier: 1 | 2 | 3; status: 'upcoming' | 'live' | 'resolved';
  scheduledAt: string; asOf: string;
  actual: number | null; consensus: number | null; unit: string | null;
  impliedMovePct: number | null;
  resolvedAt: string | null;
  /** The matched branch of a resolved catalyst. */
  branch: {
    id: string; label: string; probability: number;
    y2Bp: number; y10Bp: number; m15Pct: number; h1Pct: number; closePct: number;
    trade: TradePlan | null; noTradeReason: string | null;
  } | null;
  reactionM15Pct: number | null;
  /** Upcoming with a matrix: probability-weighted close read (percent) and directional skew (-1..1). */
  expected: { closePct: number; skew: number } | null;
}
export interface FirstMoveIn {
  catalystId: string; name: string; resolvedAt: string; minutesSince: number;
  expectedY10Bp: number; expectedDir: -1 | 0 | 1;
  y10SinceBp: number | null; priceSincePct: number | null;
}
export interface RegimeIn {
  asOf: string | null; stale: boolean;
  d1: {
    close: number; ema50: number | null; ema200: number | null; ema200SlopePct: number | null;
    ret5Pct: number | null; ret20Pct: number | null; high: number; highBars: number; depthPct: number; bars: number;
  } | null;
  m15: { close: number; ema50: number | null; ema200: number | null; ema200SlopePct: number | null; bars: number } | null;
}
export interface BreadthIn {
  asOf: string | null; stale: boolean; lookbackBars: number;
  sox: number | null; index: number | null; indexSymbol: string; rsp: number | null; xlp: number | null; xlu: number | null;
  adLine: { value: number; chg: number | null } | null;
  staleSymbols: string[];
}
export interface PositioningIn {
  asOf: string | null; stale: boolean;
  vix: { level: number; pctile1y: number | null; asOf: string; source: string } | null;
  term: { value: number; asOf: string } | null;
  skew: { value: number; z: number | null; asOf: string } | null;
  putCall: { value: number; z: number | null; asOf: string } | null;
  cftc: { value: number; z: number | null; asOf: string } | null;
  impliedMovePct: number | null;
  /** A relevant catalyst resolved in the last 24h: crowding is faded at full weight. */
  postCatalyst: boolean;
  staleKeys: string[];
}
export interface NewsItemIn { id: string; ts: string; impact: number; direction: -1 | 0 | 1; title: string }
export interface NewsIn { asOf: string | null; items: NewsItemIn[] }
export interface StructureIn {
  id: string; detector: string; kind: string; tf: Timeframe; ts: string;
  level: number | null; levelHi: number | null; bias: -1 | 0 | 1; confidence: number; confirmedSetup: boolean; text: string;
}
export interface CalendarTag { tag: string; n: number; meanPct: number; t: number }
export interface CalendarIn {
  /** The session the call trades: today if it is a trading day, otherwise the next one. */
  sessionDay: string; weekday: number;
  opexWeek: boolean; opexDay: boolean; monthEnd: boolean; holidayWeek: boolean; thanksgivingWeek: boolean; preLongWeekend: boolean;
  /** Measured on the instrument's own daily closes in the snapshot. */
  tags: CalendarTag[];
  historyBars: number;
}
export interface CrossIn {
  asOf: string | null; stale: boolean; lookbackBars: number;
  dxy: number | null; cl: number | null; gc: number | null; btc: number | null;
  y10ChgBp: number | null; idxPct: number | null;
  staleSymbols: string[];
}
export interface LevelsIn {
  price: number; lastClose15: number | null; tick: number;
  atrM15: number | null; atrH1: number | null; atrD1: number | null;
}

export interface BiasInputs {
  v: 1;
  now: string; instrument: string; priceSymbol: string; horizon: Horizon;
  rates: RatesIn; fed: FedIn; catalysts: CatalystIn[]; firstMove: FirstMoveIn | null;
  regime: RegimeIn; breadth: BreadthIn; positioning: PositioningIn; news: NewsIn;
  structure: StructureIn[]; calendar: CalendarIn; cross: CrossIn; levels: LevelsIn;
}

/* ───────── scoring ───────── */

export interface RawFactor {
  factor: FactorName; score: number; evidence: string; asOf: string;
  stale: boolean;
  /** No usable input: scores 0 and its weight is redistributed. */
  missing: boolean;
}

export interface CalibrationMapBucket { lo: number; hi: number; n: number; shift: number }
/** Per-bucket additive shift toward the realized hit rate; buckets under 20 resolved calls have shift 0. */
export interface CalibrationMap { buckets: CalibrationMapBucket[] }
export interface CalibrationResult { buckets: CalibrationBucket[]; n: number }

/** What the same-evidence rule needs to know about the previous call. */
export interface PrevRef {
  id: string; call: BiasLabel; createdAt: string; expiresAt: string;
  killLevel: number | null; killSide: 'above' | 'below' | null;
  timeStopAt: string | null;
  firstMoveUntrusted: boolean; firstMoveEndsAt: string | null;
  /** Ids already in evidence when the previous call was made; null when the previous call carried no inputs. */
  seen: { prints: string[]; headlines: string[]; structure: string[] } | null;
}

export interface DecideOpts {
  /** Profile weights; defaults to the snapshot's, then DEFAULT_WEIGHTS. */
  weights?: Weights;
  calibration?: CalibrationMap | null;
  /** Epoch ms; defaults to snapshot.now. */
  now?: number;
}

/** Stored under BiasCall.inputs. */
export interface StoredInputs {
  features: BiasInputs; weights: Weights; calibration: CalibrationMap | null; prev: PrevRef | null;
  /** Diagnostics, not read on replay. */
  scoring: { weighted: number; multiplier: number; score: number; rawProbability: number; agreeing: number; gate: string };
}
