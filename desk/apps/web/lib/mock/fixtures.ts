/**
 * DESK_MOCK_FIXTURES: invented data for development and UI verification only.
 * Nothing here is a market fact. The build script fails a production build that contains this marker.
 * Every object is typed with the contract types, so contract drift fails typecheck.
 */
import type {
  AccountRow, AccountRules, AccountState, BaseRate, BiasCall, Brief, Candle, Catalyst, ChatMessage, GuardrailFiring,
  HistoricalReaction, JournalNote, JournalView, Notification, NowView, OverrideLedger, Position, PositionRow, PositionsView,
  Profile, ScenarioBranch, SizingResult, StructureEvent, Ticket, Timeframe, TradePlan, WatcherUpdate,
} from '@desk/contracts';

export const MOCK_MARKER = 'DESK_MOCK_FIXTURES';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const SRC = 'mock';
const at = (now: number, offsetMs: number): string => new Date(now + offsetMs).toISOString();
const NQ = 27_062;

function plan(now: number, p: Partial<TradePlan> & Pick<TradePlan, 'direction' | 'targets' | 'invalidation'>): TradePlan {
  return {
    instrument: 'NQ-PERP', referencePrice: NQ, accountId: 'vest-instant',
    entry: { kind: 'condition', text: 'Second move after 08:45 ET if the 10Y confirms' },
    timeStop: { at: at(now, 3 * HOUR), text: 'Flat by 15:30 ET' },
    ...p,
  };
}

const shortPlan = (now: number): TradePlan => plan(now, {
  direction: 'short',
  entry: { kind: 'price', text: 'Rejection at 27,130, the 50% retrace of the 17:00 drop', price: 27_130 },
  targets: [{ price: 27_000, fraction: 1 / 3 }, { price: 26_920, fraction: 1 / 3 }, { price: 26_810, fraction: 1 / 3 }],
  invalidation: { price: 27_215, reason: 'Reclaims the after-hours high with chips leading' },
  size: { units: 60_000, notionalUsd: 60_000, leverage: 12, failPrice: 27_340 },
});

export function biasCalls(now: number): BiasCall[] {
  const base = {
    horizon: 'intraday' as const, score: -0.74, createdAt: at(now, -42 * MIN), firstMoveUntrusted: false,
    referencePrice: NQ, inputs: { mock: true }, outcome: null,
  };
  return [
    {
      ...base, id: 'call_nq_intraday', instrument: 'NQ', call: 'lean_short', probability: 0.62,
      factors: [
        { factor: 'rates', score: -1.2, weight: 0.2, evidence: '10Y +9 bp to 4.95% in 1h', asOf: at(now, -4 * MIN), stale: false },
        { factor: 'structure', score: -1, weight: 0.1, evidence: 'Bounce stalled at 46% of the 17:00 drop', asOf: at(now, -2 * MIN), stale: false },
        { factor: 'breadth', score: -0.6, weight: 0.1, evidence: 'SOX −1.4% vs NQ −0.4%', asOf: at(now, -3 * MIN), stale: false },
      ],
      facts: ['10Y +9 bp to 4.95% in the last hour', 'Bounce stalled at 46% of the 17:00 drop; ES lower highs', 'SOX −1.4% while NQ is −0.4%: chips lead down'],
      trade: shortPlan(now),
      killCondition: { text: '15m close above 27,215 with SOX green', level: 27_215, side: 'above' },
      nextCatalyst: { id: 'cat_cpi', name: 'CPI (Oct)', at: at(now, 18 * HOUR + 14 * MIN) },
      expiresAt: at(now, 3 * HOUR + 12 * MIN), trigger: { kind: 'level', ref: 'ev_retrace_stall' },
    },
    {
      ...base, id: 'call_nq_swing', instrument: 'NQ', horizon: 'swing', call: 'no_edge', probability: 0.5, score: -0.1,
      factors: [], facts: ['CPI in 18h decides the week', 'Hike odds 31%, up from 22% a week ago', 'Daily below a falling 50 EMA'],
      trade: null, killCondition: { text: 'CPI print resolves a branch' },
      nextCatalyst: { id: 'cat_cpi', name: 'CPI (Oct)', at: at(now, 18 * HOUR + 14 * MIN) },
      expiresAt: at(now, 18 * HOUR + 14 * MIN), trigger: { kind: 'initial', ref: 'open' },
    },
    {
      ...base, id: 'call_nvda_swing', instrument: 'NVDA', horizon: 'swing', call: 'lean_short', probability: 0.57, score: -0.5,
      factors: [], facts: ['3 of the last 4 prints faded', 'Implied move 7.8%', 'SOX below its 50 EMA'],
      trade: null, killCondition: { text: 'Closes above the pre-print high after the guide' },
      nextCatalyst: { id: 'cat_nvda', name: 'NVDA earnings', at: at(now, 3 * DAY + 5 * HOUR) },
      expiresAt: at(now, 3 * DAY + 5 * HOUR), trigger: { kind: 'initial', ref: 'open' },
    },
  ];
}

export function updates(now: number): WatcherUpdate[] {
  const u = (id: string, mins: number, text: string, severity = 1, positionIds: string[] = []): WatcherUpdate => ({
    id, ts: at(now, -mins * MIN), instrument: 'NQ', text, eventIds: [], dedupeKey: id, severity,
    touches: { positionIds, ticketIds: [], biasKill: false },
  });
  return [
    u('upd_5', 1, 'NQ 27,062, lost the 1m EMA at 27,081; bounce now 46% of the 17:00 drop. ES still lower highs. Call unchanged: Lean short, 0.62, expires 15:30 ET. Third off at 27,000 per ticket.', 2, ['pos_vest_nq']),
    u('upd_4', 9, 'NQ 27,118 spike, rejected in 3 minutes, volume 58% of the 17:00 impulse. Covering, not accumulation.', 2),
    u('upd_3', 22, '10Y 4.95%, +9 bp in 1h, through the 4.94 level. Rates read confirms the short side.'),
    u('upd_2', 37, 'SOX −1.4% vs NQ −0.4%. Chips lead down; rotation is not broadening.'),
    u('upd_1', 58, 'NQ 27,010 swept the overnight low at 27,004 and closed back inside on the 1m. No MSS yet.'),
  ];
}

const stamped = (now: number, value: number, mins: number, stale = false) =>
  ({ value, asOf: at(now, -mins * MIN), source: SRC, stale, age: mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m` });

export function nowView(now: number, s: MockState): NowView {
  const calls = biasCalls(now);
  const q = (symbol: string, price: number, changePct: number, mins = 1, stale = false) =>
    [symbol, { symbol, price, prevClose: price / (1 + changePct / 100), changePct, asOf: at(now, -mins * MIN), source: SRC, cadenceSec: 60, stale, age: `${mins}m` }] as const;
  const cpi = catalysts(now).find((c) => c.id === 'cat_cpi')!;
  return {
    asOf: at(now, 0), primary: calls[0]!, calls, updates: updates(now),
    rates: {
      y2: stamped(now, 4.61, 4), y10: stamped(now, 4.95, 4), y30: stamped(now, 5.08, 4),
      y2Chg1hBp: 6, y10Chg1hBp: 9, y2Chg1dBp: 11, y10Chg1dBp: 13, spread2s10sBp: 34,
      fed: { hike: stamped(now, 0.31, 190, true), cut: stamped(now, 0.04, 190, true), hold: stamped(now, 0.65, 190, true), meeting: at(now, 19 * DAY) },
    },
    quotes: Object.fromEntries([q('NQ', NQ, -0.41), q('ES', 6_788.5, -0.22), q('SOX', 6_412.3, -1.38), q('VIX', 21.4, 6.2), q('NVDA', 181.22, -1.9), q('DXY', 104.82, 0.31, 34, true)]),
    nextCatalyst: { id: cpi.id, name: cpi.name, tier: cpi.tier, scheduledAt: cpi.scheduledAt, consensus: cpi.consensus, prior: cpi.prior, unit: cpi.unit },
    headlines: [
      { id: 'h1', ts: at(now, -12 * MIN), source: SRC, title: 'Fed governor: “not ruling out” a further hike if services inflation persists', category: 'fed', impact: 2, direction: -1, symbols: ['NQ'], classifier: 'rules', dedupeKey: 'h1' },
      { id: 'h2', ts: at(now, -51 * MIN), source: SRC, title: 'PPI final demand +0.4% m/m vs +0.2% expected', category: 'macro', impact: 3, direction: -1, symbols: ['NQ', 'ES'], classifier: 'rules', dedupeKey: 'h2' },
      { id: 'h3', ts: at(now, -3 * HOUR), source: SRC, title: 'Chip export licence review widened to two more suppliers', category: 'geopolitical', impact: 2, direction: -1, symbols: ['NVDA', 'SOX'], classifier: 'rules', dedupeKey: 'h3' },
    ],
    session: { killSwitch: s.killSwitch, readOnly: false, readOnlyReason: null, quietHours: false },
    feedHealth: [
      { feed: 'prices', ok: true, lastOk: at(now, -1 * MIN), error: null, live: true },
      { feed: 'rates', ok: true, lastOk: at(now, -4 * MIN), error: null, live: true },
      { feed: 'calendar', ok: true, lastOk: at(now, -3 * HOUR), error: null, live: true },
      { feed: 'headlines', ok: true, lastOk: at(now, -2 * MIN), error: null, live: true },
      { feed: 'fedwatch', ok: false, lastOk: at(now, -190 * MIN), error: 'HTTP 429', live: true },
      { feed: 'prediction-markets', ok: true, lastOk: at(now, -3 * MIN), error: null, live: true },
    ],
  };
}

function branch(now: number, id: string, label: string, lo: number | null, hi: number | null, probability: number,
  rates: [number, number, string], index: [number, number, number, string], secondOrder: string, trade: TradePlan | null, noTradeReason?: string): ScenarioBranch {
  void now;
  return {
    id, label, match: { metric: 'core_cpi_mom', lo, hi }, probability, probabilitySource: 'prediction_market',
    ratesRead: { y2Bp: rates[0], y10Bp: rates[1], text: rates[2] },
    indexRead: { m15Pct: index[0], h1Pct: index[1], closePct: index[2], text: index[3] },
    secondOrder, trade, noTradeReason,
  };
}

const reactions: HistoricalReaction[] = [
  { date: '2026-10-14', actual: 0.3, consensus: 0.3, surprise: 0, m5Pct: -0.21, h1Pct: 0.34, closePct: 0.62, firstMoveReversed: true },
  { date: '2026-09-11', actual: 0.4, consensus: 0.3, surprise: 0.1, m5Pct: -0.88, h1Pct: -1.12, closePct: -1.41, firstMoveReversed: false },
  { date: '2026-08-12', actual: 0.2, consensus: 0.3, surprise: -0.1, m5Pct: 0.71, h1Pct: 0.94, closePct: 1.18, firstMoveReversed: false },
  { date: '2026-07-14', actual: 0.3, consensus: 0.3, surprise: 0, m5Pct: 0.18, h1Pct: -0.22, closePct: -0.05, firstMoveReversed: true },
  { date: '2026-06-10', actual: 0.3, consensus: 0.2, surprise: 0.1, m5Pct: -0.64, h1Pct: -0.41, closePct: 0.12, firstMoveReversed: true },
  { date: '2026-05-12', actual: 0.2, consensus: 0.2, surprise: 0, m5Pct: 0.09, h1Pct: 0.27, closePct: 0.44, firstMoveReversed: false },
];

export function catalysts(now: number): Catalyst[] {
  const cpiAt = 18 * HOUR + 14 * MIN;
  const cpiLong = plan(now, {
    direction: 'long', entry: { kind: 'condition', text: 'Second move after 08:45 ET if the 10Y holds below 4.90%' },
    targets: [{ price: 27_240, fraction: 1 / 3 }, { price: 27_380, fraction: 1 / 3 }, { price: 27_520, fraction: 1 / 3 }],
    invalidation: { price: 26_950, reason: 'Loses the pre-print low with yields back up' },
    timeStop: { at: at(now, cpiAt + 7 * HOUR), text: 'Flat by 15:30 ET' },
    size: { units: 45_000, notionalUsd: 45_000, leverage: 9, failPrice: 26_340 },
  });
  const cpiShort = plan(now, {
    direction: 'short', entry: { kind: 'condition', text: 'Second move after 08:45 ET if the 10Y holds above 5.00%' },
    targets: [{ price: 26_880, fraction: 1 / 3 }, { price: 26_740, fraction: 1 / 3 }, { price: 26_600, fraction: 1 / 3 }],
    invalidation: { price: 27_180, reason: 'Reclaims the pre-print high with yields fading' },
    timeStop: { at: at(now, cpiAt + 7 * HOUR), text: 'Flat by 15:30 ET' },
    size: { units: 45_000, notionalUsd: 45_000, leverage: 9, failPrice: 27_790 },
  });
  const cat = (c: Partial<Catalyst> & Pick<Catalyst, 'id' | 'code' | 'name' | 'tier' | 'scheduledAt'>): Catalyst => ({
    instruments: ['NQ', 'ES'], consensus: null, prior: null, whisper: null, impliedMovePct: null, impliedMoveSource: null,
    history: [], predictionOdds: [], matrix: null, status: 'upcoming', resolution: null, reaction: null, source: SRC, asOf: at(now, -20 * MIN), ...c,
  });
  return [
    cat({
      id: 'cat_ppi', code: 'PPI', name: 'PPI (Oct)', tier: 1, scheduledAt: at(now, -6 * MIN), consensus: 0.2, prior: 0.1, unit: '% m/m',
      impliedMovePct: 0.9, impliedMoveSource: 'historical', status: 'resolved', history: reactions.slice(0, 4),
      resolution: { actual: 0.4, branchId: 'ppi_hot', resolvedAt: at(now, -6 * MIN + 8_000) },
      reaction: { m5Pct: -0.52, m15Pct: null, verdict: 'normal', text: '5m −0.52% vs median −0.61% on a hot print: normal. 15m reading at 08:45 ET.' },
      matrix: {
        catalystId: 'cat_ppi', generatedAt: at(now, -14 * HOUR), referencePrice: 27_190, inputs: { mock: true },
        regimeNotes: ['First move trades the headline, second move trades yields.'],
        whatIWouldDo: 'Hot branch matched. Short the second move if the 10Y holds above 4.94%; third off at 27,000.',
        branches: [
          { ...branch(now, 'ppi_cool', '≤ 0.1', null, 0.15, 0.22, [-6, -5, '2Y −6 bp, 10Y −5 bp'], [0.5, 0.7, 0.8, 'Bid into the open'], 'Cool PPI the day before CPI pulls hike odds down.', null, 'No edge until CPI'), match: { metric: 'ppi_mom', lo: null, hi: 0.15 } },
          { ...branch(now, 'ppi_inline', '0.2', 0.15, 0.25, 0.41, [0, 0, 'Flat'], [0, 0.1, 0.1, 'Fades to unchanged'], 'In line: the market waits for CPI.', null, 'No edge, stand aside until CPI'), match: { metric: 'ppi_mom', lo: 0.15, hi: 0.25 } },
          { ...branch(now, 'ppi_hot', '≥ 0.3', 0.25, null, 0.37, [7, 9, '2Y +7 bp, 10Y +9 bp through 4.94%'], [-0.5, -0.7, -0.9, 'Sold, bounces fail under the 50% retrace'], 'Hot PPI with hike odds at 31% is the bear branch.', shortPlan(now)), match: { metric: 'ppi_mom', lo: 0.25, hi: null } },
        ],
      },
    }),
    cat({
      id: 'cat_cpi', code: 'CPI', name: 'CPI (Oct)', tier: 1, scheduledAt: at(now, cpiAt), consensus: 0.3, prior: 0.3, whisper: 0.3, unit: '% core m/m',
      impliedMovePct: 1.3, impliedMoveSource: 'options', history: reactions,
      predictionOdds: [{
        id: 'pm_cpi', venue: 'kalshi', title: 'Core CPI m/m (Oct)', eventCode: 'CPI', asOf: at(now, -3 * MIN), volume: 412_000,
        outcomes: [{ label: '≤ 0.1%', prob: 0.07 }, { label: '0.2%', prob: 0.27 }, { label: '0.3%', prob: 0.44 }, { label: '≥ 0.4%', prob: 0.22 }],
      }],
      matrix: {
        catalystId: 'cat_cpi', generatedAt: at(now, -5 * HOUR), referencePrice: NQ, inputs: { mock: true },
        regimeNotes: ['First move trades the headline, second move trades yields.', 'Hot core with hike odds at 31% is bearish; a 0.2 is the squeeze branch.'],
        whatIWouldDo: 'Flat into the print. Trade the second move with the 10Y: long on 0.2 or lower, short on 0.4 or higher, nothing on 0.3.',
        branches: [
          branch(now, 'cpi_a', '≤ 0.1', null, 0.15, 0.07, [-12, -10, '2Y −12 bp, 10Y −10 bp'], [0.9, 1.3, 1.6, 'Gap and go'], 'Hike odds collapse; squeeze through 27,380.', cpiLong),
          branch(now, 'cpi_b', '0.2', 0.15, 0.25, 0.27, [-7, -6, '2Y −7 bp, 10Y −6 bp'], [0.6, 0.9, 1.1, 'Squeeze branch'], 'A 0.2 with hike odds at 31% is the squeeze.', cpiLong),
          branch(now, 'cpi_c', '0.3', 0.25, 0.35, 0.44, [1, 1, 'Flat to +1 bp'], [-0.1, 0.1, 0, 'Whipsaw, no trend'], 'In line: the first move reverses 2 of the last 3.', null, 'No edge, stand aside until 09:15 ET'),
          branch(now, 'cpi_d', '≥ 0.4', 0.35, null, 0.22, [10, 9, '2Y +10 bp, 10Y +9 bp through 5.00%'], [-0.9, -1.2, -1.4, 'Trend day down'], 'Hot core through 5.00% on the 10Y: sell bounces.', cpiShort),
        ],
      },
    }),
    cat({ id: 'cat_claims', code: 'CLAIMS', name: 'Initial jobless claims', tier: 2, scheduledAt: at(now, 2 * DAY + 2 * HOUR), consensus: 224, prior: 219, unit: 'K' }),
    cat({ id: 'cat_auction', code: 'TREASURY_AUCTION', name: '10Y note auction', tier: 2, scheduledAt: at(now, 2 * DAY + 6 * HOUR + 30 * MIN) }),
    cat({ id: 'cat_nvda', code: 'EARNINGS', name: 'NVDA earnings', tier: 1, scheduledAt: at(now, 3 * DAY + 5 * HOUR), symbol: 'NVDA', instruments: ['NVDA', 'NQ', 'SOX'], impliedMovePct: 7.8, impliedMoveSource: 'options' }),
    cat({ id: 'cat_umich', code: 'OTHER', name: 'UMich sentiment (prelim)', tier: 3, scheduledAt: at(now, 4 * DAY + 3 * HOUR), consensus: 68.4, prior: 67.9 }),
    cat({ id: 'cat_retail', code: 'RETAIL_SALES', name: 'Retail sales (Oct)', tier: 2, scheduledAt: at(now, 5 * DAY + 2 * HOUR), consensus: 0.3, prior: 0.5, unit: '% m/m' }),
  ];
}

const rules = (r: Pick<AccountRules, 'id' | 'firm' | 'program' | 'name' | 'venue' | 'startingBalance' | 'instruments' | 'drawdown' | 'dailyLoss' | 'payout'>): AccountRules => ({
  inactivityDays: r.venue === 'cme' ? 7 : null,
  leverage: { caps: r.venue === 'perp' ? { 'NQ-PERP': 50 } : {}, eventCutText: null, maxContracts: r.venue === 'cme' ? 5 : null },
  session: { flattenByET: r.venue === 'cme' ? '16:00' : null, weekendLock: r.venue === 'perp' ? { fromET: 'Fri 20:00', toET: 'Sun 18:00', text: 'Non-crypto markets lock Fri 20:00 ET to Sun 18:00 ET' } : null },
  prohibited: [{ rule: 'cross_account_hedging', clause: 'Coordinating accounts, including opposite positions, is prohibited.' }],
  markDivergencePts: r.venue === 'perp' ? [10, 40] : null, firmRisk: [], claimPromptGainPct: r.venue === 'perp' ? 25 : null,
  source: { urls: [], asOf: '2026-11-21', origin: 'mock fixture' }, ...r,
});

export function accountRows(now: number, s: MockState): AccountRow[] {
  const state = (accountId: string, balance: number, x: Partial<AccountState> = {}): AccountState => ({
    accountId, asOf: at(now, -2 * MIN), active: true, balance, equity: balance, highWaterBalance: balance, dayStartBalance: balance, dayPnl: 0,
    cyclePnl: 0, bestDayPnlInCycle: 0, qualifyingDaysInCycle: 0, cycleStartedAt: at(now, -6 * DAY), payoutsTaken: 0, lastTradeAt: at(now, -1 * DAY),
    ...x, ...(s.balances[accountId] !== undefined ? { balance: s.balances[accountId]!, equity: s.balances[accountId]! } : {}),
  });
  const noPayout = { capUsd: null, minUsd: null, qualifyingDays: null, qualifyingDayMinUsd: null, cycleDays: null, consistencyPct: null, maxPayouts: null, ladderUsd: null, bufferUsd: null };
  return [
    {
      rules: rules({
        id: 'vest-instant', firm: 'Vest Markets', program: 'Instant', name: 'Vest Instant 5K', venue: 'perp', startingBalance: 5_000, instruments: ['NQ-PERP', 'NVDA', 'BTC', 'ETH'],
        drawdown: { type: 'static', amountUsd: null, pct: 6, locksAtBalance: null, lockedFloor: null, includesOpenPnl: true, text: 'Static 6% from start, equity-based incl. open P&L' },
        dailyLoss: { amountUsd: null, pctOfSnapshot: 3, snapshotET: '20:00', hardBreach: true, text: '3% of the 20:00 ET balance snapshot, hard breach' },
        payout: { ...noPayout, text: 'No cap, no schedule, claim anytime' },
      }),
      state: state('vest-instant', 5_412, { equity: 5_503, dayStartBalance: 5_320, dayPnl: 183, cyclePnl: 412, bestDayPnlInCycle: 229 }),
      floorUsd: 4_700, roomUsd: 803, payoutLine: '$412 claimable now. Claim often, withdraw same day.', consistencyLine: null,
      nextDeadline: { what: 'Daily-loss snapshot', at: at(now, 6 * HOUR) }, claimableUsd: 412,
    },
    {
      rules: rules({
        id: 'vest-eval', firm: 'Vest Markets', program: 'Evaluation', name: 'Vest Eval 10K', venue: 'perp', startingBalance: 10_000, instruments: ['NQ-PERP', 'NVDA', 'BTC', 'ETH'],
        drawdown: { type: 'static', amountUsd: null, pct: 6, locksAtBalance: null, lockedFloor: null, includesOpenPnl: true, text: 'Static 6% from start, equity-based incl. open P&L' },
        dailyLoss: { amountUsd: null, pctOfSnapshot: 3, snapshotET: '20:00', hardBreach: true, text: '3% of the 20:00 ET balance snapshot, hard breach' },
        payout: { ...noPayout, text: 'Evaluation: no payout until funded' },
      }),
      state: state('vest-eval', 10_180, { equity: 10_096, dayPnl: -84 }),
      floorUsd: 9_400, roomUsd: 696, payoutLine: 'Evaluation: +$620 to target.', consistencyLine: null,
      nextDeadline: { what: 'Weekend lock', at: at(now, 2 * DAY + 4 * HOUR) }, claimableUsd: null,
    },
    {
      rules: rules({
        id: 'mffu-builder-50k', firm: 'MyFundedFutures', program: 'Builder', name: 'MFFU Builder 50K', venue: 'cme', startingBalance: 50_000, instruments: ['NQ', 'MNQ', 'ES'],
        drawdown: { type: 'eod_trailing', amountUsd: 2_000, pct: null, locksAtBalance: 50_100, lockedFloor: null, includesOpenPnl: false, text: 'EOD trailing $2,000, locks at +$100' },
        dailyLoss: { amountUsd: 1_000, pctOfSnapshot: null, snapshotET: null, hardBreach: false, text: '$1,000 daily loss limit' },
        payout: { ...noPayout, capUsd: 2_000, qualifyingDays: 2, consistencyPct: 50, bufferUsd: 2_100, text: '$2,000 per cycle, 2 qualifying days, 50% consistency' },
      }),
      state: state('mffu-builder-50k', 51_640, { highWaterBalance: 51_640, dayPnl: 310, cyclePnl: 1_640, bestDayPnlInCycle: 950, qualifyingDaysInCycle: 1 }),
      floorUsd: 50_100, roomUsd: 1_540, payoutLine: '1 of 2 qualifying days. $0 above the $2,100 buffer yet.',
      consistencyLine: 'Best day $950 is 58% of this cycle; cap is 50%. Request after one more green day.',
      nextDeadline: { what: 'Inactivity: trade by', at: at(now, 5 * DAY + 3 * HOUR) }, claimableUsd: 0,
    },
  ];
}

const POSITIONS: Array<{ p: Omit<Position, 'openedAt'>; openedMin: number; mark: number; pnl: number; fail: number; pts: number; pct: number; status: 'Safe' | 'Thin' | 'Critical'; line: string }> = [
  { p: { id: 'pos_vest_nq', accountId: 'vest-instant', ticketId: 'tkt_open', instrument: 'NQ-PERP', direction: 'short', units: 60_000, entryPrice: 27_128, liquidationPrice: 27_340, leverage: 12 }, openedMin: 34, mark: NQ, pnl: 146, fail: 27_340, pts: 278, pct: 1.03, status: 'Thin', line: 'Fail 27,340 is 278 pts (1.03%) away; the 1m ATR is 31. Thin into CPI.' },
  { p: { id: 'pos_vest_nvda', accountId: 'vest-eval', ticketId: null, instrument: 'NVDA', direction: 'long', units: 8_000, entryPrice: 183.1, liquidationPrice: 168.4, leverage: 4 }, openedMin: 190, mark: 181.22, pnl: -82, fail: 168.4, pts: 12.82, pct: 7.07, status: 'Safe', line: 'Fail 168.40 is 7.07% away. No ticket: untracked.' },
  { p: { id: 'pos_mffu_mnq', accountId: 'mffu-builder-50k', ticketId: null, instrument: 'MNQ', direction: 'short', units: 2, entryPrice: 27_140, liquidationPrice: null, leverage: null }, openedMin: 21, mark: NQ, pnl: 312, fail: 27_525, pts: 463, pct: 1.71, status: 'Safe', line: 'Fail 27,525 is 463 pts (1.71%) away. Flatten by 16:00 ET.' },
];

export const mockSizing = (now: number, accountId: string, instrument: string, direction: 'long' | 'short'): SizingResult => {
  const perp = accountId.startsWith('vest');
  const maxUnits = perp ? (accountId === 'vest-eval' ? 52_000 : 60_000) : instrument === 'MNQ' ? 4 : 1;
  const notionalUsd = perp ? maxUnits : maxUnits * (instrument === 'MNQ' ? 2 : instrument === 'ES' ? 50 : 20) * NQ;
  const pts = perp ? 278 : 380;
  return {
    accountId, instrument, direction, asOf: at(now, 0), blocked: false, blockReason: null,
    maxUnits, notionalUsd, leverage: perp ? 12 : null,
    failPrice: direction === 'long' ? NQ - pts : NQ + pts, failDistancePts: pts, failDistancePct: Math.round((pts / NQ) * 10_000) / 100,
    worstMove: { pct: 0.82, pts: 222, basis: 'p95_window', text: '95th-percentile 3h move over the last 60 sessions: 0.82% (222 pts)' },
    room: { toDrawdownUsd: perp ? 803 : 1_540, toDailyLimitUsd: perp ? 615 : 1_000, usableUsd: perp ? 492 : 800, cushionPct: 20, binding: 'daily_limit' },
    catalystInWindow: null, notes: perp ? ['Vest marks have diverged 10 to 40 pts from CME; the 20% cushion covers it.'] : ['Flatten by 16:00 ET.'],
    payoutNote: perp ? null : 'A +$950 day today keeps your best day at 58% of this cycle; request after one more green day.',
    inputs: { mock: true },
  };
};

export function ledger(now: number): OverrideLedger {
  return { monthToDateUsd: -6_400, instances: 7, lastPaidAt: at(now, -15 * DAY), planCapturePct: 61, overrideCapturePct: 23 };
}

export function tickets(now: number): Ticket[] {
  const p = shortPlan(now);
  const base = {
    accountId: 'vest-instant', instrument: 'NQ-PERP', direction: 'short' as const, entry: p.entry, targets: p.targets, invalidation: p.invalidation,
    holdThroughCatalyst: { flag: false, catalystId: null }, watcherEventIds: [], sizingSnapshot: null,
  };
  return [
    {
      ...base, id: 'tkt_open', createdAt: at(now, -70 * MIN), reason: { kind: 'catalyst', catalystId: 'cat_ppi', branchId: 'ppi_hot' },
      size: { engineMaxUnits: 60_000, units: 60_000, notionalUsd: 60_000, leverage: 12, failPrice: 27_340 }, timeStop: at(now, 3 * HOUR),
      status: 'open', fills: [{ ts: at(now, -34 * MIN), price: 27_128, units: 60_000, kind: 'entry', source: 'manual' }], overrides: [], closedAt: null, result: null,
      sizingSnapshot: mockSizing(now, 'vest-instant', 'NQ-PERP', 'short'),
    },
    {
      ...base, id: 'tkt_c1', createdAt: at(now, -2 * DAY), reason: { kind: 'structure', setupEventId: 'ev_sweep' },
      size: { engineMaxUnits: 55_000, units: 55_000, notionalUsd: 55_000, leverage: 11, failPrice: 27_610 }, timeStop: at(now, -2 * DAY + 5 * HOUR),
      status: 'closed', fills: [], overrides: [], closedAt: at(now, -2 * DAY + 3 * HOUR),
      result: { pnlUsd: 388, exitPrice: 26_958, adherence: 100, deductions: [], mfeAfterExitPct: 0.31, maeAfterExitPct: -0.44, capturePct: 64, followedPlan: true },
    },
    {
      ...base, id: 'tkt_c2', createdAt: at(now, -4 * DAY), direction: 'long', reason: { kind: 'catalyst', catalystId: 'cat_fomc_minutes' },
      size: { engineMaxUnits: 40_000, units: 40_000, notionalUsd: 40_000, leverage: 8, failPrice: 26_480 }, timeStop: at(now, -4 * DAY + 4 * HOUR),
      status: 'closed', fills: [], overrides: [{ ts: at(now, -4 * DAY + 4 * HOUR), kind: 'held_through_time_stop', reason: 'Wanted the close', pnlImpactUsd: -212 }], closedAt: at(now, -4 * DAY + 6 * HOUR),
      result: { pnlUsd: -96, exitPrice: 27_004, adherence: 80, deductions: [{ kind: 'held_through_time_stop', points: 20 }], mfeAfterExitPct: 0.12, maeAfterExitPct: -0.71, capturePct: 18, followedPlan: false },
    },
  ];
}

export function positionsView(now: number, s: MockState): PositionsView {
  const tk = tickets(now)[0]!;
  const rows: PositionRow[] = [
    ...POSITIONS.filter((x) => !s.removed.has(x.p.id)).map((x): PositionRow => ({
      position: { ...x.p, openedAt: at(now, -x.openedMin * MIN) },
      status: {
        positionId: x.p.id, asOf: at(now, -1 * MIN), mark: x.mark, pnlUsd: x.pnl, failPrice: x.fail, distancePts: x.pts, distancePct: x.pct, status: x.status, atr1m: 31,
        nextLockOrSnapshot: x.p.accountId.startsWith('vest') ? { what: 'Daily-loss snapshot', at: at(now, 6 * HOUR) } : { what: 'Flatten', at: at(now, 4 * HOUR) },
        catalystInWindow: x.p.id === 'pos_vest_nq' ? { id: 'cat_cpi', name: 'CPI (Oct)', at: at(now, 18 * HOUR + 14 * MIN), tier: 1 } : null, line: x.line,
      },
      ticket: x.p.ticketId ? tk : null, nextTarget: x.p.ticketId ? { price: 27_000, fraction: 1 / 3 } : null,
    })),
    ...s.manual.map((position): PositionRow => ({ position, status: null, ticket: null, nextTarget: null })),
  ];
  const hedge = rows.some((r) => r.position.id === 'pos_vest_nq') && rows.some((r) => r.position.id === 'pos_vest_nvda');
  return {
    asOf: at(now, 0), positions: rows, accounts: accountRows(now, s),
    hedgeViolations: hedge ? [{
      accountA: 'vest-instant', accountB: 'vest-eval', instrumentA: 'NQ-PERP', instrumentB: 'NVDA', correlation: 0.78,
      clause: 'Coordinating accounts, including opposite positions, is prohibited.',
      text: 'Short NQ-PERP on Vest Instant against long NVDA on Vest Eval, correlation 0.78. Vest reads that as coordinated accounts. Close one.',
    }] : [],
  };
}

export function firings(now: number): GuardrailFiring[] {
  const f = (id: string, pattern: GuardrailFiring['pattern'], days: number, text: string, action: 'complied' | 'overrode' | 'ignored', outcomeUsd: number): GuardrailFiring => ({
    id, ts: at(now, -days * DAY), pattern, episodeKey: id, text, blocks: false, effect: 'none', trigger: { kind: 'ticket', ref: 'tkt_c2' }, evidence: {}, followUp: { action, outcomeUsd },
  });
  return [
    f('gf_1', 'hold_the_winner', 4, 'Holding past the plan. Overrides are −$6,400 MTD across 7 instances. Plan says one-third off at 27,130; that is 40 points away.', 'overrode', -212),
    f('gf_2', 'size_creep', 6, 'Size is 2.1x your median after a +45% day. The engine’s survivable size is $40K. Confirm $40K or lower.', 'complied', 540),
    f('gf_3', 'bottom_call', 9, 'Flush was 19h ago. Confirmation day hasn’t printed. Quarter size until it does.', 'complied', 310),
  ];
}

export function journalView(now: number, s: MockState): JournalView {
  const bucket = (lo: number, hi: number, n: number, predicted: number, realized: number | null) => ({ lo, hi, n, predicted, realized });
  const br = (pattern: string, tf: Timeframe, n: number, hitRate: number, definition: string): BaseRate => ({ pattern, instrument: 'NQ', tf, windowDays: 90, n, hitRate, definition, asOf: at(now, -1 * DAY) });
  return {
    asOf: at(now, 0), adherence20: 86, adherenceCount: 20, pnl20Usd: 3_420,
    calibration: {
      source: 'replay', n: 212, updatedAt: at(now, -2 * DAY),
      buckets: [bucket(0.5, 0.55, 61, 0.52, 0.51), bucket(0.55, 0.6, 58, 0.57, 0.6), bucket(0.6, 0.65, 44, 0.62, 0.59), bucket(0.65, 0.7, 29, 0.67, 0.72), bucket(0.7, 0.75, 14, 0.72, 0.64), bucket(0.75, 0.8, 6, 0.77, 0.83), bucket(0.8, 0.85, 0, 0.82, null)],
    },
    ledger: ledger(now), trades: tickets(now), calls: biasCalls(now).map((c, i) => (i === 2 ? c : { ...c, id: `${c.id}_y`, createdAt: at(now, -(i + 1) * DAY), expiresAt: at(now, -(i + 1) * DAY + 5 * HOUR), outcome: { resolvedAt: at(now, -(i + 1) * DAY + 5 * HOUR), movePct: i === 0 ? -0.64 : 0.08, correct: i === 0 ? true : null } })),
    events: firings(now), notes: [...s.notes, { id: 'note_seed', ts: at(now, -30 * DAY), text: 'My best trades are catalyst plus timing.', tags: ['seed', 'edge'], source: 'seed' }],
    baseRates: [
      br('first_touch_rejection_200ema', '15m', 24, 0.71, 'First touch of a declining 200 EMA closes back below within 4 bars'),
      br('bounce_stalled_under_50', '15m', 31, 0.65, 'Bounce stalls under 50% of the prior leg, then takes the leg low'),
      br('sweep_reclaim_mss', '1m', 52, 0.58, 'Sweep and reclaim with MSS reaches 1R before the sweep extreme'),
    ],
    guardrailScorecard: [
      { pattern: 'hold_the_winner', fired: 6, complied: 2, overrode: 4, savedUsd: 880, costUsd: 3_900, retired: false },
      { pattern: 'size_creep', fired: 3, complied: 3, overrode: 0, savedUsd: 1_240, costUsd: 0, retired: false },
      { pattern: 'bottom_call', fired: 2, complied: 1, overrode: 1, savedUsd: 310, costUsd: 720, retired: false },
      { pattern: 'late_night_idea', fired: 4, complied: 4, overrode: 0, savedUsd: 0, costUsd: 0, retired: false },
    ],
  };
}

export function brief(now: number, kind: Brief['kind']): Brief {
  const sections: Record<Brief['kind'], Brief['sections']> = {
    morning: [
      { key: 'call', title: 'The call', lines: ['NQ: Lean short, 0.62, expires 15:30 ET.', '10Y +9 bp to 4.95%; bounce stalled at 46%; SOX −1.4%.'] },
      { key: 'overnight', title: 'Overnight', lines: ['Nikkei −0.8%, DAX −0.3%.', '10Y 4.95% (+9 bp), 2Y 4.61% (+6 bp).', 'DXY 104.82, WTI 81.40, BTC 91,200, VIX 21.4.'] },
      { key: 'catalysts', title: 'Catalysts today', lines: ['PPI 08:30 ET: consensus 0.2%, hot branch is the short.', 'CPI tomorrow 08:30 ET: implied move 1.3%.'] },
      { key: 'positions', title: 'Positions and tickets', lines: ['Vest Instant short NQ-PERP: Thin, fail 27,340. Third off at 27,000.'] },
      { key: 'accounts', title: 'Accounts', lines: ['Vest Instant: $412 claimable.', 'MFFU Builder: 1 of 2 qualifying days; best day 58%.'] },
      { key: 'one_thing', title: 'The one thing', lines: ['Short the second move after PPI if the 10Y holds above 4.94%. Otherwise no edge until CPI.'] },
      { key: 'reads', title: 'Reads', lines: ['[2] Fed governor keeps a hike on the table: hike odds 31%.'] },
    ],
    recap: [
      { key: 'call', title: 'The call', lines: ['Lean short NQ, 0.62. NQ closed −0.64%. Right.'] },
      { key: 'adherence', title: 'Adherence', lines: ['Day score 100. Rolling 20: 86.', 'Overrides −$6,400 MTD across 7 instances.'] },
      { key: 'tomorrow', title: 'Tomorrow', lines: ['CPI 08:30 ET, Tier 1. Flat into the print.'] },
    ],
    weekly: [
      { key: 'calibration', title: 'Calibration', lines: ['212 replay calls. The 0.70–0.75 bucket ran 64% on n=14: overconfident there.'] },
      { key: 'capture', title: 'Plan vs override', lines: ['Plan-following exits captured 61% of the available move; overrides captured 23%.'] },
      { key: 'guardrails', title: 'Guardrail scorecard', lines: ['Hold-the-winner fired 6, overrode 4, cost $3,900.', 'Size creep fired 3, complied 3, saved $1,240.'] },
      { key: 'best', title: 'Three best reads', lines: ['PPI hot branch short: +$388, plan followed.', 'Common thread: entry on the second move with the 10Y confirming.'] },
      { key: 'worst', title: 'Three worst reads', lines: ['FOMC minutes long held through the time stop: −$96.', 'Common thread: exits decided after the entry.'] },
      { key: 'next', title: 'Next week', lines: ['Tue CPI (Tier 1), Thu claims, Fri NVDA (Tier 1). No carries through either Tier 1 window.'] },
    ],
  };
  return {
    id: `brief_${kind}`, kind, ts: at(now, kind === 'morning' ? -4 * HOUR : -1 * DAY), forDay: at(now, 0).slice(0, 10), sections: sections[kind],
    citations: [{ label: '10Y 4.95%', source: SRC, asOf: at(now, -4 * HOUR) }, { label: 'NQ 27,062', source: SRC, asOf: at(now, -4 * HOUR) }], wordCount: 120,
  };
}

export function chatHistory(now: number): ChatMessage[] {
  return [
    { id: 'm1', ts: at(now, -50 * MIN), role: 'trader', text: 'up or down today?' },
    {
      id: 'm2', ts: at(now, -50 * MIN + 2_000), role: 'desk', asOf: at(now, -51 * MIN),
      text: 'Lean short NQ, 0.62, expires 15:30 ET. 10Y +9 bp to 4.95%, bounce stalled at 46%, SOX −1.4%. Kill: 15m close above 27,215 with SOX green.',
      citations: [{ label: '10Y 4.95%', source: SRC, asOf: at(now, -54 * MIN) }, { label: 'NQ 27,062', source: SRC, asOf: at(now, -51 * MIN) }],
    },
  ];
}

export function notifications(now: number): Notification[] {
  return [{
    id: 'ntf_ppi', class: 'P0', reason: 'tier1_resolved', instrument: 'NQ',
    lines: ['PPI 0.4% vs 0.2%. 10Y +9 bp to 4.95%.', 'Hot branch: Lean short NQ 0.62, entry on rejection at 27,130, T1 27,000.'],
    deepLink: '/ticket?prefill=ntf_ppi', ticketPrefill: { ...shortPlan(now), reason: { kind: 'catalyst', catalystId: 'cat_ppi', branchId: 'ppi_hot' } },
    dedupeKey: 'ppi', ts: at(now, -6 * MIN), decision: 'sent', suppressedBy: null, channels: ['webpush', 'feed'], tappedAt: null,
  }];
}

export function structureEvents(now: number): StructureEvent[] {
  const e = (id: string, detector: StructureEvent['detector'], kind: string, level: number, levelHi: number | null, bias: -1 | 0 | 1, text: string, confirmedSetup = false): StructureEvent => ({
    id, detector, kind, instrument: 'NQ', tf: '15m', ts: at(now, -90 * MIN), level, levelHi, bias, confidence: 0.7, text, data: {}, confirmedSetup,
  });
  return [
    e('ev_liq_hi', 'liquidity_pool', 'equal_highs', 27_215, null, 0, 'Equal highs 27,215: buy stops rest above'),
    e('ev_liq_lo', 'liquidity_pool', 'equal_lows', 26_920, null, 0, 'Equal lows 26,920: sell stops rest below'),
    e('ev_fvg', 'fvg', 'bearish_fvg', 27_120, 27_152, -1, 'Bearish FVG 27,120–27,152 from the 17:00 drop'),
    e('ev_ob', 'order_block', 'bearish_ob', 27_168, 27_196, -1, 'Bearish order block 27,168–27,196'),
    e('ev_sweep', 'sweep_reclaim', 'sweep_reclaim_mss', 27_004, null, 1, 'Swept 27,004, reclaimed, MSS above 27,046 on the 1m', true),
    e('ev_retrace_stall', 'retrace_quality', 'bounce_stalled_under_50', 27_130, null, -1, 'Bounce stalled at 46% of the 17:00 drop', true),
  ];
}

/** Deterministic synthetic candles: a seeded walk that ends at the mock NQ price. Not market data. */
export function syntheticCandles(now: number, symbol: string, tf: Timeframe, count = 320): Candle[] {
  const step = { '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN, '1h': HOUR, '1d': DAY }[tf];
  let seed = [...`${symbol}${tf}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vol = NQ * 0.0006 * Math.sqrt(step / MIN);
  const closes: number[] = [0];
  for (let i = 1; i < count; i++) closes.push(closes[i - 1]! + (rand() - 0.5) * 2 * vol + Math.sin(i / 23) * vol * 0.15);
  const shift = NQ - closes[count - 1]!;
  const end = Math.floor(now / step) * step;
  return closes.map((c, i) => {
    const close = c + shift, open = (i === 0 ? c : closes[i - 1]!) + shift;
    return { symbol, tf, t: end - (count - 1 - i) * step, o: open, h: Math.max(open, close) + rand() * vol * 0.6, l: Math.min(open, close) - rand() * vol * 0.6, c: close, v: Math.round(800 + rand() * 2400), source: 'mock-synthetic' };
  });
}

export const profile = (s: MockState): Profile => ({
  trader: 'Mock trader', timezone: 'America/New_York',
  style: { summary: 'Event-driven, catalyst plus timing.', edge: [], notEdge: [] },
  instruments: { primary: ['NQ', 'NQ-PERP', 'MNQ'], watchlist: ['NVDA', 'AMZN'], occasional: [], timeframes: { execution: ['1m', '15m'], structure: ['1h', '1d'] }, language: 'ICT' },
  accounts: ['vest-instant', 'vest-eval', 'mffu-builder-50k'], failurePatterns: [], voice: { rules: [], banned: [] }, goals: [], regimeNotes: [], weights: {},
  circuitBreakers: { planBreakingTradesPerDay: 3, vestClaimGainPct: 30, lateNight: { from: '23:00', to: '06:00', catalystWithinHours: 12 }, reentryCooldownMin: 15 },
  notifications: { quietHours: { from: '23:30', to: '06:00' }, p1PerSession: 8, p2PerDay: 6, morningBriefLocal: '06:30', recapET: '16:30', weeklyLocal: 'Sun 18:00' },
  memos: s.memos,
});

export interface MockState {
  killSwitch: boolean;
  balances: Record<string, number>;
  removed: Set<string>;
  manual: Position[];
  notes: JournalNote[];
  chat: ChatMessage[] | null;
  saved: Ticket[];
  memos: Profile['memos'];
}
export const initialState = (): MockState => ({
  killSwitch: false, balances: {}, removed: new Set(), manual: [], notes: [], chat: null, saved: [],
  memos: [{ week: '2026-W47', text: 'Edge confirmed: second-move entries with the 10Y confirming, 4 of 5. Pattern: time-stop overrides cost $212. Weights: structure 0.10 to 0.12.', approved: false }],
});
