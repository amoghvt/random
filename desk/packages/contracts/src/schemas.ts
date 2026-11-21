/**
 * Cross-module contracts. Every engine output carries `asOf`/`createdAt` and its `inputs`
 * so a call can be replayed and scored (spec section 3, Boundaries).
 * Engines are pure: they take these shapes as arguments and return these shapes.
 */
import { z } from 'zod';

const Iso = z.string().min(10);
export const Direction = z.enum(['long', 'short']);
export type Direction = z.infer<typeof Direction>;
export const Timeframe = z.enum(['1m', '5m', '15m', '1h', '1d']);
export type Timeframe = z.infer<typeof Timeframe>;
export const TF_MS: Record<Timeframe, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000 };

/* ───────────────────────── Feed layer (section 4) ───────────────────────── */

export const Candle = z.object({
  symbol: z.string(), tf: Timeframe,
  /** Epoch ms of the candle open. */
  t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number(),
  source: z.string(),
});
export type Candle = z.infer<typeof Candle>;

/** Any stored value: source, timestamp and freshness travel with it. */
export const Datum = z.object({
  key: z.string(), value: z.number(), source: z.string(), asOf: Iso,
  /** Expected refresh cadence in seconds; older than 3x this is flagged stale, never silently used. */
  cadenceSec: z.number(),
  meta: z.record(z.unknown()).optional(),
});
export type Datum = z.infer<typeof Datum>;
export type Freshness = 'fresh' | 'aging' | 'stale';
export function freshness(d: { asOf: string; cadenceSec: number }, now: number): Freshness {
  const age = (now - Date.parse(d.asOf)) / 1000;
  return age <= d.cadenceSec ? 'fresh' : age <= d.cadenceSec * 3 ? 'aging' : 'stale';
}
export function ageLabel(asOf: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(asOf)) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const Quote = z.object({
  symbol: z.string(), price: z.number(), prevClose: z.number().nullable(),
  changePct: z.number().nullable(), asOf: Iso, source: z.string(), cadenceSec: z.number(),
});
export type Quote = z.infer<typeof Quote>;

export const HeadlineCategory = z.enum(['macro', 'fed', 'earnings', 'company', 'geopolitical', 'firm-rules', 'other']);
export type HeadlineCategory = z.infer<typeof HeadlineCategory>;
export const Headline = z.object({
  id: z.string(), ts: Iso, source: z.string(), title: z.string(), url: z.string().optional(),
  category: HeadlineCategory,
  /** Market impact 0-3. 3 creates an ad-hoc catalyst. */
  impact: z.number().int().min(0).max(3),
  /** +1 risk-on for the tagged instruments, -1 risk-off, 0 unclear. */
  direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  symbols: z.array(z.string()),
  classifier: z.enum(['rules', 'llm']),
  /** Normalized title hash used for dedupe. */
  dedupeKey: z.string(),
});
export type Headline = z.infer<typeof Headline>;

/** Canonical codes for scheduled events the catalyst engine knows how to branch. */
export const EventCode = z.enum([
  'CPI', 'CORE_CPI', 'PPI', 'CORE_PPI', 'NFP', 'UNEMPLOYMENT', 'FOMC', 'FOMC_MINUTES', 'FED_CHAIR', 'FED_SPEAKER',
  'PCE', 'CORE_PCE', 'ISM_MFG', 'ISM_SVC', 'JOLTS', 'RETAIL_SALES', 'CLAIMS', 'GDP', 'REGIONAL_FED', 'TREASURY_AUCTION',
  'EARNINGS', 'IPO', 'SUMMIT', 'ADHOC', 'OTHER',
]);
export type EventCode = z.infer<typeof EventCode>;

export const CalendarEvent = z.object({
  id: z.string(), code: EventCode, name: z.string(), time: Iso,
  consensus: z.number().nullable(), prior: z.number().nullable(), actual: z.number().nullable(),
  revisedPrior: z.number().nullable().optional(),
  unit: z.string().optional(),
  /** Provider importance (-1 low .. 1 high); the catalyst engine assigns the tier. */
  importance: z.number().optional(),
  /** For earnings: the ticker. */
  symbol: z.string().optional(),
  source: z.string(), asOf: Iso,
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export const PredictionMarket = z.object({
  id: z.string(), venue: z.enum(['kalshi', 'polymarket']), title: z.string(),
  eventCode: EventCode.optional(), eventDate: z.string().optional(),
  outcomes: z.array(z.object({ label: z.string(), prob: z.number().min(0).max(1), lo: z.number().nullable().optional(), hi: z.number().nullable().optional() })),
  volume: z.number().optional(), asOf: Iso, url: z.string().optional(),
});
export type PredictionMarket = z.infer<typeof PredictionMarket>;

export const EarningsInfo = z.object({
  symbol: z.string(), date: Iso, timing: z.enum(['bmo', 'amc', 'unknown']),
  epsConsensus: z.number().nullable(), revenueConsensus: z.number().nullable(), whisper: z.number().nullable(),
  impliedMovePct: z.number().nullable(),
  /** Post-print close-to-close reactions, newest first. */
  history: z.array(z.object({ date: z.string(), surprisePct: z.number().nullable(), nextDayPct: z.number() })),
  source: z.string(), asOf: Iso,
});
export type EarningsInfo = z.infer<typeof EarningsInfo>;

/** A filing or positioning datum with an explicit as-of date so the UI can show the lag. */
export const LaggedFact = z.object({ id: z.string(), kind: z.string(), text: z.string(), periodEnd: z.string(), publishedAt: Iso, source: z.string() });
export type LaggedFact = z.infer<typeof LaggedFact>;

export const RuleDiff = z.object({
  id: z.string(), accountIds: z.array(z.string()), firm: z.string(), url: z.string(), detectedAt: Iso,
  summary: z.string(), added: z.array(z.string()), removed: z.array(z.string()),
});
export type RuleDiff = z.infer<typeof RuleDiff>;

/* ───────────────────────── Trade plans (shared by catalyst, bias, tickets) ───────────────────────── */

export const EntryTrigger = z.object({
  kind: z.enum(['price', 'time', 'condition']),
  /** Human text, e.g. "second move after 08:45 ET if the 10Y confirms". Never "now". */
  text: z.string().min(3),
  price: z.number().optional(), at: Iso.optional(),
});
export type EntryTrigger = z.infer<typeof EntryTrigger>;

export const Target = z.object({ price: z.number(), fraction: z.number().min(0).max(1) });
export type Target = z.infer<typeof Target>;

export const TradePlan = z.object({
  instrument: z.string(), direction: Direction,
  entry: EntryTrigger,
  /** Price the plan's levels were computed from. */
  referencePrice: z.number(),
  targets: z.tuple([Target, Target, Target]),
  invalidation: z.object({ price: z.number(), reason: z.string().min(3) }),
  timeStop: z.object({ at: Iso.optional(), text: z.string() }),
  accountId: z.string().optional(),
  /** Filled by the sizing engine when an account is attached. */
  size: z.object({ units: z.number(), notionalUsd: z.number(), leverage: z.number().nullable(), failPrice: z.number().nullable() }).optional(),
});
export type TradePlan = z.infer<typeof TradePlan>;

/* ───────────────────────── Catalyst engine (section 5) ───────────────────────── */

export const HistoricalReaction = z.object({
  date: z.string(), actual: z.number().nullable(), consensus: z.number().nullable(), surprise: z.number().nullable(),
  m5Pct: z.number().nullable(), h1Pct: z.number().nullable(), closePct: z.number().nullable(),
  firstMoveReversed: z.boolean().nullable(),
});
export type HistoricalReaction = z.infer<typeof HistoricalReaction>;

export const ScenarioBranch = z.object({
  id: z.string(), label: z.string(),
  /** Match rule on the headline metric: lo <= actual < hi (null = open). For earnings/ad-hoc, `key` names the branch. */
  match: z.object({ metric: z.string(), lo: z.number().nullable(), hi: z.number().nullable(), key: z.string().optional() }),
  probability: z.number().min(0).max(1),
  probabilitySource: z.enum(['prediction_market', 'historical', 'prior']),
  ratesRead: z.object({ y2Bp: z.number(), y10Bp: z.number(), text: z.string() }),
  indexRead: z.object({ m15Pct: z.number(), h1Pct: z.number(), closePct: z.number(), text: z.string() }),
  secondOrder: z.string(),
  /** null = "No edge, stand aside"; then `noTradeReason` is set. */
  trade: TradePlan.nullable(),
  noTradeReason: z.string().optional(),
});
export type ScenarioBranch = z.infer<typeof ScenarioBranch>;

export const ScenarioMatrix = z.object({
  catalystId: z.string(), generatedAt: Iso, referencePrice: z.number(),
  branches: z.array(ScenarioBranch).min(2).max(6),
  regimeNotes: z.array(z.string()),
  whatIWouldDo: z.string(),
  inputs: z.record(z.unknown()),
});
export type ScenarioMatrix = z.infer<typeof ScenarioMatrix>;

export const Catalyst = z.object({
  id: z.string(), code: EventCode, name: z.string(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  scheduledAt: Iso, instruments: z.array(z.string()),
  consensus: z.number().nullable(), prior: z.number().nullable(), whisper: z.number().nullable(),
  unit: z.string().optional(), symbol: z.string().optional(),
  /** Expected absolute move of the primary instrument through the event, percent. */
  impliedMovePct: z.number().nullable(),
  impliedMoveSource: z.enum(['options', 'historical', 'vix']).nullable(),
  history: z.array(HistoricalReaction),
  predictionOdds: z.array(PredictionMarket),
  matrix: ScenarioMatrix.nullable(),
  status: z.enum(['upcoming', 'live', 'resolved']),
  resolution: z.object({ actual: z.number().nullable(), branchId: z.string().nullable(), resolvedAt: Iso, headlineId: z.string().optional() }).nullable(),
  /** Reaction clock readings after resolution. */
  reaction: z.object({ m5Pct: z.number().nullable(), m15Pct: z.number().nullable(), verdict: z.enum(['normal', 'muted', 'extreme']).nullable(), text: z.string() }).nullable().optional(),
  adhoc: z.object({ headlineId: z.string(), analog: z.string() }).optional(),
  source: z.string(), asOf: Iso,
});
export type Catalyst = z.infer<typeof Catalyst>;

/* ───────────────────────── Chart watcher (section 9) ───────────────────────── */

export const DetectorName = z.enum([
  'swing', 'liquidity_pool', 'sweep_reclaim', 'mss', 'bos', 'fvg', 'order_block', 'ema_posture',
  'retrace_quality', 'divergence', 'volume_context', 'range_compression',
]);
export type DetectorName = z.infer<typeof DetectorName>;

export const StructureEvent = z.object({
  id: z.string(), detector: DetectorName,
  /** Sub-type, e.g. 'bounce_stalled_under_50', 'spike_rejected', 'first_touch_rejection', 'equal_highs'. */
  kind: z.string(),
  instrument: z.string(), tf: Timeframe, ts: Iso,
  level: z.number().nullable(), levelHi: z.number().nullable().optional(),
  /** +1 bullish implication, -1 bearish, 0 neutral. */
  bias: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  confidence: z.number().min(0).max(1),
  /** Numbers-first sentence in the trader's language. */
  text: z.string(),
  data: z.record(z.unknown()),
  /** True for sweep-and-reclaim + MSS style confirmed setups a ticket may reference. */
  confirmedSetup: z.boolean().default(false),
});
export type StructureEvent = z.infer<typeof StructureEvent>;

export const WatcherUpdate = z.object({
  id: z.string(), ts: Iso, instrument: z.string(),
  /** Plain text, <= 280 chars, numbers first. */
  text: z.string().max(280),
  eventIds: z.array(z.string()),
  touches: z.object({ positionIds: z.array(z.string()), ticketIds: z.array(z.string()), biasKill: z.boolean() }),
  dedupeKey: z.string(),
  /** Higher = the same observation got worse; a worsening is pushed, a repeat is not. */
  severity: z.number(),
});
export type WatcherUpdate = z.infer<typeof WatcherUpdate>;

export const BaseRate = z.object({ pattern: z.string(), instrument: z.string(), tf: Timeframe, windowDays: z.number(), n: z.number(), hitRate: z.number(), definition: z.string(), asOf: Iso });
export type BaseRate = z.infer<typeof BaseRate>;

/* ───────────────────────── Bias engine (section 6) ───────────────────────── */

export const BiasLabel = z.enum(['strong_long', 'lean_long', 'no_edge', 'lean_short', 'strong_short']);
export type BiasLabel = z.infer<typeof BiasLabel>;
export const BIAS_TEXT: Record<BiasLabel, string> = { strong_long: 'Strong long', lean_long: 'Lean long', no_edge: 'No edge', lean_short: 'Lean short', strong_short: 'Strong short' };
export const Horizon = z.enum(['intraday', 'swing', 'position']);
export type Horizon = z.infer<typeof Horizon>;
export const FactorName = z.enum(['catalyst', 'rates', 'fed', 'regime', 'breadth', 'positioning', 'news', 'structure', 'calendar', 'cross_asset']);
export type FactorName = z.infer<typeof FactorName>;

export const FactorScore = z.object({
  factor: FactorName, score: z.number().min(-2).max(2), weight: z.number(),
  /** Numbers-first evidence, e.g. "10Y -9 bp to 4.94% after PPI". */
  evidence: z.string(), asOf: Iso, stale: z.boolean().default(false),
});
export type FactorScore = z.infer<typeof FactorScore>;

export const BiasCall = z.object({
  id: z.string(), instrument: z.string(), horizon: Horizon,
  call: BiasLabel,
  /** 0.50-0.85, never higher. */
  probability: z.number().min(0.5).max(0.85),
  score: z.number(),
  factors: z.array(FactorScore),
  facts: z.array(z.string()).max(3),
  trade: TradePlan.nullable(),
  killCondition: z.object({ text: z.string(), level: z.number().optional(), side: z.enum(['above', 'below']).optional() }),
  nextCatalyst: z.object({ id: z.string(), name: z.string(), at: Iso }).nullable(),
  expiresAt: Iso, createdAt: Iso,
  /** The new fact that justified a new call. A call never changes on the same evidence. */
  trigger: z.object({ kind: z.enum(['initial', 'print', 'headline', 'level', 'time_stop', 'expiry']), ref: z.string() }),
  /** "first move, not yet trusted" state after a catalyst. */
  firstMoveUntrusted: z.boolean().default(false),
  referencePrice: z.number(),
  inputs: z.record(z.unknown()),
  outcome: z.object({ resolvedAt: Iso, movePct: z.number(), correct: z.boolean().nullable() }).nullable().optional(),
});
export type BiasCall = z.infer<typeof BiasCall>;

export const BiasWeights = z.record(FactorName, z.number());
export type BiasWeights = z.infer<typeof BiasWeights>;
/** Section 6 starting weights; `other` 0.05 is split across fed/calendar/cross_asset. */
export const DEFAULT_WEIGHTS: Record<FactorName, number> = {
  catalyst: 0.30, rates: 0.20, regime: 0.15, breadth: 0.10, positioning: 0.10, structure: 0.10, news: 0.05,
  fed: 0.02, calendar: 0.015, cross_asset: 0.015,
};

export const CalibrationBucket = z.object({ lo: z.number(), hi: z.number(), n: z.number(), predicted: z.number(), realized: z.number().nullable() });
export type CalibrationBucket = z.infer<typeof CalibrationBucket>;

/* ───────────────────────── Accounts and sizing (section 7) ───────────────────────── */

export const AccountRules = z.object({
  id: z.string(), firm: z.string(), program: z.string(), name: z.string(),
  venue: z.enum(['cme', 'perp']),
  startingBalance: z.number(),
  instruments: z.array(z.string()),
  drawdown: z.object({
    type: z.enum(['static', 'eod_trailing', 'intraday_trailing']),
    amountUsd: z.number().nullable(), pct: z.number().nullable(),
    /** Balance at which the trailing floor stops moving (e.g. start + 100), null if it never locks. */
    locksAtBalance: z.number().nullable(),
    lockedFloor: z.number().nullable(),
    includesOpenPnl: z.boolean(),
    text: z.string(),
  }),
  dailyLoss: z.object({ amountUsd: z.number().nullable(), pctOfSnapshot: z.number().nullable(), snapshotET: z.string().nullable(), hardBreach: z.boolean(), text: z.string() }).nullable(),
  payout: z.object({
    capUsd: z.number().nullable(), minUsd: z.number().nullable(),
    qualifyingDays: z.number().nullable(), qualifyingDayMinUsd: z.number().nullable(),
    cycleDays: z.number().nullable(), consistencyPct: z.number().nullable(),
    maxPayouts: z.number().nullable(), ladderUsd: z.array(z.number()).nullable(),
    bufferUsd: z.number().nullable(), text: z.string(),
  }),
  inactivityDays: z.number().nullable(),
  leverage: z.object({ caps: z.record(z.number()), eventCutText: z.string().nullable(), maxContracts: z.number().nullable() }),
  session: z.object({
    flattenByET: z.string().nullable(),
    weekendLock: z.object({ fromET: z.string(), toET: z.string(), text: z.string() }).nullable(),
  }),
  prohibited: z.array(z.object({ rule: z.enum(['cross_account_hedging', 'news_trading', 'micro_scalping', 'stop_entry_orders', 'other']), clause: z.string(), minHoldSec: z.number().optional() })),
  /** Divergence between this venue's mark and CME, points; feeds the 20% cushion note. */
  markDivergencePts: z.tuple([z.number(), z.number()]).nullable(),
  firmRisk: z.array(z.string()),
  claimPromptGainPct: z.number().nullable(),
  source: z.object({ urls: z.array(z.string()), asOf: z.string(), origin: z.string() }),
});
export type AccountRules = z.infer<typeof AccountRules>;

export const AccountState = z.object({
  accountId: z.string(), asOf: Iso, active: z.boolean(),
  balance: z.number(), equity: z.number(), highWaterBalance: z.number(),
  /** Balance at the firm's daily snapshot. */
  dayStartBalance: z.number(), dayPnl: z.number(),
  cyclePnl: z.number(), bestDayPnlInCycle: z.number(), qualifyingDaysInCycle: z.number(),
  cycleStartedAt: Iso.nullable(), payoutsTaken: z.number(), lastTradeAt: Iso.nullable(),
});
export type AccountState = z.infer<typeof AccountState>;

export const PositionStatusLabel = z.enum(['Safe', 'Thin', 'Critical']);
export type PositionStatusLabel = z.infer<typeof PositionStatusLabel>;

export const Position = z.object({
  id: z.string(), accountId: z.string(), ticketId: z.string().nullable(),
  instrument: z.string(), direction: Direction,
  /** Contracts for futures, USD notional for perps/stocks. */
  units: z.number(), entryPrice: z.number(), openedAt: Iso,
  /** Venue liquidation price if the venue has one (perps); otherwise derived from account room. */
  liquidationPrice: z.number().nullable(),
  leverage: z.number().nullable(),
});
export type Position = z.infer<typeof Position>;

export const PositionStatus = z.object({
  positionId: z.string(), asOf: Iso, mark: z.number(), pnlUsd: z.number(),
  failPrice: z.number(), distancePts: z.number(), distancePct: z.number(),
  status: PositionStatusLabel, atr1m: z.number().nullable(),
  nextLockOrSnapshot: z.object({ what: z.string(), at: Iso }).nullable(),
  catalystInWindow: z.object({ id: z.string(), name: z.string(), at: Iso, tier: z.number() }).nullable(),
  line: z.string(),
});
export type PositionStatus = z.infer<typeof PositionStatus>;

export const SizingResult = z.object({
  accountId: z.string(), instrument: z.string(), direction: Direction, asOf: Iso,
  blocked: z.boolean(), blockReason: z.string().nullable(),
  /** Largest size that survives the worst plausible path. The trader may size down, never up. */
  maxUnits: z.number(), notionalUsd: z.number(), leverage: z.number().nullable(),
  failPrice: z.number().nullable(), failDistancePts: z.number().nullable(), failDistancePct: z.number().nullable(),
  worstMove: z.object({ pct: z.number(), pts: z.number(), basis: z.enum(['p95_window', 'tier1_implied', 'atr_scalp', 'weekend_gap']), text: z.string() }),
  room: z.object({ toDrawdownUsd: z.number(), toDailyLimitUsd: z.number().nullable(), usableUsd: z.number(), cushionPct: z.number(), binding: z.enum(['drawdown', 'daily_limit']) }),
  catalystInWindow: z.object({ id: z.string(), name: z.string(), impliedMovePct: z.number().nullable() }).nullable(),
  notes: z.array(z.string()),
  payoutNote: z.string().nullable(),
  inputs: z.record(z.unknown()),
});
export type SizingResult = z.infer<typeof SizingResult>;

export const HedgeViolation = z.object({ accountA: z.string(), accountB: z.string(), instrumentA: z.string(), instrumentB: z.string(), correlation: z.number(), clause: z.string(), text: z.string() });
export type HedgeViolation = z.infer<typeof HedgeViolation>;

/* ───────────────────────── Tickets and journal (sections 8, 12) ───────────────────────── */

export const TicketReason = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('catalyst'), catalystId: z.string(), branchId: z.string().optional() }),
  z.object({ kind: z.literal('structure'), setupEventId: z.string() }),
]);
export type TicketReason = z.infer<typeof TicketReason>;

export const Fill = z.object({ ts: Iso, price: z.number(), units: z.number(), kind: z.enum(['entry', 'add', 'scale_out', 'stop', 'exit']), source: z.enum(['manual', 'account_feed']) });
export type Fill = z.infer<typeof Fill>;

export const OverrideKind = z.enum(['size_up', 'held_through_invalidation', 'held_through_time_stop', 'skipped_scale_out', 'added_to_loser', 'early_exit', 'moved_stop', 'other']);
export type OverrideKind = z.infer<typeof OverrideKind>;
export const Override = z.object({ ts: Iso, kind: OverrideKind, reason: z.string(), pnlImpactUsd: z.number().nullable() });
export type Override = z.infer<typeof Override>;

export const TicketStatus = z.enum(['watch', 'planned', 'open', 'closed', 'cancelled']);
export const Ticket = z.object({
  id: z.string(), createdAt: Iso, accountId: z.string(), instrument: z.string(), direction: Direction,
  reason: TicketReason,
  entry: EntryTrigger,
  size: z.object({ engineMaxUnits: z.number(), units: z.number(), notionalUsd: z.number(), leverage: z.number().nullable(), failPrice: z.number().nullable() }),
  targets: z.tuple([Target, Target, Target]),
  invalidation: z.object({ price: z.number(), reason: z.string().min(3) }),
  timeStop: Iso,
  holdThroughCatalyst: z.object({ flag: z.boolean(), catalystId: z.string().nullable() }),
  status: TicketStatus,
  fills: z.array(Fill), overrides: z.array(Override),
  /** Structure events seen while the ticket was live. */
  watcherEventIds: z.array(z.string()),
  closedAt: Iso.nullable(),
  result: z.object({
    pnlUsd: z.number(), exitPrice: z.number(), adherence: z.number(),
    deductions: z.array(z.object({ kind: OverrideKind, points: z.number() })),
    /** Excursions after exit, in percent of exit price, measured to the plan's time stop + 1 session. */
    mfeAfterExitPct: z.number().nullable(), maeAfterExitPct: z.number().nullable(),
    /** Share of the available favorable move (entry to best price before time stop) that was captured. */
    capturePct: z.number().nullable(),
    followedPlan: z.boolean(),
  }).nullable(),
  sizingSnapshot: SizingResult.nullable(),
  notes: z.string().optional(),
});
export type Ticket = z.infer<typeof Ticket>;

/** What the ticket form submits; the server fills size from the sizing engine. */
export const TicketDraft = z.object({
  accountId: z.string(), instrument: z.string(), direction: Direction,
  reason: z.unknown(), entry: z.unknown(),
  /** Requested units; clamped to <= engine max. Omit to take the engine size. */
  units: z.number().positive().optional(),
  targets: z.unknown(), invalidation: z.unknown(), timeStop: z.unknown(),
  notes: z.string().optional(),
});
export type TicketDraft = z.infer<typeof TicketDraft>;

export const JournalNote = z.object({ id: z.string(), ts: Iso, text: z.string(), tags: z.array(z.string()), source: z.enum(['trader', 'system', 'seed']) });
export type JournalNote = z.infer<typeof JournalNote>;

export const ChatMessage = z.object({ id: z.string(), ts: Iso, role: z.enum(['trader', 'desk']), text: z.string(), asOf: Iso.optional(), citations: z.array(z.object({ label: z.string(), source: z.string(), asOf: Iso })).optional() });
export type ChatMessage = z.infer<typeof ChatMessage>;

/* ───────────────────────── Guardrails (section 11) ───────────────────────── */

export const GuardrailPattern = z.enum([
  'bottom_call', 'hold_the_winner', 'size_creep', 'thin_fail_price', 'squeeze_as_strength', 'liquidity_run',
  'hedge_the_decision', 'cross_account_offset', 'late_night_idea', 'regret_loop', 'research_as_permission', 'catalyst_hold',
  'circuit_breaker', 'reentry_cooldown', 'claim_prompt',
]);
export type GuardrailPattern = z.infer<typeof GuardrailPattern>;

export const GuardrailFiring = z.object({
  id: z.string(), ts: Iso, pattern: GuardrailPattern,
  /** One firing per episode; repeats inside the episode are replaced by the override ledger number. */
  episodeKey: z.string(),
  /** One sentence of pattern, one of evidence, one of action. No third paragraph. */
  text: z.string(),
  blocks: z.boolean(),
  /** 'watch' downgrades a ticket to a watch instead of blocking. */
  effect: z.enum(['none', 'block', 'downgrade_to_watch', 'cap_size', 'read_only']),
  capUnits: z.number().optional(),
  trigger: z.object({ kind: z.enum(['ticket', 'chat', 'position', 'session']), ref: z.string() }),
  evidence: z.record(z.unknown()),
  /** Learning loop: what the trader did next and what it cost or saved. */
  followUp: z.object({ action: z.enum(['complied', 'overrode', 'ignored']).nullable(), outcomeUsd: z.number().nullable() }).nullable(),
});
export type GuardrailFiring = z.infer<typeof GuardrailFiring>;

export const OverrideLedger = z.object({ monthToDateUsd: z.number(), instances: z.number(), lastPaidAt: Iso.nullable(), planCapturePct: z.number().nullable(), overrideCapturePct: z.number().nullable() });
export type OverrideLedger = z.infer<typeof OverrideLedger>;

/* ───────────────────────── Notifications (section 10) ───────────────────────── */

export const NotifyClass = z.enum(['P0', 'P1', 'P2', 'P3']);
export type NotifyClass = z.infer<typeof NotifyClass>;

export const NotificationIntent = z.object({
  class: NotifyClass,
  /** Machine reason, e.g. 'position_critical', 'tier1_resolved', 'rule_change', 'bias_strong', 'catalyst_t60'. */
  reason: z.string(),
  instrument: z.string().nullable(),
  /** Line 1: the fact with the number. Line 2: the call or action. Line 3 (optional): the pattern flag, once. */
  lines: z.array(z.string()).min(1).max(3),
  deepLink: z.string(),
  /** Everything needed to act from the lock screen; opens a pre-filled ticket. */
  ticketPrefill: TradePlan.extend({ reason: TicketReason }).optional(),
  dedupeKey: z.string(), ts: Iso,
});
export type NotificationIntent = z.infer<typeof NotificationIntent>;

export const Notification = NotificationIntent.extend({
  id: z.string(),
  decision: z.enum(['sent', 'suppressed']),
  suppressedBy: z.string().nullable(),
  channels: z.array(z.enum(['webpush', 'telegram', 'feed'])),
  tappedAt: Iso.nullable(),
});
export type Notification = z.infer<typeof Notification>;

/* ───────────────────────── Briefs (section 12) ───────────────────────── */

export const Brief = z.object({
  id: z.string(), kind: z.enum(['morning', 'recap', 'weekly']), ts: Iso, forDay: z.string(),
  sections: z.array(z.object({ key: z.string(), title: z.string(), lines: z.array(z.string()) })),
  /** Every number's as-of time and source. */
  citations: z.array(z.object({ label: z.string(), source: z.string(), asOf: Iso })),
  wordCount: z.number(),
});
export type Brief = z.infer<typeof Brief>;

/* ───────────────────────── Profile (section 2) ───────────────────────── */

export const Profile = z.object({
  trader: z.string(), timezone: z.string(),
  style: z.object({ summary: z.string(), edge: z.array(z.string()), notEdge: z.array(z.string()) }),
  instruments: z.object({ primary: z.array(z.string()), watchlist: z.array(z.string()), occasional: z.array(z.string()), timeframes: z.object({ execution: z.array(z.string()), structure: z.array(z.string()) }), language: z.string() }),
  accounts: z.array(z.string()),
  failurePatterns: z.array(z.object({ id: GuardrailPattern, pattern: z.string(), looksLike: z.string(), cost: z.string() })),
  voice: z.object({ rules: z.array(z.string()), banned: z.array(z.string()) }),
  goals: z.array(z.string()),
  regimeNotes: z.array(z.string()),
  weights: z.record(z.number()),
  circuitBreakers: z.object({ planBreakingTradesPerDay: z.number(), vestClaimGainPct: z.number(), lateNight: z.object({ from: z.string(), to: z.string(), catalystWithinHours: z.number() }), reentryCooldownMin: z.number() }),
  notifications: z.object({ quietHours: z.object({ from: z.string(), to: z.string() }), p1PerSession: z.number(), p2PerDay: z.number(), morningBriefLocal: z.string(), recapET: z.string(), weeklyLocal: z.string() }),
  memos: z.array(z.object({ week: z.string(), text: z.string(), approved: z.boolean() })),
});
export type Profile = z.infer<typeof Profile>;
