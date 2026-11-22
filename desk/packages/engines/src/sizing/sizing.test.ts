import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MIN, SizingResult, PositionStatus, fromZoned, iso, type AccountRules, type Candle, type Position } from '@desk/contracts';
import {
  CUSHION_PCT, accountRoom, accountRow, atr, clampUnits, crossesWeekendLock, defaultAccountState, drawdownFloor, monitorPosition,
  nextFlatten, payoutNote, sizeTrade, weekendGaps, weekendLockAt, windowMoves, worstPlausibleMove, type CandleSet,
} from './index';
import { lastClose, recorded, rulesOf, syntheticCatalyst, syntheticState } from './testkit';

const NQ = recorded('NQ');
/** Tue Nov 17 2026, 14:45 ET: inside the recorded 1m week. */
const T = fromZoned(2026, 11, 17, 14, 45);
/** The spec's Vest rules (static 6%, daily 3%) at a chosen size; Vest Evaluation still carries them. */
const vest = (size = 10_000): AccountRules => ({ ...rulesOf('vest-eval'), startingBalance: size });

describe('acceptance', () => {
  it('a 50x Vest position with a 0.6% fail price returns Critical and a survivable size', () => {
    // $10,000 is one of the Instant sizes on vestmarkets.com; the YAML leaves the size unverified. Every ratio below is size-independent.
    const rules = vest();
    const state = syntheticState(rules, T);
    const mark = lastClose(NQ, T);
    const position: Position = {
      id: 'pos_vest_50x', accountId: rules.id, ticketId: null, instrument: 'NQ-PERP', direction: 'long', units: 50 * state.equity,
      entryPrice: mark, openedAt: iso(T), liquidationPrice: mark * (1 - 0.006), leverage: 50,
    };
    const status = monitorPosition({ position, rules, state, mark, now: T, catalysts: [], candles: NQ });
    expect(PositionStatus.safeParse(status).success).toBe(true);
    expect(status.status).toBe('Critical');
    // Real 1m ATR14 from the recorded NQ candles at 14:45 ET on Nov 17 2026.
    expect(status.atr1m).toBeCloseTo(atr(NQ.m1, 14, T)!.value, 6);
    // The venue liquidation is 0.6% away, but 50x on a 3% daily limit ends the account 0.06% away: that is the fail price.
    expect(status.failBasis).toBe('account_room');
    expect(status.distancePct).toBeCloseTo(0.06, 3);
    expect(status.distancePct).toBeLessThan(0.6);
    expect(status.distancePts).toBeLessThanOrEqual(1.5 * status.atr1m!);
    expect(status.line).toMatch(/Critical/);

    const sized = sizeTrade({ rules, state, instrument: 'NQ-PERP', direction: 'long', price: mark, entryAt: T, holdUntil: T + 2 * HOUR, now: T, catalysts: [], candles: NQ });
    expect(SizingResult.safeParse(sized).success).toBe(true);
    expect(sized.blocked).toBe(false);
    expect(sized.maxUnits).toBeGreaterThan(0);
    expect(sized.maxUnits).toBeLessThan(position.units / 10);
    expect(sized.leverage!).toBeLessThan(5);
    expect(sized.room.binding).toBe('daily_limit');
    expect(sized.failDistancePct!).toBeCloseTo(sized.worstMove.pct / (1 - CUSHION_PCT / 100), 1);
    console.info(`[acceptance] ${status.line}\n[acceptance] survivable ${sized.maxUnits} USD notional, ${sized.leverage!.toFixed(2)}x, fail ${sized.failPrice!.toFixed(0)} (${sized.failDistancePts!.toFixed(0)} pts, ${sized.failDistancePct!.toFixed(2)}%); ${sized.worstMove.text}`);
  });

  it('the 0.6% venue liquidation alone is the fail price when the account has room, and it is honored', () => {
    const rules = vest();
    const mark = lastClose(NQ, T);
    // Synthetic state: a small 2x position, so the account room is far and the liquidation price is the nearer fail.
    const state = syntheticState(rules, T);
    const position: Position = { id: 'p2', accountId: rules.id, ticketId: null, instrument: 'NQ-PERP', direction: 'short', units: 2 * state.equity, entryPrice: mark, openedAt: iso(T), liquidationPrice: mark * 1.006, leverage: 2 };
    const status = monitorPosition({ position, rules, state, mark, now: T, catalysts: [], candles: NQ });
    expect(status.failBasis).toBe('venue_liquidation');
    expect(status.failPrice).toBeCloseTo(mark * 1.006, 6);
    expect(status.distancePct).toBeCloseTo(0.6, 6);
    // 0.6% is about 162 pts; the largest 1m ATR14 in the recorded week is 83.5 pts, so this is Thin, not Critical.
    expect(status.status).toBe('Thin');
  });

  it('a Tier-1 catalyst inside the window with implied move above room blocks the ticket', () => {
    const rules = rulesOf('mffu-builder-50k');
    const now = fromZoned(2026, 11, 18, 8, 0);
    const state = syntheticState(rules, now);
    const price = lastClose(NQ, now);
    const cpi = syntheticCatalyst(now + 30 * MIN);
    const req = { rules, state, instrument: 'NQ', direction: 'short' as const, price, entryAt: now, holdUntil: now + 2 * HOUR, now, catalysts: [cpi], candles: NQ };
    const res = sizeTrade(req);
    // Room $1,000 (daily limit) less 20% = $800; 1.2% of NQ is about 326 pts = $6,500 on one NQ.
    expect(res.room.usableUsd).toBe(800);
    expect(res.blocked).toBe(true);
    expect(res.maxUnits).toBe(0);
    expect(res.blockReason).toMatch(/^This cannot survive CPI at any size above 1 MNQ; the catalyst trade is .+ at 1 MNQ\.$/);
    expect(res.catalystInWindow).toEqual({ id: cpi.id, name: 'CPI', impliedMovePct: 1.2 });
    expect(clampUnits(1, res)).toBe(0);

    // The catalyst trade itself on the instrument that fits is sized, not blocked.
    const asCatalystTrade = sizeTrade({ ...req, instrument: 'MNQ', isCatalystTrade: { catalystId: cpi.id } });
    expect(asCatalystTrade.blocked).toBe(false);
    expect(asCatalystTrade.maxUnits).toBe(1);
    expect(asCatalystTrade.worstMove.basis).toBe('tier1_implied');
    expect(asCatalystTrade.notes.join(' ')).toMatch(/Catalyst trade: 1 MNQ survives the 1\.20% implied move of CPI/);

    // Control: the same ticket with no catalyst in the window is not blocked by this rule.
    const control = sizeTrade({ ...req, catalysts: [], instrument: 'MNQ' });
    expect(control.blocked).toBe(false);
    expect(control.catalystInWindow).toBeNull();
  });

  it('quotes the matrix branch trade in the block message', () => {
    const rules = rulesOf('lucid-pro-50k');
    const now = fromZoned(2026, 11, 18, 8, 0);
    const price = lastClose(NQ, now);
    const trade = {
      instrument: 'NQ', direction: 'short' as const, entry: { kind: 'condition' as const, text: 'second move after 08:45 ET if the 10Y confirms' }, referencePrice: price,
      targets: [{ price: price - 100, fraction: 1 / 3 }, { price: price - 200, fraction: 1 / 3 }, { price: price - 300, fraction: 1 / 3 }] as [{ price: number; fraction: number }, { price: number; fraction: number }, { price: number; fraction: number }],
      invalidation: { price: price + 120, reason: 'reclaims the pre-print high' }, timeStop: { text: 'flat by 15:30 ET' },
    };
    const branch = { id: 'b', label: 'hot', match: { metric: 'core_mom', lo: 0.3, hi: null }, probability: 0.6, probabilitySource: 'prior' as const, ratesRead: { y2Bp: 8, y10Bp: 6, text: 'up' }, indexRead: { m15Pct: -0.8, h1Pct: -1, closePct: -1.2, text: 'down' }, secondOrder: 'synthetic', trade };
    const cold = { ...branch, id: 'a', label: 'cool', probability: 0.4, trade: null, noTradeReason: 'No edge' };
    const cpi = syntheticCatalyst(now + 30 * MIN, { matrix: { catalystId: 'cat_synthetic_cpi', generatedAt: iso(now), referencePrice: price, branches: [cold, branch], regimeNotes: [], whatIWouldDo: 'synthetic', inputs: {} } });
    const res = sizeTrade({ rules, state: syntheticState(rules, now), instrument: 'NQ', direction: 'long', price, entryAt: now, holdUntil: now + 2 * HOUR, now, catalysts: [cpi], candles: NQ });
    expect(res.blockReason).toBe('This cannot survive CPI at any size above 1 MNQ; the catalyst trade is short NQ, second move after 08:45 ET if the 10Y confirms at 1 MNQ.');
  });
});

describe('drawdown math per firm type', () => {
  it('Vest: static 6% from start, equity-based, daily 3% of the 20:00 ET snapshot', () => {
    const rules = vest(10_000);
    const s = syntheticState(rules, T, { balance: 10_400, equity: 10_150, highWaterBalance: 10_900, dayStartBalance: 10_400 });
    expect(drawdownFloor(rules, s)).toBeCloseTo(9_400, 6);
    const room = accountRoom(rules, s, T);
    expect(room.toDrawdownUsd).toBeCloseTo(750, 6); // equity 10,150 - 9,400: open P&L counts
    expect(room.toDailyLimitUsd).toBeCloseTo(312 - 250, 6); // 3% of 10,400 less the 250 already down
    expect(room.binding).toBe('daily_limit');
    expect(room.usableUsd).toBeCloseTo(62 * 0.8, 6);
    expect(room.cushionPct).toBe(20);
  });

  it('Vest Instant as confirmed: $400 static floor on $10,000, so 50x full port fails 0.08% away when the drawdown binds', () => {
    const rules = rulesOf('vest-instant');
    const fresh = syntheticState(rules, T, { balance: 10_000, equity: 10_000, highWaterBalance: 10_000, dayStartBalance: 10_000 });
    expect(drawdownFloor(rules, fresh)).toBe(9_600);
    const room = accountRoom(rules, fresh, T);
    expect(room.toDrawdownUsd).toBe(400);
    expect(room.toDailyLimitUsd).toBeCloseTo(300, 6); // the spec's 3% daily limit is still on file
    expect(room.binding).toBe('daily_limit');
    // Size-independent: $400 of room on 50 x $10,000 notional is 0.08% of price.
    expect(400 / (50 * 10_000)).toBeCloseTo(0.0008, 10);
  });

  it('MFFU Builder: EOD trailing $2,000 that locks at +$100; $1,000 daily limit binds', () => {
    const rules = rulesOf('mffu-builder-50k');
    const fresh = syntheticState(rules, T);
    expect(drawdownFloor(rules, fresh)).toBe(48_000);
    // Intraday equity above the high-water balance does not move an EOD floor.
    expect(drawdownFloor(rules, { ...fresh, equity: 51_500, highWaterBalance: 50_600 })).toBe(48_600);
    expect(drawdownFloor(rules, { ...fresh, highWaterBalance: 52_100 })).toBe(50_100);
    expect(drawdownFloor(rules, { ...fresh, highWaterBalance: 57_000 })).toBe(50_100);
    const room = accountRoom(rules, { ...fresh, balance: 50_300, equity: 50_300, dayStartBalance: 50_600, highWaterBalance: 50_600 }, T);
    expect(room.toDrawdownUsd).toBe(1_700);
    expect(room.toDailyLimitUsd).toBe(700);
    expect(room.binding).toBe('daily_limit');
    expect(room.usableUsd).toBeCloseTo(560, 6);
  });

  it('MFFU Rapid: intraday trailing follows the equity high and locks at +$100', () => {
    const rules = rulesOf('mffu-rapid-50k');
    const fresh = syntheticState(rules, T);
    expect(drawdownFloor(rules, { ...fresh, equity: 51_500, highWaterBalance: 50_600 })).toBe(49_500);
    expect(drawdownFloor(rules, { ...fresh, equity: 50_200, highWaterBalance: 51_800 })).toBe(49_800);
    expect(drawdownFloor(rules, { ...fresh, highWaterBalance: 53_000 })).toBe(50_100);
    const room = accountRoom(rules, { ...fresh, equity: 50_200, balance: 50_200, highWaterBalance: 51_800 }, T);
    expect(room.toDailyLimitUsd).toBeNull();
    expect(room.usableUsd).toBeCloseTo(400 * 0.8, 6);
  });

  it('MFFU Pro: EOD $2,000, left trailing (no lock on file)', () => {
    const rules = rulesOf('mffu-pro-50k');
    expect(drawdownFloor(rules, syntheticState(rules, T, { highWaterBalance: 53_400 }))).toBe(51_400);
  });

  it('Lucid 25K: $1,000 trailing locks at $25,100, no daily limit', () => {
    const rules = rulesOf('lucid-25k');
    const fresh = syntheticState(rules, T);
    expect(drawdownFloor(rules, fresh)).toBe(24_000);
    expect(drawdownFloor(rules, { ...fresh, highWaterBalance: 25_700 })).toBe(24_700);
    expect(drawdownFloor(rules, { ...fresh, highWaterBalance: 26_100 })).toBe(25_100);
    expect(drawdownFloor(rules, { ...fresh, highWaterBalance: 29_000 })).toBe(25_100);
    expect(accountRoom(rules, fresh, T)).toMatchObject({ toDrawdownUsd: 1_000, toDailyLimitUsd: null, usableUsd: 800, binding: 'drawdown' });
  });

  it('Lucid Pro 50K: EOD $2,000 locks at $50,100; $1,200 daily', () => {
    const rules = rulesOf('lucid-pro-50k');
    const fresh = syntheticState(rules, T);
    expect(drawdownFloor(rules, { ...fresh, highWaterBalance: 51_000 })).toBe(49_000);
    expect(drawdownFloor(rules, { ...fresh, highWaterBalance: 60_000 })).toBe(50_100);
    expect(accountRoom(rules, fresh, T)).toMatchObject({ toDrawdownUsd: 2_000, toDailyLimitUsd: 1_200, binding: 'daily_limit', usableUsd: 960 });
  });

  it('balance basis: a synthetic rule that ignores open P&L measures from the balance', () => {
    const rules: AccountRules = { ...rulesOf('lucid-pro-50k'), dailyLoss: null, drawdown: { ...rulesOf('lucid-pro-50k').drawdown, includesOpenPnl: false } };
    const s = syntheticState(rules, T, { balance: 50_000, equity: 49_300 });
    expect(accountRoom(rules, s, T).toDrawdownUsd).toBe(2_000);
  });

  it('unverified rules block sizing and name the rule: Apex, Tradeify, Vest without a size', () => {
    for (const id of ['apex-50k', 'tradeify-50k', 'vest-eval']) {
      const rules = rulesOf(id);
      const state = syntheticState(rules, T, id.startsWith('vest') ? { balance: 10_000, equity: 10_000, dayStartBalance: 10_000 } : {});
      const room = accountRoom(rules, state, T);
      expect(room.usableUsd).toBe(0);
      expect(room.unverified.length).toBeGreaterThan(0);
      expect(Number.isNaN(drawdownFloor(rules, state))).toBe(true);
      const res = sizeTrade({ rules, state, instrument: rules.venue === 'perp' ? 'NQ-PERP' : 'MNQ', direction: 'long', price: lastClose(NQ, T), entryAt: T, holdUntil: T + 30 * MIN, now: T, catalysts: [], candles: NQ });
      expect(res.blocked).toBe(true);
      expect(res.blockReason).toMatch(/no size until the rules? (is|are) confirmed/);
      expect(res.blockReason).toMatch(/unverified, confirm in the firm dashboard/);
    }
    expect(accountRoom(rulesOf('apex-50k'), syntheticState(rulesOf('apex-50k'), T), T).blockReason).toMatch(/drawdown amount .*daily loss limit/);
    // The trader can carry the Vest account size on the state.
    const sized = accountRoom(rulesOf('vest-eval'), { ...syntheticState(rulesOf('vest-eval'), T, { balance: 25_000, equity: 25_000, dayStartBalance: 25_000 }), startingBalance: 25_000 }, T);
    expect(sized).toMatchObject({ floorUsd: 23_500, toDrawdownUsd: 1_500, toDailyLimitUsd: 750, usableUsd: 600 });
  });

  it('a balance entered on the wrong basis fails safe', () => {
    const rules = rulesOf('mffu-builder-50k');
    const room = accountRoom(rules, syntheticState(rules, T, { balance: 1_500, equity: 1_500, dayStartBalance: 1_500, highWaterBalance: 1_500 }), T);
    expect(room.usableUsd).toBe(0);
    expect(room.blockReason).toMatch(/\$50,000 basis/);
  });

  it('defaultAccountState is a fresh, inactive account and an inactive account is not sized', () => {
    const rules = rulesOf('lucid-25k');
    const s = defaultAccountState(rules, T);
    expect(s).toMatchObject({ accountId: 'lucid-25k', active: false, balance: 25_000, equity: 25_000, highWaterBalance: 25_000, dayPnl: 0, lastTradeAt: null });
    const res = sizeTrade({ rules, state: s, instrument: 'MNQ', direction: 'long', price: lastClose(NQ, T), entryAt: T, holdUntil: T + 30 * MIN, now: T, catalysts: [], candles: NQ });
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/no live numbers/);
  });
});

describe('worst plausible move', () => {
  it('uses the p95 window move from real 15m candles, wicks included, and says how many sessions it had', () => {
    const w = worstPlausibleMove({ instrument: 'NQ', price: lastClose(NQ, T), entryAt: T, holdUntil: T + HOUR, now: T, catalysts: [], candles: NQ });
    expect(w.basis).toBe('p95_window');
    expect(w.components.p95Tf).toBe('15m');
    expect(w.components.p95Bars).toBe(4);
    expect(w.components.p95Sessions).toBeGreaterThan(40);
    expect(w.pct).toBeGreaterThan(0.3);
    expect(w.pct).toBeLessThan(3);
    expect(w.pts).toBeCloseTo((w.pct / 100) * lastClose(NQ, T), 6);
    expect(w.text).toMatch(/^\d+\.\d{2}% \([\d,]+ pts\) worst case/);
    // No look-ahead: candles after `now` change nothing.
    const cut: CandleSet = { m1: NQ.m1.filter((c) => c.t <= T), m15: NQ.m15.filter((c) => c.t <= T), h1: NQ.h1.filter((c) => c.t <= T), d1: NQ.d1.filter((c) => c.t <= T) };
    expect(worstPlausibleMove({ instrument: 'NQ', price: lastClose(NQ, T), entryAt: T, holdUntil: T + HOUR, now: T, catalysts: [], candles: cut }).pct).toBe(w.pct);
  });

  it('longer windows move to 1h and 1d candles and get wider', () => {
    const px = lastClose(NQ, T);
    const h = worstPlausibleMove({ instrument: 'NQ', price: px, entryAt: T, holdUntil: T + 8 * HOUR, now: T, catalysts: [], candles: NQ });
    const d = worstPlausibleMove({ instrument: 'NQ', price: px, entryAt: T, holdUntil: T + 3 * DAY, now: T, catalysts: [], candles: NQ });
    expect(h.components.p95Tf).toBe('1h');
    expect(d.components.p95Tf).toBe('1d');
    expect(d.components.p95Sessions).toBe(60);
    expect(d.pct).toBeGreaterThan(h.pct);
  });

  it('takes the Tier-1 implied move when it is larger, and ignores resolved or out-of-window catalysts', () => {
    const px = lastClose(NQ, T);
    const base = { instrument: 'NQ', price: px, entryAt: T, holdUntil: T + HOUR, now: T, candles: NQ };
    const hit = worstPlausibleMove({ ...base, catalysts: [syntheticCatalyst(T + 20 * MIN, { impliedMovePct: 2.4 })] });
    expect(hit.basis).toBe('tier1_implied');
    expect(hit.pct).toBe(2.4);
    expect(hit.text).toMatch(/CPI at 15:05 ET implies 2\.40%/);
    expect(worstPlausibleMove({ ...base, catalysts: [syntheticCatalyst(T + 3 * HOUR, { impliedMovePct: 2.4 })] }).basis).toBe('p95_window');
    expect(worstPlausibleMove({ ...base, catalysts: [syntheticCatalyst(T + 20 * MIN, { impliedMovePct: 2.4, status: 'resolved' })] }).basis).toBe('p95_window');
    expect(worstPlausibleMove({ ...base, catalysts: [syntheticCatalyst(T + 20 * MIN, { impliedMovePct: 2.4, tier: 2 })] }).basis).toBe('p95_window');
  });

  it('scalps under 15 minutes are tested against 2.5x the real 1m ATR', () => {
    const now = fromZoned(2026, 11, 20, 15, 0);
    const px = lastClose(NQ, now);
    const a = atr(NQ.m1, 14, now)!;
    const w = worstPlausibleMove({ instrument: 'NQ', price: px, entryAt: now, holdUntil: now + 5 * MIN, now, catalysts: [], candles: NQ });
    expect(w.components.atrScalpPct).toBeCloseTo(((2.5 * a.value) / px) * 100, 9);
    expect(w.pct).toBe(Math.max(w.components.atrScalpPct!, w.components.p95Pct!));
    expect(w.basis).toBe('atr_scalp');
    expect(w.text).toMatch(/2\.5x the 1m ATR of 44\.2 pts \(ATR14/);
    const long = worstPlausibleMove({ instrument: 'NQ', price: px, entryAt: now, holdUntil: now + 30 * MIN, now, catalysts: [], candles: NQ });
    expect(long.components.atrScalpPct).toBeNull();
  });

  it('ATR14 is the mean true range of the last 14 candles (synthetic candles)', () => {
    const synthetic: Candle[] = Array.from({ length: 15 }, (_, i) => ({ symbol: 'SYN', tf: '1m' as const, t: i * MIN, o: 100, h: 101, l: 99, c: 100, v: 1, source: 'synthetic' }));
    expect(atr(synthetic)!.value).toBe(2);
    synthetic[14] = { ...synthetic[14]!, h: 110, l: 108, c: 109 }; // gap: true range is 110 - 100
    expect(atr(synthetic)!.value).toBeCloseTo((13 * 2 + 10) / 14, 9);
    expect(atr(synthetic.slice(0, 14))).toBeNull();
  });

  it('window moves skip data gaps on intraday frames (synthetic candles)', () => {
    const mk = (t: number, o: number, h: number, l: number): Candle => ({ symbol: 'SYN', tf: '15m', t, o, h, l, c: o, v: 1, source: 'synthetic' });
    const base = fromZoned(2026, 11, 17, 10, 0);
    const synthetic = [mk(base, 100, 101, 99.5), mk(base + 15 * MIN, 100, 100.5, 98), mk(base + 3 * DAY, 100, 110, 100), mk(base + 3 * DAY + 15 * MIN, 100, 100, 100)];
    expect(windowMoves(synthetic, 2).moves).toEqual([2, 10]);
  });

  it('no candles: nothing is measured and the ticket is blocked', () => {
    const empty: CandleSet = { m1: [], m15: [], h1: [], d1: [] };
    const rules = rulesOf('lucid-25k');
    const res = sizeTrade({ rules, state: syntheticState(rules, T), instrument: 'MNQ', direction: 'long', price: 27_000, entryAt: T, holdUntil: T + HOUR, now: T, catalysts: [], candles: empty });
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/No candles on file for MNQ/);
  });
});

describe('weekend lock', () => {
  const fri1930 = fromZoned(2026, 11, 20, 19, 30);
  const fri2000 = fromZoned(2026, 11, 20, 20, 0);
  const sun1800 = fromZoned(2026, 11, 22, 18, 0);

  it('finds the Vest lock window, Fri 20:00 ET to Sun 18:00 ET', () => {
    const rules = vest();
    expect(weekendLockAt(rules, 'NQ-PERP', T)).toEqual({ from: fri2000, to: sun1800, inside: false });
    expect(weekendLockAt(rules, 'NQ-PERP', fromZoned(2026, 11, 21, 12, 0))).toEqual({ from: fri2000, to: sun1800, inside: true });
    expect(weekendLockAt(rules, 'NQ-PERP', sun1800)!.inside).toBe(false);
    expect(weekendLockAt(rules, 'BTC', fromZoned(2026, 11, 21, 12, 0))).toBeNull(); // crypto is exempt
    expect(crossesWeekendLock(rules, 'NQ-PERP', fri1930, fri1930 + 20 * MIN)).toBeNull();
    expect(crossesWeekendLock(rules, 'NQ-PERP', fri1930, sun1800 + HOUR)).not.toBeNull();
    expect(weekendLockAt(rulesOf('apex-50k'), 'NQ', T)).toBeNull();
  });

  it('weekend-lock sizing: a window that crosses the lock is sized against the weekend gap, 3% minimum, and says so', () => {
    const rules = vest();
    // Fri Nov 13 2026 19:30 ET, holding to Sunday 19:00 ET.
    const now = fromZoned(2026, 11, 13, 19, 30) - 3 * HOUR; // 16:30 ET, last recorded 1m bars of that session
    const px = lastClose(NQ, now);
    const state = syntheticState(rules, now);
    const through = sizeTrade({ rules, state, instrument: 'NQ-PERP', direction: 'long', price: px, entryAt: now, holdUntil: fromZoned(2026, 11, 15, 19, 0), now, catalysts: [], candles: NQ });
    const gaps = weekendGaps(NQ.d1.filter((c) => c.t <= now)).slice(-104);
    expect(gaps.length).toBe(104);
    expect(through.worstMove.pct).toBeGreaterThanOrEqual(3);
    expect(through.worstMove.text).toMatch(/weekend lock/);
    expect(through.worstMove.text).toMatch(/3% minimum/);
    expect((through.inputs.worst as { weekendGapPct: number }).weekendGapPct).toBeGreaterThanOrEqual(3);
    const flatBefore = sizeTrade({ rules, state, instrument: 'NQ-PERP', direction: 'long', price: px, entryAt: now, holdUntil: now + HOUR, now, catalysts: [], candles: NQ });
    expect(flatBefore.worstMove.text).not.toMatch(/weekend/);
    expect(through.maxUnits).toBeLessThan(flatBefore.maxUnits);
    expect(through.maxUnits).toBeLessThanOrEqual(Math.floor(through.room.usableUsd / 0.03));
  });

  it('the 3% floor applies when the measured gaps are small (synthetic daily candles)', () => {
    const rules = vest();
    const fri = fromZoned(2026, 11, 13, 0, 0);
    const synthetic: Candle[] = [];
    for (let w = 30; w >= 0; w--) for (let d = 4; d >= 0; d--) synthetic.push({ symbol: 'NQ', tf: '1d', t: fri - w * 7 * DAY - d * DAY, o: 100.2, h: 100.6, l: 99.8, c: 100, v: 1, source: 'synthetic' });
    const entry = fromZoned(2026, 11, 13, 19, 0);
    const w = worstPlausibleMove({ instrument: 'NQ-PERP', price: 100, entryAt: entry, holdUntil: entry + 2 * DAY, now: entry, catalysts: [], candles: { m1: [], m15: [], h1: [], d1: synthetic }, rules });
    expect(w.components.weekendGapP95Pct).toBeCloseTo(0.2, 6);
    expect(w.basis).toBe('weekend_gap');
    expect(w.pct).toBe(3);
    expect(w.text).toMatch(/window crosses the Vest Markets weekend lock \(Fri 20:00 to Sun 18:00 ET\), sized against the weekend gap \(p95 of 30 gaps 0\.20%, 3% minimum\)/);
  });

  it('no new NQ during the lock', () => {
    const rules = vest();
    const sat = fromZoned(2026, 11, 14, 11, 0);
    const res = sizeTrade({ rules, state: syntheticState(rules, sat), instrument: 'NQ-PERP', direction: 'long', price: 28_000, entryAt: sat, holdUntil: sat + HOUR, now: sat, catalysts: [], candles: NQ });
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toBe('No new NQ-PERP during the Vest Markets weekend lock (Fri 20:00 to Sun 18:00 ET). Lock lifts Sun 18:00 ET.');
  });
});

describe('sizeTrade', () => {
  const builder = rulesOf('mffu-builder-50k');

  it('floors futures to whole contracts and reports fail price in points and percent', () => {
    const state = syntheticState(builder, T, { balance: 53_000, equity: 53_000, highWaterBalance: 53_000, dayStartBalance: 53_000 });
    const px = lastClose(NQ, T);
    const res = sizeTrade({ rules: builder, state, instrument: 'MNQ', direction: 'short', price: px, entryAt: T, holdUntil: T + 30 * MIN, now: T, catalysts: [], candles: NQ });
    expect(res.blocked).toBe(false);
    expect(Number.isInteger(res.maxUnits)).toBe(true);
    expect(res.maxUnits).toBe(Math.floor(800 / (res.worstMove.pts * 2)));
    expect(res.notionalUsd).toBeCloseTo(res.maxUnits * 2 * px, 6);
    expect(res.leverage).toBeCloseTo(res.notionalUsd / 53_000, 9);
    expect(res.failDistancePts).toBeCloseTo(1_000 / (res.maxUnits * 2), 6);
    expect(res.failPrice).toBeCloseTo(px + res.failDistancePts!, 6); // short: fail is above
    expect(res.failDistancePct).toBeCloseTo((res.failDistancePts! / px) * 100, 9);
    expect(res.failDistancePts!).toBeGreaterThan(res.worstMove.pts);
    expect(res.inputs).toMatchObject({ price: px, floorUsd: 50_100 });
  });

  it('says "0 NQ; n MNQ fits" when the room is under one NQ', () => {
    const state = syntheticState(builder, T);
    const res = sizeTrade({ rules: builder, state, instrument: 'NQ', direction: 'long', price: lastClose(NQ, T), entryAt: T, holdUntil: T + 30 * MIN, now: T, catalysts: [], candles: NQ });
    const n = Math.floor(800 / (res.worstMove.pts * 2));
    expect(n).toBeGreaterThan(0);
    expect(res.maxUnits).toBe(0);
    expect(res.blocked).toBe(true);
    expect(res.notes).toContain(`0 NQ; ${n} MNQ fits.`);
    expect(res.blockReason).toContain(`0 NQ; ${n} MNQ fits.`);
  });

  it('caps contracts at the account limit (10 micros per mini)', () => {
    const state = syntheticState(builder, T, { balance: 150_000, equity: 150_000, highWaterBalance: 150_000, dayStartBalance: 50_000 });
    const px = lastClose(NQ, T);
    const base = { rules: builder, state, direction: 'long' as const, price: px, entryAt: T, holdUntil: T + 30 * MIN, now: T, catalysts: [], candles: NQ };
    expect(sizeTrade({ ...base, instrument: 'NQ' }).maxUnits).toBe(4);
    expect(sizeTrade({ ...base, instrument: 'MNQ' }).maxUnits).toBe(40);
  });

  it('caps Vest NQ leverage at 50x', () => {
    const rules = vest(10_000);
    // Synthetic: daily limit already far in profit, so the room would allow more than 50x on a scalp.
    const state = syntheticState(rules, T, { balance: 60_000, equity: 60_000, dayStartBalance: 60_000, highWaterBalance: 60_000 });
    const res = sizeTrade({ rules: { ...rules, dailyLoss: null }, state, instrument: 'NQ-PERP', direction: 'long', price: lastClose(NQ, T), entryAt: T, holdUntil: T + 5 * MIN, now: T, catalysts: [], candles: NQ });
    expect(res.leverage).toBeCloseTo(50, 6);
    expect(res.notes.join(' ')).toMatch(/Capped at 50x/);
  });

  it('CME flatten: a hold through 16:00 ET is blocked, and so is an entry after it', () => {
    const rules = rulesOf('lucid-pro-50k');
    const px = lastClose(NQ, T);
    expect(nextFlatten(rules, T)).toBe(fromZoned(2026, 11, 17, 16, 0));
    expect(nextFlatten(rules, fromZoned(2026, 11, 20, 16, 30))).toBe(fromZoned(2026, 11, 23, 16, 0));
    const base = { rules, state: syntheticState(rules, T), instrument: 'MNQ', direction: 'long' as const, price: px, now: T, catalysts: [], candles: NQ };
    const through = sizeTrade({ ...base, entryAt: T, holdUntil: fromZoned(2026, 11, 17, 16, 30) });
    expect(through.blocked).toBe(true);
    expect(through.blockReason).toMatch(/runs through the 16:00 ET flatten\. Set the time stop at or before 16:00 ET\./);
    expect(sizeTrade({ ...base, entryAt: T, holdUntil: fromZoned(2026, 11, 17, 16, 0) }).blocked).toBe(false);
    const late = fromZoned(2026, 11, 17, 16, 20);
    expect(sizeTrade({ ...base, now: late, entryAt: late, holdUntil: late + 10 * MIN }).blockReason).toMatch(/session is shut/);
  });

  it('news trading: blocked on MFFU Pro with the clause, allowed on Builder', () => {
    const now = fromZoned(2026, 11, 18, 8, 0);
    const px = lastClose(NQ, now);
    const cpi = syntheticCatalyst(now + 30 * MIN, { impliedMovePct: 0.1 });
    const pro = rulesOf('mffu-pro-50k');
    const state = syntheticState(pro, now);
    const req = { state, instrument: 'MNQ', direction: 'long' as const, price: px, entryAt: now, holdUntil: now + HOUR, now, catalysts: [cpi], candles: NQ };
    const res = sizeTrade({ ...req, rules: pro, isCatalystTrade: { catalystId: cpi.id } });
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/^MFFU Pro 50K bans news trading and CPI at 08:30 ET is inside the window\. Flat 2 minutes either side\./);
    expect(res.blockReason).toContain('News trading is prohibited on MFFU Pro');
    expect(sizeTrade({ ...req, rules: pro, holdUntil: now + 20 * MIN }).blocked).toBe(false);
    expect(sizeTrade({ ...req, rules: builder, state: syntheticState(builder, now) }).blocked).toBe(false);
  });

  it('a Tier-1 with no implied move on file blocks a hold-through', () => {
    const now = fromZoned(2026, 11, 18, 8, 0);
    const cpi = syntheticCatalyst(now + 30 * MIN, { impliedMovePct: null, impliedMoveSource: null });
    const res = sizeTrade({ rules: builder, state: syntheticState(builder, now), instrument: 'MNQ', direction: 'long', price: lastClose(NQ, now), entryAt: now, holdUntil: now + HOUR, now, catalysts: [cpi], candles: NQ });
    expect(res.blockReason).toBe('CPI at 08:30 ET is inside the window with no implied move on file. Flat before it or wait for the number.');
  });

  it('micro-scalp line, unknown instrument, event-cut and stop-entry notes', () => {
    const lucid = rulesOf('lucid-pro-50k');
    const px = lastClose(NQ, T);
    const quick = sizeTrade({ rules: lucid, state: syntheticState(lucid, T), instrument: 'MNQ', direction: 'long', price: px, entryAt: T, holdUntil: T + 3_000, now: T, catalysts: [], candles: NQ });
    expect(quick.blockReason).toMatch(/3s hold is under the 5s micro-scalp line/);
    const stock = sizeTrade({ rules: lucid, state: syntheticState(lucid, T), instrument: 'NVDA', direction: 'long', price: 150, entryAt: T, holdUntil: T + HOUR, now: T, catalysts: [], candles: recorded('NVDA') });
    expect(stock.blockReason).toBe('NVDA is not on file for Lucid Pro 50K.');
    const rules = vest();
    const v = sizeTrade({ rules, state: syntheticState(rules, T), instrument: 'NQ-PERP', direction: 'long', price: px, entryAt: T, holdUntil: T + HOUR, now: T, catalysts: [syntheticCatalyst(T + 30 * MIN)], candles: NQ });
    expect(v.notes.join(' ')).toMatch(/cuts leverage around CPI; the cut lifts 15:16 ET/);
    expect(v.notes.join(' ')).toMatch(/No stop-entry orders on Vest Markets/);
    expect(v.notes.join(' ')).toMatch(/marks 10 to 40 pts off CME/);
  });

  it('open positions on the account reserve room', () => {
    const state = syntheticState(builder, T, { balance: 53_000, equity: 53_000, highWaterBalance: 53_000, dayStartBalance: 53_000 });
    const px = lastClose(NQ, T);
    const req = { rules: builder, state, instrument: 'MNQ', direction: 'long' as const, price: px, entryAt: T, holdUntil: T + 30 * MIN, now: T, catalysts: [], candles: NQ };
    const alone = sizeTrade(req);
    const open: Position = { id: 'o1', accountId: builder.id, ticketId: null, instrument: 'MNQ', direction: 'long', units: 1, entryPrice: px, openedAt: iso(T), liquidationPrice: null, leverage: null };
    const withOpen = sizeTrade({ ...req, openPositions: [open, { ...open, id: 'o2', accountId: 'apex-50k' }] });
    expect(alone.maxUnits).toBeGreaterThan(1);
    expect(withOpen.maxUnits).toBe(alone.maxUnits - 1);
    expect(withOpen.notes.join(' ')).toMatch(/already hold/);
  });

  it('size-down-only clamp', () => {
    const state = syntheticState(builder, T, { balance: 53_000, equity: 53_000, highWaterBalance: 53_000, dayStartBalance: 53_000 });
    const res = sizeTrade({ rules: builder, state, instrument: 'MNQ', direction: 'long', price: lastClose(NQ, T), entryAt: T, holdUntil: T + 30 * MIN, now: T, catalysts: [], candles: NQ });
    expect(res.maxUnits).toBeGreaterThan(1);
    expect(clampUnits(res.maxUnits + 5, res)).toBe(res.maxUnits); // never up
    expect(clampUnits(1, res)).toBe(1); // down is fine
    expect(clampUnits(1.9, res)).toBe(1); // whole contracts
    expect(clampUnits(undefined, res)).toBe(res.maxUnits);
    expect(clampUnits(-3, res)).toBe(0);
    expect(clampUnits(Number.NaN, res)).toBe(res.maxUnits);
    expect(clampUnits(1, { ...res, blocked: true })).toBe(0);
    const perp = { ...res, instrument: 'NQ-PERP', maxUnits: 21_440 };
    expect(clampUnits(50_000, perp)).toBe(21_440);
    expect(clampUnits(10_000.5, perp)).toBe(10_000.5);
  });
});

describe('payout and consistency lines', () => {
  it('reproduces the spec sentence on Builder: best day share and the days left', () => {
    const rules = rulesOf('mffu-builder-50k');
    // Synthetic cycle: +$870 so far over one green day of $870; a +$1,200 day makes the cycle $2,070 and the best day 58%.
    const state = syntheticState(rules, T, { cyclePnl: 870, bestDayPnlInCycle: 870, qualifyingDaysInCycle: 0 });
    expect(payoutNote(rules, state, 1_200)).toBe('A +$1,200 day today puts your best day at 58% of this cycle; over the 50% limit, needs +$330 on other days before a request.');
    const lucid = rulesOf('lucid-pro-50k');
    const s2 = syntheticState(lucid, T, { cyclePnl: 2_000, bestDayPnlInCycle: 900, qualifyingDaysInCycle: 1 });
    expect(payoutNote(lucid, s2, 1_000, 2_600)).toBe('A +$1,000 day today puts your best day at 33% of this cycle; request after one more green day. T3 (+$2,600) puts it at 57%.');
    expect(payoutNote(lucid, { ...s2, qualifyingDaysInCycle: 2 }, 1_000)).toMatch(/inside the 40% limit, request is open\.$/);
    expect(payoutNote(rulesOf('lucid-25k'), syntheticState(rulesOf('lucid-25k'), T), 300)).toMatch(/payout rules for Lucid 25K are unverified, confirm in the firm dashboard/);
    const v = vest();
    expect(payoutNote(v, syntheticState(v, T), 400, 2_700)).toBe('A +$400 day at T1: claimable the same day, no cap and no schedule. A full target is a +27% session: claim before the next catalyst.');
  });

  it('sizeTrade attaches the payout note from the targets', () => {
    const rules = rulesOf('mffu-builder-50k');
    const state = syntheticState(rules, T, { balance: 53_000, equity: 53_000, highWaterBalance: 53_000, dayStartBalance: 53_000, cyclePnl: 3_000, bestDayPnlInCycle: 1_400, qualifyingDaysInCycle: 1 });
    const px = lastClose(NQ, T);
    const res = sizeTrade({ rules, state, instrument: 'MNQ', direction: 'long', price: px, entryAt: T, holdUntil: T + 30 * MIN, now: T, catalysts: [], candles: NQ, targets: [px + 50, px + 100, px + 150] });
    const win = res.maxUnits * 2 * 50;
    expect(res.payoutNote).toContain(`A +$${win.toLocaleString('en-US')} day today puts your best day at ${((1_400 / (3_000 + win)) * 100).toFixed(0)}% of this cycle; inside the 50% limit, request is open.`);
    expect(sizeTrade({ rules, state, instrument: 'MNQ', direction: 'long', price: px, entryAt: T, holdUntil: T + 30 * MIN, now: T, catalysts: [], candles: NQ }).payoutNote).toBeNull();
  });

  it('accountRow: floor, room, payout line, consistency line, claimable above the buffer', () => {
    const rules = rulesOf('mffu-builder-50k');
    const lastTrade = T - 2 * DAY;
    const state = syntheticState(rules, T, { balance: 53_500, equity: 53_500, highWaterBalance: 53_500, dayStartBalance: 53_500, cyclePnl: 3_500, bestDayPnlInCycle: 1_400, qualifyingDaysInCycle: 2, lastTradeAt: iso(lastTrade) });
    const row = accountRow(rules, state, T);
    expect(row.floorUsd).toBe(50_100);
    expect(row.roomUsd).toBe(1_000); // daily limit is nearer than the 3,400 to the floor
    expect(row.usableUsd).toBe(800);
    expect(row.claimableUsd).toBe(1_400); // 53,500 - 52,100, under the $2,000 cap
    expect(row.payoutLine).toBe('Claimable $1,400 above the $2,100 buffer; cap $2,000, minimum $500, 2 of 2 qualifying days.');
    expect(row.consistencyLine).toBe('Best day $1,400 is 40% of the $3,500 cycle; limit 50%.');
    expect(row.nextDeadline).toEqual({ what: 'Inactivity breach: 7 days without a trade', at: iso(lastTrade + 7 * DAY) });
    expect(row.claimPrompt).toBeNull();
    const over = accountRow(rules, { ...state, bestDayPnlInCycle: 2_450, balance: 58_000 }, T);
    expect(over.claimableUsd).toBe(2_000);
    expect(over.consistencyLine).toBe('Best day $2,450 is 70% of the $3,500 cycle, over the 50% limit; needs +$1,400 on other days.');
  });

  it('accountRow: Lucid ladder, Pro 14-day eligibility, unverified accounts', () => {
    const lucid = rulesOf('lucid-pro-50k');
    const s = syntheticState(lucid, T, { balance: 56_000, equity: 56_000, highWaterBalance: 56_000, dayStartBalance: 56_000 });
    expect(accountRow(lucid, s, T).claimableUsd).toBe(2_000);
    expect(accountRow(lucid, { ...s, payoutsTaken: 1 }, T).claimableUsd).toBe(2_500);
    const pro = rulesOf('mffu-pro-50k');
    const started = T - 10 * DAY;
    const row = accountRow(pro, syntheticState(pro, T, { cycleStartedAt: iso(started), lastTradeAt: iso(T - HOUR) }), T);
    expect(row.nextDeadline).toEqual({ what: 'Payout eligible: 14 calendar days', at: iso(started + 14 * DAY) });
    expect(row.payoutLine).toMatch(/minimum \$1,000, day 11 of 14/);
    const apex = accountRow(rulesOf('apex-50k'), syntheticState(rulesOf('apex-50k'), T), T);
    expect(apex).toMatchObject({ floorUsd: 0, roomUsd: 0, claimableUsd: null });
    expect(apex.payoutLine).toMatch(/^No size until confirmed: drawdown amount/);
    expect(accountRow(rulesOf('lucid-25k'), syntheticState(rulesOf('lucid-25k'), T), T).payoutLine).toBe('Payout rules unverified, confirm in the firm dashboard.');
    const closed = accountRow({ ...rulesOf('apex-50k'), drawdown: { ...rulesOf('apex-50k').drawdown, amountUsd: 2_000 }, dailyLoss: null }, syntheticState(rulesOf('apex-50k'), T, { payoutsTaken: 6, balance: 54_000 }), T);
    expect(closed.payoutLine).toBe('6 of 6 payouts taken: account is closed to payouts.');
    expect(closed.claimableUsd).toBeNull();
  });

  it('accountRow: Vest claim prompt after a single-session gain above 25%, and the weekend lock as the next deadline', () => {
    const rules = vest(10_000);
    const hot = syntheticState(rules, T, { balance: 12_700, equity: 12_700, highWaterBalance: 12_700, dayStartBalance: 10_000, dayPnl: 2_700 });
    const row = accountRow(rules, hot, T);
    expect(row.claimPrompt).toBe('Session +$2,700 is +27% of the account, over the 25% line. Claim now, withdraw same day.');
    expect(row.payoutLine).toBe(`${row.claimPrompt} Claimable $2,700; no cap, no schedule.`);
    expect(row.consistencyLine).toBeNull();
    expect(row.nextDeadline).toEqual({ what: 'Vest Markets weekend lock', at: iso(fromZoned(2026, 11, 20, 20, 0)) });
    expect(accountRow(rules, { ...hot, dayPnl: 2_400, balance: 12_400, equity: 12_400 }, T).claimPrompt).toBeNull();
  });
});

describe('monitorPosition', () => {
  const rules = rulesOf('mffu-builder-50k');
  const mark = lastClose(NQ, T);
  const pos = (units: number, over: Partial<Position> = {}): Position => ({ id: 'pos_m', accountId: rules.id, ticketId: null, instrument: 'MNQ', direction: 'long', units, entryPrice: mark + 20, openedAt: iso(T - HOUR), liquidationPrice: null, leverage: null, ...over });
  const state = syntheticState(rules, T, { balance: 53_000, equity: 53_000, highWaterBalance: 53_000, dayStartBalance: 53_000 });

  it('Safe, Thin and Critical by distance to the fail price', () => {
    // Room $1,000 (daily limit). 1 MNQ: 500 pts away. 40 MNQ: 12.5 pts away.
    const safe = monitorPosition({ position: pos(1), rules, state, mark, now: T, catalysts: [], candles: NQ, holdUntil: T + 30 * MIN });
    expect(safe).toMatchObject({ status: 'Safe', failBasis: 'account_room', failPrice: mark - 500, distancePts: 500, pnlUsd: -40 });
    expect(safe.distancePct).toBeCloseTo((500 / mark) * 100, 9);
    expect(safe.nextLockOrSnapshot).toEqual({ what: 'Flatten by 16:00 ET', at: iso(fromZoned(2026, 11, 17, 16, 0)) });
    expect(safe.line).toMatch(/^MNQ long on MFFU Builder 50K: fail [\d,]+, 500 pts \(1\.\d\d%\) away \(daily loss limit\); 1m ATR 15\.4\. Safe: worst case for the next 30m is 0\.\d\d%\. Flatten by 16:00 ET in 1h 15m\.$/);
    const thin = monitorPosition({ position: pos(8), rules, state, mark, now: T, catalysts: [], candles: NQ, holdUntil: T + 30 * MIN });
    expect(thin.distancePts).toBe(62.5);
    expect(thin.status).toBe('Thin');
    expect(thin.distancePct).toBeLessThanOrEqual(thin.worstRemainingPct!);
    const critical = monitorPosition({ position: pos(40), rules, state, mark, now: T, catalysts: [], candles: NQ, holdUntil: T + 30 * MIN });
    expect(critical.distancePts).toBe(12.5);
    expect(critical.status).toBe('Critical');
  });

  it('the guardrail line: within 1.5x the passed-in 1m ATR is Critical, just outside is not', () => {
    const base = { position: pos(1), rules, state, mark, now: T, catalysts: [], candles: NQ, holdUntil: T + MIN };
    expect(monitorPosition({ ...base, atr1m: 500 / 1.5 }).status).toBe('Critical');
    expect(monitorPosition({ ...base, atr1m: 500 / 1.5 - 1 }).status).not.toBe('Critical');
    expect(monitorPosition({ ...base, atr1m: null }).line).toMatch(/no 1m ATR on file/);
  });

  it('reports the catalyst inside the window and whether its implied move reaches the fail price', () => {
    const cpi = syntheticCatalyst(T + 20 * MIN, { impliedMovePct: 1.2 });
    const s = monitorPosition({ position: pos(3), rules, state, mark, now: T, catalysts: [cpi], candles: NQ, holdUntil: T + HOUR });
    expect(s.catalystInWindow).toEqual({ id: cpi.id, name: 'CPI', at: cpi.scheduledAt, tier: 1 });
    expect(s.status).toBe('Thin'); // 167 pts away, CPI implies about 324
    expect(s.line).toMatch(/CPI 15:05 ET is inside the window, implied 1\.20% reaches the fail price\./);
    expect(monitorPosition({ position: pos(3), rules, state, mark, now: T, catalysts: [cpi], candles: NQ, holdUntil: T + 10 * MIN }).catalystInWindow).toBeNull();
  });

  it('Vest: time to the 20:00 ET snapshot; an unverified account is Critical with the rule named', () => {
    const v = vest();
    const p: Position = { id: 'pv', accountId: v.id, ticketId: null, instrument: 'NQ-PERP', direction: 'long', units: 5_000, entryPrice: mark, openedAt: iso(T), liquidationPrice: null, leverage: 0.5 };
    const s = monitorPosition({ position: p, rules: v, state: syntheticState(v, T), mark, now: T, catalysts: [], candles: NQ });
    expect(s.nextLockOrSnapshot).toEqual({ what: 'Daily-loss snapshot 20:00 ET', at: iso(fromZoned(2026, 11, 17, 20, 0)) });
    expect(s.distancePct).toBeCloseTo(6, 6); // $300 on $5,000 notional
    expect(s.status).toBe('Safe');
    const unv = monitorPosition({ position: p, rules: rulesOf('vest-eval'), state: syntheticState(v, T), mark, now: T, catalysts: [], candles: NQ });
    expect(unv.status).toBe('Critical');
    expect(unv.line).toMatch(/no fail price until this is confirmed: account size/);
  });
});
