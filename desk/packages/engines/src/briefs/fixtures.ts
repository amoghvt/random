/** Synthetic inputs for the briefs and Ask tests. Every price, level and dollar figure here is made up for the test. */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  HOUR, MIN, Profile, fromZoned, iso,
  type AccountRow, type AccountRules, type BiasCall, type Catalyst, type Headline, type OverrideLedger, type Quote,
  type RatesStrip, type Stamped, type Ticket, type TradePlan,
} from '@desk/contracts';
import type { AskCtx, MorningCtx, PositionLine } from './types';

export const syntheticProfile = (timezone?: string): Profile => {
  const p = Profile.parse(parse(readFileSync(new URL('../../../../profile.yaml', import.meta.url), 'utf8')));
  return timezone ? { ...p, timezone } : p;
};

/** Friday 2026-11-20 06:30 ET. */
export const NOW = fromZoned(2026, 11, 20, 6, 30);
export const at = (h: number, m = 0, day = 20): string => iso(fromZoned(2026, 11, day, h, m));

export const syntheticQuote = (symbol: string, price: number, prevClose: number | null, asOf = iso(NOW - MIN), cadenceSec = 60): Quote =>
  ({ symbol, price, prevClose, changePct: null, asOf, source: 'synthetic feed', cadenceSec });

const st = (value: number | null, asOf: string | null = iso(NOW - MIN), stale = false): Stamped<number> =>
  ({ value, asOf, source: value === null ? null : 'synthetic rates', stale, age: null });
export const syntheticRates = (over: Partial<RatesStrip> = {}): RatesStrip => ({
  y2: st(4.61), y10: st(4.94), y30: st(5.02), y2Chg1hBp: 1, y10Chg1hBp: -2, y2Chg1dBp: 2, y10Chg1dBp: -9, spread2s10sBp: 33,
  fed: { hike: st(null, null), cut: st(null, null), hold: st(null, null), meeting: null }, ...over,
});

const plan: TradePlan = {
  instrument: 'NQ', direction: 'short', entry: { kind: 'condition', text: 'second move after 08:45 ET if the 10Y confirms' }, referencePrice: 27062,
  targets: [{ price: 26950, fraction: 0.4 }, { price: 26880, fraction: 0.3 }, { price: 26800, fraction: 0.3 }],
  invalidation: { price: 27140, reason: 'reclaim of the overnight high' }, timeStop: { text: '15:30 ET' }, accountId: 'apex-50k',
};
export const syntheticCall = (over: Partial<BiasCall> = {}): BiasCall => ({
  id: 'call_syn_1', instrument: 'NQ', horizon: 'intraday', call: 'lean_short', probability: 0.62, score: -0.7,
  factors: [
    { factor: 'rates', score: -1.5, weight: 0.2, evidence: '10Y +6 bp to 4.94%', asOf: at(6, 0), stale: false },
    { factor: 'catalyst', score: -1, weight: 0.3, evidence: 'CPI at 08:30', asOf: at(6, 0), stale: false },
  ],
  facts: ['10Y +6 bp to 4.94% overnight', 'SOX −1.8% while staples +0.4%', 'bounce stalled under the 50% retrace at 27,110'],
  trade: plan, killCondition: { text: '15m close above 27,140', level: 27140, side: 'above' },
  nextCatalyst: { id: 'cat_cpi', name: 'CPI', at: at(8, 30) }, expiresAt: at(16, 0), createdAt: at(6, 0),
  trigger: { kind: 'initial', ref: 'open' }, firstMoveUntrusted: false, referencePrice: 27062, inputs: {}, ...over,
});

export const syntheticCatalyst = (over: Partial<Catalyst> = {}): Catalyst => ({
  id: 'cat_cpi', code: 'CPI', name: 'CPI', tier: 1, scheduledAt: at(8, 30), instruments: ['NQ'], consensus: 0.3, prior: 0.2, whisper: 0.2, unit: '%',
  impliedMovePct: 1.1, impliedMoveSource: 'options', history: [], predictionOdds: [],
  matrix: {
    catalystId: 'cat_cpi', generatedAt: at(5, 0), referencePrice: 27062, regimeNotes: [], whatIWouldDo: 'Short the second move on a hot core', inputs: {},
    branches: [
      { id: 'b_hot', label: 'core 0.4 or higher', match: { metric: 'core_mom', lo: 0.4, hi: null }, probability: 0.25, probabilitySource: 'prior', ratesRead: { y2Bp: 8, y10Bp: 6, text: 'yields up' }, indexRead: { m15Pct: -0.8, h1Pct: -1.1, closePct: -1.4, text: 'sold' }, secondOrder: 'bearish', trade: plan },
      { id: 'b_inline', label: 'core 0.3', match: { metric: 'core_mom', lo: 0.3, hi: 0.4 }, probability: 0.45, probabilitySource: 'prior', ratesRead: { y2Bp: 0, y10Bp: 0, text: 'flat' }, indexRead: { m15Pct: 0.2, h1Pct: 0.1, closePct: 0, text: 'chop' }, secondOrder: 'ambiguous', trade: null, noTradeReason: 'stand aside until 09:15' },
    ],
  },
  status: 'upcoming', resolution: null, source: 'synthetic calendar', asOf: at(5, 0), ...over,
});

export const syntheticTicket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt_syn_1', createdAt: at(15, 0, 19), accountId: 'vest-instant', instrument: 'NQ-PERP', direction: 'long',
  reason: { kind: 'catalyst', catalystId: 'cat_cpi' }, entry: { kind: 'price', text: 'reclaim of 26,950', price: 26950 },
  size: { engineMaxUnits: 20000, units: 20000, notionalUsd: 20000, leverage: 10, failPrice: 26790 },
  targets: [{ price: 27100, fraction: 0.4 }, { price: 27180, fraction: 0.3 }, { price: 27260, fraction: 0.3 }],
  invalidation: { price: 26900, reason: 'loss of the sweep low' }, timeStop: at(15, 30), holdThroughCatalyst: { flag: false, catalystId: null },
  status: 'open', fills: [], overrides: [], watcherEventIds: [], closedAt: null, result: null, sizingSnapshot: null, ...over,
});

export const syntheticPosition = (statusAsOf = iso(NOW - MIN)): PositionLine => ({
  position: { id: 'pos_syn_1', accountId: 'vest-instant', ticketId: 'tkt_syn_1', instrument: 'NQ-PERP', direction: 'long', units: 20000, entryPrice: 26950, openedAt: at(15, 5, 19), liquidationPrice: 26790, leverage: 10 },
  status: { positionId: 'pos_syn_1', asOf: statusAsOf, mark: 27062, pnlUsd: 83, failPrice: 26790, distancePts: 272, distancePct: 1.01, status: 'Thin', atr1m: 6, nextLockOrSnapshot: null, catalystInWindow: { id: 'cat_cpi', name: 'CPI', at: at(8, 30), tier: 1 }, line: '' },
  ticket: syntheticTicket(),
});

const rules = (id: string): AccountRules => ({
  id, firm: 'Synthetic Firm', program: 'Test', name: id, venue: 'cme', startingBalance: 50000, instruments: ['NQ', 'MNQ'],
  drawdown: { type: 'eod_trailing', amountUsd: 2000, pct: null, locksAtBalance: 50100, lockedFloor: null, includesOpenPnl: false, text: 'synthetic' },
  dailyLoss: null,
  payout: { capUsd: 2000, minUsd: 500, qualifyingDays: 5, qualifyingDayMinUsd: 150, cycleDays: null, consistencyPct: 40, maxPayouts: null, ladderUsd: null, bufferUsd: null, text: 'synthetic' },
  inactivityDays: 7, leverage: { caps: {}, eventCutText: null, maxContracts: 4 }, session: { flattenByET: '16:59', weekendLock: null },
  prohibited: [], markDivergencePts: null, firmRisk: [], claimPromptGainPct: null, source: { urls: [], asOf: '2026-11-19', origin: 'synthetic rules' },
});
export const syntheticAccount = (id = 'apex-50k'): AccountRow => ({
  rules: rules(id),
  state: { accountId: id, asOf: at(17, 0, 19), active: true, balance: 51240, equity: 51240, highWaterBalance: 51240, dayStartBalance: 50900, dayPnl: 340, cyclePnl: 1240, bestDayPnlInCycle: 520, qualifyingDaysInCycle: 3, cycleStartedAt: at(9, 30, 10), payoutsTaken: 0, lastTradeAt: at(14, 0, 19) },
  floorUsd: 49240, roomUsd: 2000, payoutLine: 'Payout: 3 of 5 qualifying days', consistencyLine: 'Best day $520 is 42% of the cycle; cap is 40%', nextDeadline: { what: 'payout window opens', at: at(9, 30, 24) }, claimableUsd: 740,
});

export const syntheticHeadline = (id: string, impact: number, title: string, ts = at(5, 12)): Headline =>
  ({ id, ts, source: 'synthetic wire', title, category: 'macro', impact, direction: -1, symbols: ['NQ'], classifier: 'rules', dedupeKey: id });

export const syntheticLedger: OverrideLedger = { monthToDateUsd: -1240, instances: 5, lastPaidAt: at(11, 0, 18), planCapturePct: 68, overrideCapturePct: 41 };

export const syntheticQuotes = (): Record<string, Quote> => Object.fromEntries([
  syntheticQuote('N225', 50120, 49720), syntheticQuote('HSI', 25890, 26010), syntheticQuote('DAX', 23410, 23380), syntheticQuote('FTSE', 9620, 9655),
  syntheticQuote('DXY', 99.8, 99.6), syntheticQuote('CL', 61.2, 61.9), syntheticQuote('BTC', 91400, 90950), syntheticQuote('VIX', 18.4, 18.9), syntheticQuote('NQ', 27062, 26950),
].map((q) => [q.symbol, q]));

export const syntheticMorning = (over: Partial<MorningCtx> = {}): MorningCtx => ({
  now: NOW, profile: syntheticProfile(), calls: [syntheticCall()], quotes: syntheticQuotes(), rates: syntheticRates(), catalysts: [syntheticCatalyst()],
  positions: [syntheticPosition()], tickets: [], accounts: [syntheticAccount()], ruleDiffs: [],
  headlines: [syntheticHeadline('h1', 3, 'Synthetic: Fed speaker pushes back on cuts'), syntheticHeadline('h2', 2, 'Synthetic: chip export rule floated'), syntheticHeadline('h3', 1, 'Synthetic: oil inventory draw'), syntheticHeadline('h4', 1, 'Synthetic: minor headline', at(4, 0))],
  ...over,
});
export const emptyMorning = (): MorningCtx => ({ now: NOW, profile: syntheticProfile(), calls: [], quotes: {}, rates: null, catalysts: [], positions: [], tickets: [], accounts: [], ruleDiffs: [], headlines: [] });

export const syntheticAsk = (over: Partial<AskCtx> = {}): AskCtx => {
  const m = syntheticMorning();
  return { now: NOW + 4 * HOUR, profile: m.profile, calls: m.calls, rates: syntheticRates({ y10: st(4.94, iso(NOW + HOUR), true) }), quotes: Object.fromEntries(Object.entries(m.quotes).map(([k, q]) => [k, { ...q, asOf: iso(NOW + 4 * HOUR - MIN) }])), catalysts: [syntheticCatalyst({ id: 'cat_pce', code: 'PCE', name: 'PCE', scheduledAt: at(8, 30, 25) })], positions: [syntheticPosition(iso(NOW + 4 * HOUR - MIN))], accounts: m.accounts, headlines: m.headlines, ledger: syntheticLedger, journalAsOf: at(17, 0, 19), structure: [], memoryHits: [], ...over };
};
