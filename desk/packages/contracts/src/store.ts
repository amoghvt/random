/**
 * The store is the only thing engines' callers read from. Feeds write to it; the worker reads
 * state from it, calls the pure engines, and writes their outputs back. Two implementations
 * live in @desk/db: PgStore (Postgres/Timescale) and MemoryStore (tests, replay, offline dev).
 */
import type {
  AccountState, BaseRate, BiasCall, Brief, CalendarEvent, Candle, Catalyst, ChatMessage, Datum, EarningsInfo,
  GuardrailFiring, Headline, JournalNote, LaggedFact, Notification, Position, PredictionMarket, Quote, RuleDiff,
  StructureEvent, Ticket, Timeframe, WatcherUpdate,
} from './schemas';

/** Document collections. Each is a real table: (id, ts, instrument, status, doc jsonb). */
export interface Collections {
  headlines: Headline;
  calendar: CalendarEvent;
  catalysts: Catalyst;
  predictions: PredictionMarket;
  earnings: EarningsInfo;
  lagged_facts: LaggedFact;
  structure_events: StructureEvent;
  watcher_updates: WatcherUpdate;
  base_rates: BaseRate;
  /** Journal: calls. */
  bias_calls: BiasCall;
  account_states: AccountState;
  positions: Position;
  /** Journal: trades. */
  tickets: Ticket;
  /** Journal: events. */
  guardrail_firings: GuardrailFiring;
  notifications: Notification;
  briefs: Brief;
  /** Journal: notes. */
  notes: JournalNote;
  chat: ChatMessage;
  rule_diffs: RuleDiff;
}
export type CollectionName = keyof Collections;

export interface IndexKeys { id: string; ts: string; instrument: string | null; status: string | null }

/** How each collection maps onto the indexed columns. */
export const COLLECTION_KEYS: { [K in CollectionName]: (d: Collections[K]) => IndexKeys } = {
  headlines: (d) => ({ id: d.id, ts: d.ts, instrument: d.symbols[0] ?? null, status: String(d.impact) }),
  calendar: (d) => ({ id: d.id, ts: d.time, instrument: d.symbol ?? null, status: d.code }),
  catalysts: (d) => ({ id: d.id, ts: d.scheduledAt, instrument: d.instruments[0] ?? null, status: d.status }),
  predictions: (d) => ({ id: d.id, ts: d.asOf, instrument: null, status: d.eventCode ?? null }),
  earnings: (d) => ({ id: `${d.symbol}_${d.date.slice(0, 10)}`, ts: d.date, instrument: d.symbol, status: null }),
  lagged_facts: (d) => ({ id: d.id, ts: d.publishedAt, instrument: null, status: d.kind }),
  structure_events: (d) => ({ id: d.id, ts: d.ts, instrument: d.instrument, status: d.detector }),
  watcher_updates: (d) => ({ id: d.id, ts: d.ts, instrument: d.instrument, status: null }),
  base_rates: (d) => ({ id: `${d.pattern}_${d.instrument}_${d.tf}`, ts: d.asOf, instrument: d.instrument, status: d.pattern }),
  bias_calls: (d) => ({ id: d.id, ts: d.createdAt, instrument: d.instrument, status: d.horizon }),
  account_states: (d) => ({ id: d.accountId, ts: d.asOf, instrument: null, status: d.active ? 'active' : 'inactive' }),
  positions: (d) => ({ id: d.id, ts: d.openedAt, instrument: d.instrument, status: d.accountId }),
  tickets: (d) => ({ id: d.id, ts: d.createdAt, instrument: d.instrument, status: d.status }),
  guardrail_firings: (d) => ({ id: d.id, ts: d.ts, instrument: null, status: d.pattern }),
  notifications: (d) => ({ id: d.id, ts: d.ts, instrument: d.instrument, status: d.class }),
  briefs: (d) => ({ id: d.id, ts: d.ts, instrument: null, status: d.kind }),
  notes: (d) => ({ id: d.id, ts: d.ts, instrument: null, status: d.source }),
  chat: (d) => ({ id: d.id, ts: d.ts, instrument: null, status: d.role }),
  rule_diffs: (d) => ({ id: d.id, ts: d.detectedAt, instrument: null, status: d.firm }),
};
export const COLLECTION_NAMES = Object.keys(COLLECTION_KEYS) as CollectionName[];

export interface ListOpts {
  /** Inclusive lower / exclusive upper bound on the collection's ts, ISO. */
  since?: string; until?: string;
  instrument?: string; status?: string | string[];
  limit?: number;
  /** Default 'desc' (newest first). */
  order?: 'asc' | 'desc';
}

export interface Store {
  /* time series */
  upsertCandles(candles: Candle[]): Promise<void>;
  /** Ascending by t. `limit` keeps the most recent N. */
  getCandles(symbol: string, tf: Timeframe, opts?: { from?: number; to?: number; limit?: number }): Promise<Candle[]>;
  putData(data: Datum[]): Promise<void>;
  latestDatum(key: string): Promise<Datum | null>;
  latestData(keys: string[]): Promise<Record<string, Datum>>;
  /** Ascending by asOf. */
  dataHistory(key: string, sinceMs: number, untilMs?: number): Promise<Datum[]>;
  putQuotes(quotes: Quote[]): Promise<void>;
  latestQuotes(symbols?: string[]): Promise<Record<string, Quote>>;

  /* documents (upsert by id) */
  put<K extends CollectionName>(c: K, docs: Array<Collections[K]>): Promise<void>;
  get<K extends CollectionName>(c: K, id: string): Promise<Collections[K] | null>;
  list<K extends CollectionName>(c: K, opts?: ListOpts): Promise<Array<Collections[K]>>;
  remove<K extends CollectionName>(c: K, id: string): Promise<void>;

  /* small config and state: profile, weights, kill switch, rule snapshots, push subscriptions, feed health */
  kvGet<T>(key: string): Promise<T | null>;
  kvSet<T>(key: string, value: T): Promise<void>;

  close(): Promise<void>;
}

/**
 * Datum keys written by the feed layer (value units in brackets):
 *  rate.US2Y / rate.US10Y / rate.US30Y / rate.US3M [percent]   rate.2s10s [bp]
 *  fed.hike_prob.next / fed.cut_prob.next / fed.hold_prob.next [probability 0-1, not percent]   fed.implied_rate.next [percent]
 *  vol.VIX / vol.VIX3M [index]   vol.term [VIX3M/VIX]
 *  opt.implied_move.<SYMBOL> [percent, 1-day unless meta.days]   opt.put_call.<SYMBOL>   opt.skew.<SYMBOL>
 *  flow.etf.<SYMBOL> [USD mm, daily]   pos.cftc.NQ [net spec contracts]
 *  breadth.ad_line [advancers-decliners]
 */
export const DATUM_KEYS = {
  rate: (s: 'US2Y' | 'US10Y' | 'US30Y' | 'US3M' | 'US5Y') => `rate.${s}`,
  spread2s10s: 'rate.2s10s',
  fedHike: 'fed.hike_prob.next', fedCut: 'fed.cut_prob.next', fedHold: 'fed.hold_prob.next', fedImplied: 'fed.implied_rate.next',
  vix: 'vol.VIX', vix3m: 'vol.VIX3M', vixTerm: 'vol.term',
  impliedMove: (s: string) => `opt.implied_move.${s}`,
  putCall: (s: string) => `opt.put_call.${s}`,
  skew: (s: string) => `opt.skew.${s}`,
  etfFlow: (s: string) => `flow.etf.${s}`,
  cftc: (s: string) => `pos.cftc.${s}`,
} as const;

/** kv keys. */
export const KV = {
  profile: 'profile', weights: 'bias.weights', killSwitch: 'admin.kill', readOnlyUntil: 'session.read_only_until',
  pushSubs: 'push.subscriptions', feedHealth: 'feeds.health', ruleSnapshot: (accountId: string) => `rules.snapshot.${accountId}`,
  accountRules: 'accounts.rules', notifyState: 'notify.state', watcherState: (symbol: string) => `watcher.state.${symbol}`,
  calibration: 'bias.calibration', lastLoop: 'worker.last_loop',
  /** Worker step failures, same row shape as feeds.health (`step:<name>`). */
  workerHealth: 'worker.health', workerJobs: 'worker.jobs',
  baseRatesAt: 'watcher.base_rates_at', memoryIndex: 'memory.index',
  proposedWeights: 'bias.weights.proposed', refitReport: 'bias.refit_report', calibrationTable: 'bias.calibration_table',
  readOnlyReason: 'session.read_only_reason', guardrailThresholds: 'guardrails.thresholds',
  /** Latest PositionStatus per position id; previous-loop price per open ticket; closed tickets whose post-exit window is complete. */
  positionStatus: 'positions.status', ticketPrices: 'tickets.last_price', ticketsSettled: 'tickets.settled',
} as const;
