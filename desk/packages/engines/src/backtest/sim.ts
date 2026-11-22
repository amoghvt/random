/**
 * Trade-level backtest of the desk's calls on a funded perp account (Vest-style: a fee buys an account with a
 * balance, a static drawdown floor and optionally a daily loss limit; profits above the starting balance are
 * claimable). It answers "what would trading these calls have paid", not "how often was the direction right".
 *
 * Model, stated so the numbers can be checked:
 *  - One position at a time per run. A call that arrives while a position is open is skipped.
 *  - Entry: a price trigger fills when a later bar trades through it before the plan's time stop; any other
 *    trigger fills at the open of the first bar after the call. Slippage is charged on entry and on every exit.
 *  - Size: `leverage` x the account balance at entry (full port at the venue cap when leverage = cap).
 *  - The account's fail price is where the loss would use up the room to the drawdown floor or the daily limit,
 *    whichever is nearer. Touching it blows the account: the trader loses the fee and buys a new account.
 *  - Inside a bar the adverse extreme is assumed to come first (a bar touching both stop and target is a loss).
 *  - Daily strategy: the plan's invalidation is the stop and its three targets scale out by their fractions.
 *    The stop stays where it was after T1 (the runner's trailing stop is not modelled).
 *  - Asymmetric strategy: no stop inside the fail price; one target sized to make `targetFeeMultiple` x the fee.
 *  - Anything still open at the plan's time stop (or the call's expiry) closes at that bar's close.
 *  - Profits above the starting balance are claimed at once; a loss that does not blow the account stays in it
 *    and must be earned back before the next claim. The daily limit is measured from the balance at the first
 *    trade of the ET day, an approximation of the venue's 20:00 ET snapshot.
 *  - Venue marks that diverge from CME, funding, fees per trade and payout splits are not modelled.
 */
import { dayKey, round, type BiasCall, type Candle, type Horizon } from '@desk/contracts';

export interface SimAccount {
  /** Starting balance the fee buys, USD. */
  balance: number;
  /** Notional / balance at entry. */
  leverage: number;
  /** Static drawdown floor below the starting balance, percent (e.g. 6). */
  drawdownPct: number;
  /** Hard daily loss limit as percent of the day's starting balance; null for none. */
  dailyLossPct: number | null;
  /** Price of one account, USD. */
  feeUsd: number;
  /** Adverse slippage per fill, index points. */
  slippagePts: number;
}

export type StrategyKind = 'daily' | 'asymmetric';
export interface SimStrategy {
  kind: StrategyKind;
  horizons: Horizon[];
  /** Asymmetric only: the target profit as a multiple of the fee. */
  targetFeeMultiple?: number;
}

export type ExitReason = 'target' | 'stop' | 'blown' | 'time';
export interface SimTrade {
  callId: string; horizon: Horizon; direction: 'long' | 'short'; probability: number;
  entryAt: number; entryPrice: number; exitAt: number;
  notionalUsd: number; failPrice: number;
  exit: ExitReason;
  /** Change in account equity from this trade, USD (a blown account shows the room it lost). */
  pnlUsd: number;
  blown: boolean;
}

export interface SimStats {
  trades: number; winners: number; losers: number; winRate: number | null;
  avgWinUsd: number | null; avgLossUsd: number | null; largestWinUsd: number | null; largestLossUsd: number | null;
  /** Gross wins / gross losses, account P&L. */
  profitFactor: number | null;
  expectancyUsd: number | null;
  accountsBlown: number; accountsBought: number;
  claimedUsd: number; feesUsd: number;
  /** What the trader keeps: claims minus fees. */
  netUsd: number;
  daysTraded: number; greenDays: number; greenDayRate: number | null;
  bestDayUsd: number | null; worstDayUsd: number | null; medianDayUsd: number | null;
  /** Deepest fall of cumulative net (claims minus fees) from its high, USD. */
  maxDrawdownUsd: number;
  exits: Record<ExitReason, number>;
}

export interface SimResult { trades: SimTrade[]; days: Array<{ day: string; pnlUsd: number }>; stats: SimStats }

const dirOf = (c: BiasCall): 1 | -1 | 0 => (c.call.endsWith('long') ? 1 : c.call.endsWith('short') ? -1 : 0);

/** First index with t >= x (candles ascending). */
function firstAtOrAfter(candles: Candle[], x: number): number {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (candles[m]!.t < x) lo = m + 1; else hi = m; }
  return lo;
}

interface Open { i: number; price: number }

function findEntry(call: BiasCall, candles: Candle[], deadline: number, dir: 1 | -1, slip: number): Open | null {
  const start = firstAtOrAfter(candles, Date.parse(call.createdAt) + 1);
  const trig = call.trade?.entry;
  if (trig?.kind === 'price' && trig.price != null) {
    for (let i = start; i < candles.length && candles[i]!.t < deadline; i++) {
      const b = candles[i]!;
      if (b.l <= trig.price && b.h >= trig.price) return { i, price: trig.price + slip * dir };
    }
    return null;
  }
  const b = candles[start];
  return b && b.t < deadline ? { i: start, price: b.o + slip * dir } : null;
}

/** Simulate one strategy over the calls (any order) and the instrument's candles (ascending, one series). */
export function simulate(calls: BiasCall[], candles: Candle[], strategy: SimStrategy, account: SimAccount): SimResult {
  const eligible = calls
    .filter((c) => strategy.horizons.includes(c.horizon) && dirOf(c) !== 0 && c.trade !== null)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const trades: SimTrade[] = [];
  const dayPnl = new Map<string, number>();
  const floor = account.balance * (1 - account.drawdownPct / 100);
  let balance = account.balance, busyUntil = -Infinity;
  let claimed = 0, fees = account.feeUsd, bought = 1, blownCount = 0;
  let dayKeyNow = '', dayStart = balance;
  const netPath: number[] = [-fees];

  for (const call of eligible) {
    const created = Date.parse(call.createdAt);
    if (created < busyUntil) continue;
    const plan = call.trade!;
    const dir = dirOf(call) as 1 | -1;
    const deadline = Math.min(Date.parse(plan.timeStop.at ?? call.expiresAt), Date.parse(call.expiresAt));
    const entry = findEntry(call, candles, deadline, dir, account.slippagePts);
    if (!entry) continue;
    const entryBar = candles[entry.i]!;
    const today = dayKey(entryBar.t);
    if (today !== dayKeyNow) { dayKeyNow = today; dayStart = balance; }
    const notional = account.leverage * balance;
    const dayUsed = -(dayPnl.get(today) ?? 0);
    const dailyRoom = account.dailyLossPct == null ? Infinity : (account.dailyLossPct / 100) * dayStart - Math.max(0, dayUsed);
    const room = Math.max(0, Math.min(balance - floor, dailyRoom));
    const failMove = room / notional;
    const failPrice = entry.price * (1 - dir * failMove);

    const isDaily = strategy.kind === 'daily';
    const stop = isDaily ? plan.invalidation.price : null;
    const targets = isDaily
      ? plan.targets.map((t) => ({ price: t.price, fraction: t.fraction }))
      : [{ price: entry.price * (1 + dir * ((strategy.targetFeeMultiple ?? 5) * account.feeUsd) / notional), fraction: 1 }];
    let remaining = 1, pnl = 0, exit: ExitReason = 'time', exitAt = entryBar.t, blown = false;
    const move = (px: number): number => dir * (px - entry.price) / entry.price * notional;

    let i = entry.i;
    for (; i < candles.length && remaining > 1e-9; i++) {
      const b = candles[i]!;
      if (b.t >= deadline) { pnl += remaining * move(b.o - account.slippagePts * dir); remaining = 0; exit = 'time'; exitAt = b.t; break; }
      const adverse = dir === 1 ? b.l : b.h;
      const pastFail = dir === 1 ? adverse <= failPrice : adverse >= failPrice;
      const pastStop = stop !== null && (dir === 1 ? adverse <= stop : adverse >= stop);
      const stopFirst = pastStop && (dir === 1 ? stop! >= failPrice : stop! <= failPrice);
      if (pastStop && stopFirst) {
        // A bar that opens through the stop fills at the open, not the stop.
        const fill = (dir === 1 ? Math.min(stop!, b.o) : Math.max(stop!, b.o)) - account.slippagePts * dir;
        pnl += remaining * move(fill); remaining = 0; exit = 'stop'; exitAt = b.t;
        if (-pnl >= room) blown = true;
        break;
      }
      if (pastFail) { pnl = -room; remaining = 0; exit = 'blown'; exitAt = b.t; blown = true; break; }
      for (const t of targets) {
        if (t.fraction <= 0) continue;
        const hit = dir === 1 ? b.h >= t.price : b.l <= t.price;
        if (!hit) continue;
        const f = Math.min(t.fraction, remaining);
        pnl += f * move(t.price - account.slippagePts * dir); remaining -= f; t.fraction = 0;
        exit = 'target'; exitAt = b.t;
      }
    }
    if (remaining > 1e-9) {
      const last = candles[Math.min(i, candles.length - 1)]!;
      pnl += remaining * move(last.c - account.slippagePts * dir); exit = 'time'; exitAt = last.t;
    }
    if (blown) pnl = -room;

    trades.push({ callId: call.id, horizon: call.horizon, direction: dir === 1 ? 'long' : 'short', probability: call.probability, entryAt: entryBar.t, entryPrice: round(entry.price, 2), exitAt, notionalUsd: round(notional, 0), failPrice: round(failPrice, 2), exit: blown ? 'blown' : exit, pnlUsd: round(pnl, 2), blown });
    const exitDay = dayKey(exitAt);
    dayPnl.set(exitDay, (dayPnl.get(exitDay) ?? 0) + pnl);
    busyUntil = exitAt + 1;

    if (blown) {
      blownCount++; bought++; fees += account.feeUsd; balance = account.balance; dayStart = balance;
    } else {
      balance += pnl;
      if (balance > account.balance) { claimed += balance - account.balance; balance = account.balance; }
    }
    netPath.push(claimed - fees);
  }

  const wins = trades.filter((t) => t.pnlUsd > 0), losses = trades.filter((t) => t.pnlUsd <= 0);
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const days = [...dayPnl.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, p]) => ({ day, pnlUsd: round(p, 2) }));
  const dv = days.map((d) => d.pnlUsd).sort((a, b) => a - b);
  let peak = -Infinity, mdd = 0;
  for (const v of netPath) { peak = Math.max(peak, v); mdd = Math.max(mdd, peak - v); }
  const exits: Record<ExitReason, number> = { target: 0, stop: 0, blown: 0, time: 0 };
  for (const t of trades) exits[t.exit]++;
  const gw = sum(wins.map((t) => t.pnlUsd)), gl = -sum(losses.map((t) => t.pnlUsd));
  const stats: SimStats = {
    trades: trades.length, winners: wins.length, losers: losses.length,
    winRate: trades.length ? round(wins.length / trades.length, 4) : null,
    avgWinUsd: wins.length ? round(gw / wins.length, 2) : null,
    avgLossUsd: losses.length ? round(-gl / losses.length, 2) : null,
    largestWinUsd: wins.length ? round(Math.max(...wins.map((t) => t.pnlUsd)), 2) : null,
    largestLossUsd: losses.length ? round(Math.min(...losses.map((t) => t.pnlUsd)), 2) : null,
    profitFactor: gl > 0 ? round(gw / gl, 3) : null,
    expectancyUsd: trades.length ? round((gw - gl) / trades.length, 2) : null,
    accountsBlown: blownCount, accountsBought: bought,
    claimedUsd: round(claimed, 2), feesUsd: fees, netUsd: round(claimed - fees, 2),
    daysTraded: days.length, greenDays: days.filter((d) => d.pnlUsd > 0).length,
    greenDayRate: days.length ? round(days.filter((d) => d.pnlUsd > 0).length / days.length, 4) : null,
    bestDayUsd: dv.length ? dv[dv.length - 1]! : null, worstDayUsd: dv.length ? dv[0]! : null,
    medianDayUsd: dv.length ? dv[Math.floor(dv.length / 2)]! : null,
    maxDrawdownUsd: round(mdd, 2), exits,
  };
  return { trades, days, stats };
}

/** One series from several timeframes: each finer series replaces the coarser one from its first bar on. */
export function stitch(seriesCoarseToFine: Candle[][]): Candle[] {
  let out: Candle[] = [];
  for (const s of seriesCoarseToFine) {
    if (!s.length) continue;
    const from = s[0]!.t;
    out = [...out.filter((c) => c.t < from), ...s];
  }
  return out;
}
