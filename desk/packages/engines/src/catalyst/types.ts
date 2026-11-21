/** Local types for the catalyst engine. Anything not yet in @desk/contracts is defined here and listed in the report. */
import type { AccountRules, Candle, CalendarEvent, Catalyst, Datum, EarningsInfo, EventCode, HistoricalReaction, PredictionMarket, Profile, Timeframe } from '@desk/contracts';

export type FedStance = 'hiking' | 'cutting' | 'hold';
export type Trend = 'uptrend' | 'correction' | 'downtrend';

/** Null means "not on file": the engine then treats odds as not high and says so. */
export interface Regime {
  fedStance: FedStance;
  hikeProb: number | null;
  cutProb: number | null;
  trend: Trend;
  y10: number | null;
  y10RoundLevelDistanceBp: number | null;
}

export type CandlesByTf = Partial<Record<Timeframe, Candle[]>>;

/** The second number published with the keyed metric (headline CPI beside core, unemployment beside payrolls). */
export interface SecondaryMetric { code: EventCode; name: string; consensus: number | null; prior: number | null; actual: number | null; unit?: string }

/** History row plus the fields the contract row lacks. `resolution` is the candle timeframe the row was measured on. */
export type HistoricalReactionEx = HistoricalReaction & {
  time: string; instrument: string;
  m15Pct: number | null;
  resolution: '5m' | '1h' | '1d' | null;
};

/** 10Y reaction to a past release, basis points. */
export interface RateReaction { date: string; surprise: number | null; h1Bp: number | null; closeBp: number | null }

export type CatalystEx = Catalyst & {
  /** Calendar code the consensus/actual are keyed on (CORE_CPI for a CPI catalyst). */
  keyedOn?: EventCode;
  secondary?: SecondaryMetric;
  eventIds?: string[];
  tierReason?: string;
  earnings?: EarningsInfo;
};

export interface TierCtx {
  /** Percent of NDX by ticker. Merged over DEFAULT_INDEX_WEIGHTS. */
  indexWeights?: Record<string, number>;
  watchlist?: string[];
  y10RoundLevelDistanceBp?: number | null;
  /** Tickers whose IPO pricing is a Tier-1 event. */
  majorIpos?: string[];
}

export interface BuildCtx extends TierCtx {
  now: number;
  /** Past calendar events (all codes) for surprise distributions and the history table. Only events before `now` are used. */
  pastEvents?: CalendarEvent[];
  /** Candles of the primary instrument for the history table. */
  candlesByTf?: CandlesByTf;
  predictionMarkets?: PredictionMarket[];
  data?: Datum[];
  vix?: { value: number; asOf: string } | null;
  primaryInstrument?: string;
}

export interface ImpliedCtx { now: number; data?: Datum[]; vix?: { value: number; asOf: string } | null }
export interface ImpliedMove { pct: number | null; source: 'options' | 'historical' | 'vix' | null; n: number | null; asOf: string; text: string }

export interface MatrixCtx {
  now: number;
  referencePrice: number;
  regime: Regime;
  predictionMarkets: PredictionMarket[];
  profile: Profile;
  accounts?: AccountRules[];
  /** Past calendar events for the surprise distribution; only events before `now` with an actual are used. */
  pastEvents?: CalendarEvent[];
  /** Recorded 10Y reactions for the same release; replaces the stated rate prior where a bucket has a sample. */
  rateHistory?: RateReaction[];
  /** Other catalysts, used for the time stop before the next Tier-1 event. */
  upcoming?: Catalyst[];
  /** Per-code override of the in-line band width (metric units). */
  steps?: Partial<Record<EventCode, number>>;
}

export interface AnalogEvent { kind: string; date: string; label: string; symbol?: string }
export interface AnalogStats {
  kind: string; n: number;
  medianDrawdownPct: number | null; medianRecoverySessions: number | null; recovered: number;
  windowSessions: number; text: string;
  events: Array<{ date: string; label: string; drawdownPct: number; recoverySessions: number | null }>;
}
export interface AdhocCtx {
  now: number;
  referencePrice: number;
  instrument?: string;
  profile?: Profile;
  /** Dated real events of the same kind; with none the card says "no analog sample on file". */
  analogEvents?: AnalogEvent[];
  /** Recorded daily candles of the instrument the analogs are measured on. */
  analogCandles?: Candle[];
  vix?: { value: number; asOf: string } | null;
  accounts?: AccountRules[];
}
