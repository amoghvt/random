/**
 * Synthetic fixtures for the notification tests. Every price, print and account figure here is
 * invented to exercise the policy; none of it is market history and none of it reaches the trader.
 */
import { ET, fromZoned, iso } from '@desk/contracts';
import type {
  AccountRules, AccountState, BiasCall, Brief, Catalyst, Headline, NotificationIntent, NotifyClass, Position,
  PositionStatus, Profile, RuleDiff, ScenarioBranch, StructureEvent, Ticket, TradePlan,
} from '@desk/contracts';

export const et = (y: number, m: number, d: number, h = 0, min = 0): number => fromZoned(y, m, d, h, min, ET);
/** Wednesday 18 Nov 2026, 09:00 ET. */
export const WED_0900 = et(2026, 11, 18, 9, 0);

export const syntheticProfile: Profile = {
  trader: 'Synthetic', timezone: ET,
  style: { summary: 'Event-driven.', edge: [], notEdge: [] },
  instruments: { primary: ['NQ', 'NQ-PERP', 'MNQ'], watchlist: ['NVDA', 'AMZN'], occasional: [], timeframes: { execution: ['1m'], structure: ['1h'] }, language: 'ICT' },
  accounts: ['vest-instant', 'mffu-builder-50k'], failurePatterns: [],
  voice: { rules: [], banned: ['consider', 'you may want to'] }, goals: [], regimeNotes: [], weights: {},
  circuitBreakers: { planBreakingTradesPerDay: 3, vestClaimGainPct: 30, lateNight: { from: '23:00', to: '06:00', catalystWithinHours: 12 }, reentryCooldownMin: 15 },
  notifications: { quietHours: { from: '23:30', to: '06:00' }, p1PerSession: 8, p2PerDay: 6, morningBriefLocal: '06:30', recapET: '16:30', weeklyLocal: 'Sun 18:00' },
  memos: [],
};

export function syntheticIntent(cls: NotifyClass, n: number, over: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    class: cls, reason: cls === 'P3' ? 'brief_morning' : `synthetic_${cls}`, instrument: 'NVDA',
    lines: [`Synthetic ${cls} fact ${n}.`, 'Synthetic action.'], deepLink: '/', dedupeKey: `synthetic:${cls}:${n}`, ts: iso(WED_0900), ...over,
  };
}

export const syntheticPlan: TradePlan = {
  instrument: 'NQ-PERP', direction: 'short',
  entry: { kind: 'condition', text: 'second move after 08:45 ET if the 10Y confirms' },
  referencePrice: 27_180,
  targets: [{ price: 27_000, fraction: 1 / 3 }, { price: 26_880, fraction: 1 / 3 }, { price: 26_750, fraction: 1 / 3 }],
  invalidation: { price: 27_310, reason: 'reclaims the pre-release high with chips leading' },
  timeStop: { at: iso(et(2026, 11, 18, 10, 30)), text: 'flat by 10:30 ET' },
  accountId: 'vest-instant',
  size: { units: 40_000, notionalUsd: 40_000, leverage: 8, failPrice: 27_520 },
};

const branch = (id: string, label: string, probability: number, trade: TradePlan | null): ScenarioBranch => ({
  id, label, match: { metric: 'core_cpi_mom', lo: null, hi: null }, probability, probabilitySource: 'prediction_market',
  ratesRead: { y2Bp: 6, y10Bp: 9, text: '2Y and 10Y up' }, indexRead: { m15Pct: -0.6, h1Pct: -0.9, closePct: -1.1, text: 'sold' },
  secondOrder: 'Hot core with hike odds high is bearish.', trade, ...(trade ? {} : { noTradeReason: 'No edge, stand aside until 09:15.' }),
});

export function syntheticCatalyst(over: Partial<Catalyst> = {}): Catalyst {
  const scheduledAt = iso(et(2026, 11, 18, 8, 30));
  return {
    id: 'cat_synthetic_core_cpi', code: 'CORE_CPI', name: 'Core CPI MoM', tier: 1, scheduledAt, instruments: ['NQ', 'NQ-PERP'],
    consensus: 0.2, prior: 0.2, whisper: 0.3, unit: '%', impliedMovePct: 1.1, impliedMoveSource: 'options', history: [], predictionOdds: [],
    matrix: {
      catalystId: 'cat_synthetic_core_cpi', generatedAt: iso(et(2026, 11, 17, 20, 0)), referencePrice: 27_180,
      branches: [branch('b_a', '0.1 or lower', 0.15, { ...syntheticPlan, direction: 'long' }), branch('b_b', '0.2', 0.45, null), branch('b_c', '0.3', 0.4, syntheticPlan)],
      regimeNotes: ['First move trades the headline, second move trades yields.'],
      whatIWouldDo: 'Flat into the print; trade the second move in the direction the 10Y confirms.', inputs: {},
    },
    status: 'resolved', resolution: { actual: 0.3, branchId: 'b_c', resolvedAt: iso(et(2026, 11, 18, 8, 30) + 4_000) },
    source: 'synthetic', asOf: scheduledAt, ...over,
  };
}

export const syntheticPosition: Position = {
  id: 'pos_synthetic_1', accountId: 'vest-instant', ticketId: 'tkt_synthetic_1', instrument: 'NQ-PERP', direction: 'long',
  units: 50_000, entryPrice: 27_100, openedAt: iso(WED_0900), liquidationPrice: 26_940, leverage: 50,
};
export const syntheticCritical: PositionStatus = {
  positionId: 'pos_synthetic_1', asOf: iso(WED_0900), mark: 27_062, pnlUsd: -70, failPrice: 26_940, distancePts: 122, distancePct: 0.45,
  status: 'Critical', atr1m: 110.5, nextLockOrSnapshot: null,
  catalystInWindow: { id: 'cat_synthetic_core_cpi', name: 'Core CPI MoM', at: iso(et(2026, 11, 18, 8, 30)), tier: 1 }, line: 'Critical',
};

export const syntheticTicket: Ticket = {
  id: 'tkt_synthetic_1', createdAt: iso(et(2026, 11, 17, 20, 30)), accountId: 'mffu-builder-50k', instrument: 'NQ', direction: 'short',
  reason: { kind: 'catalyst', catalystId: 'cat_synthetic_core_cpi', branchId: 'b_c' },
  entry: { kind: 'price', text: 'rejection of 27,180 after the print', price: 27_180 },
  size: { engineMaxUnits: 2, units: 2, notionalUsd: 1_087_200, leverage: null, failPrice: null },
  targets: [{ price: 27_000, fraction: 1 / 3 }, { price: 26_880, fraction: 1 / 3 }, { price: 26_750, fraction: 1 / 3 }],
  invalidation: { price: 27_310, reason: 'reclaims the pre-release high with chips leading' },
  timeStop: iso(et(2026, 11, 18, 15, 30)), holdThroughCatalyst: { flag: false, catalystId: null }, status: 'planned',
  fills: [], overrides: [], watcherEventIds: [], closedAt: null, result: null, sizingSnapshot: null,
};

export function syntheticCall(call: BiasCall['call'], probability: number, id: string): BiasCall {
  return {
    id, instrument: 'NQ', horizon: 'intraday', call, probability, score: 0, factors: [],
    facts: ['10Y +9 bp to 4.95% after the print.'], trade: call === 'no_edge' ? null : { ...syntheticPlan, instrument: 'NQ' },
    killCondition: { text: '10Y back under 4.90%' }, nextCatalyst: null, expiresAt: iso(et(2026, 11, 18, 15, 30)), createdAt: iso(WED_0900),
    trigger: { kind: 'print', ref: 'cat_synthetic_core_cpi' }, firstMoveUntrusted: false, referencePrice: 27_180, inputs: {},
  };
}

export const syntheticSetup: StructureEvent = {
  id: 'evt_synthetic_1', detector: 'sweep_reclaim', kind: 'sweep_reclaim_mss', instrument: 'NVDA', tf: '15m', ts: iso(WED_0900),
  level: 142.5, bias: 1, confidence: 0.72, text: 'NVDA swept 142.50, closed back above in 2 candles, 15m MSS through 144.10.', data: {}, confirmedSetup: true,
};

export const syntheticDiff: RuleDiff = {
  id: 'diff_synthetic_1', accountIds: ['mffu-builder-50k', 'mffu-pro-50k'], firm: 'Synthetic Firm', url: 'synthetic://rules',
  detectedAt: iso(WED_0900), summary: 'Daily loss limit line changed from $1,000 to $900.', added: ['Daily loss limit $900'], removed: ['Daily loss limit $1,000'],
};

export const syntheticHeadline: Headline = {
  id: 'hl_synthetic_1', ts: iso(WED_0900), source: 'synthetic', title: 'Synthetic export-control action announced on advanced chips, effective immediately',
  category: 'geopolitical', impact: 3, direction: -1, symbols: ['NQ', 'NVDA'], classifier: 'rules', dedupeKey: 'synthetic-export-control',
};

export function syntheticAccount(over: Partial<AccountRules> = {}): AccountRules {
  return {
    id: 'vest-instant', firm: 'Vest', program: 'Instant', name: 'Vest Instant', venue: 'perp', startingBalance: 10_000, instruments: ['NQ-PERP'],
    drawdown: { type: 'static', amountUsd: null, pct: 6, locksAtBalance: null, lockedFloor: null, includesOpenPnl: true, text: 'static 6%' },
    dailyLoss: null,
    payout: { capUsd: null, minUsd: null, qualifyingDays: null, qualifyingDayMinUsd: null, cycleDays: null, consistencyPct: null, maxPayouts: null, ladderUsd: null, bufferUsd: null, text: 'claim anytime' },
    inactivityDays: null, leverage: { caps: { 'NQ-PERP': 50 }, eventCutText: null, maxContracts: null },
    session: { flattenByET: null, weekendLock: { fromET: 'Fri 20:00', toET: 'Sun 18:00', text: 'Non-crypto markets lock Fri 20:00 ET to Sun 18:00 ET.' } },
    prohibited: [], markDivergencePts: null, firmRisk: [], claimPromptGainPct: 25, source: { urls: [], asOf: '2026-11-21', origin: 'synthetic' }, ...over,
  };
}
export const syntheticCmeAccount = (): AccountRules => syntheticAccount({
  id: 'mffu-builder-50k', firm: 'Synthetic Firm', program: 'Builder', name: 'Builder 50K', venue: 'cme', startingBalance: 50_000, inactivityDays: 7,
  payout: { capUsd: 2_000, minUsd: 500, qualifyingDays: 2, qualifyingDayMinUsd: 150, cycleDays: null, consistencyPct: 50, maxPayouts: null, ladderUsd: null, bufferUsd: 2_100, text: 'synthetic' },
  session: { flattenByET: '16:00', weekendLock: null },
});

export function syntheticAccountState(accountId: string, over: Partial<AccountState> = {}): AccountState {
  return {
    accountId, asOf: iso(WED_0900), active: true, balance: 10_000, equity: 10_000, highWaterBalance: 10_000, dayStartBalance: 10_000, dayPnl: 0,
    cyclePnl: 0, bestDayPnlInCycle: 0, qualifyingDaysInCycle: 0, cycleStartedAt: null, payoutsTaken: 0, lastTradeAt: null, ...over,
  };
}

export function syntheticBrief(kind: Brief['kind']): Brief {
  return {
    id: `brief_synthetic_${kind}`, kind, ts: iso(et(2026, 11, 18, 6, 30)), forDay: '2026-11-18',
    sections: [{ key: 'call', title: 'The call', lines: ['NQ Lean short 0.58, expires 15:30 ET.'] }, { key: 'one_thing', title: 'The one thing', lines: ['No edge until Core CPI at 08:30 ET.'] }],
    citations: [], wordCount: 312,
  };
}
