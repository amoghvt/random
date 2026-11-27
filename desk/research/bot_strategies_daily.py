"""The standard published "bot" strategies on daily bars: Nasdaq futures, gold futures, BTC, SOL.

Usage: python3 -I bot_strategies_daily.py <dir with Yahoo chart json: NQ=F.json GC=F.json BTC-USD.json SOL-USD.json>

Every rule decides on a day's close and is filled at that close (the convention the published versions use), unless noted.
Cost: 2 basis points per side for futures, 10 for crypto. No leverage, no interest on cash. One unit of capital.
Long-only unless the name says long/short.
"""
import datetime
import json
import math
import os
import sys

import numpy as np

COST = {'NQ=F': 0.0002, 'GC=F': 0.0002, 'BTC-USD': 0.001, 'SOL-USD': 0.001}


def load(path):
    d = json.load(open(path))['chart']['result'][0]
    q = d['indicators']['quote'][0]
    rows = [(t, o, h, lo, c) for t, o, h, lo, c in zip(d['timestamp'], q['open'], q['high'], q['low'], q['close']) if None not in (o, h, lo, c) and c > 0]
    a = np.array(rows, dtype=float)
    return a[:, 0], a[:, 1], a[:, 2], a[:, 3], a[:, 4]


def sma(x, n):
    out = np.full(len(x), np.nan)
    cs = np.cumsum(np.insert(x, 0, 0.0))
    out[n - 1:] = (cs[n:] - cs[:-n]) / n
    return out


def ema(x, n):
    out = np.empty(len(x))
    k = 2 / (n + 1)
    e = x[0]
    for i, v in enumerate(x):
        e = v * k + e * (1 - k)
        out[i] = e
    return out


def rsi(c, n):
    d = np.diff(c, prepend=c[0])
    up, dn = np.maximum(d, 0), np.maximum(-d, 0)
    au, ad = np.empty(len(c)), np.empty(len(c))
    a = b = 0.0
    for i in range(len(c)):
        a = (a * (n - 1) + up[i]) / n
        b = (b * (n - 1) + dn[i]) / n
        au[i], ad[i] = a, b
    return 100 - 100 / (1 + au / np.maximum(ad, 1e-12))


def rolling(x, n, fn):
    out = np.full(len(x), np.nan)
    for i in range(n - 1, len(x)):
        out[i] = fn(x[i - n + 1:i + 1])
    return out


def atr(h, lo, c, n):
    pc = np.roll(c, 1)
    pc[0] = c[0]
    tr = np.maximum(h - lo, np.maximum(abs(h - pc), abs(lo - pc)))
    return sma(tr, n)


def stateful(n, enter, leave, short_enter=None, short_leave=None):
    """Position held after each close: +1 after `enter`, flat after `leave` (mirrored for shorts)."""
    pos = np.zeros(n)
    p = 0
    for i in range(n):
        if p == 1 and leave[i]:
            p = 0
        elif p == -1 and short_leave is not None and short_leave[i]:
            p = 0
        if p == 0:
            if enter[i]:
                p = 1
            elif short_enter is not None and short_enter[i]:
                p = -1
        pos[i] = p
    return pos


def supertrend(h, lo, c, n=10, m=3.0):
    a = atr(h, lo, c, n)
    mid = (h + lo) / 2
    ub, lb = mid + m * a, mid - m * a
    d = np.ones(len(c))
    fu, fl = ub.copy(), lb.copy()
    for i in range(1, len(c)):
        if np.isnan(a[i]):
            continue
        fu[i] = ub[i] if (ub[i] < fu[i - 1] or c[i - 1] > fu[i - 1] or np.isnan(fu[i - 1])) else fu[i - 1]
        fl[i] = lb[i] if (lb[i] > fl[i - 1] or c[i - 1] < fl[i - 1] or np.isnan(fl[i - 1])) else fl[i - 1]
        d[i] = 1 if c[i] > fu[i - 1] else -1 if c[i] < fl[i - 1] else d[i - 1]
    return d


def strategies(t, o, h, lo, c):
    n = len(c)
    F = lambda x: np.nan_to_num(x, nan=0.0).astype(bool)  # noqa: E731
    s200, s50, s5, s20 = sma(c, 200), sma(c, 50), sma(c, 5), sma(c, 20)
    r2 = rsi(c, 2)
    ibs = (c - lo) / np.maximum(h - lo, 1e-9)
    prev = np.roll(c, 1)
    down = c < prev
    down3 = down & np.roll(down, 1) & np.roll(down, 2)
    hi20, lo10 = np.roll(rolling(h, 20, np.max), 1), np.roll(rolling(lo, 10, np.min), 1)
    lo20, hi10 = np.roll(rolling(lo, 20, np.min), 1), np.roll(rolling(h, 10, np.max), 1)
    hi55, lo55 = np.roll(rolling(h, 55, np.max), 1), np.roll(rolling(lo, 55, np.min), 1)
    sd20 = rolling(c, 20, np.std)
    macd = ema(c, 12) - ema(c, 26)
    sig = ema(macd, 9)
    st = supertrend(h, lo, c)
    mom = c / np.roll(c, 252) - 1
    mom[:252] = np.nan
    wd = np.array([datetime.datetime.fromtimestamp(x, datetime.timezone.utc).weekday() for x in t])
    out = {}
    out['Buy and hold'] = np.ones(n)
    out['200-day average: long above, cash below'] = F(c > s200).astype(float)
    out['Golden cross 50/200'] = F(s50 > s200).astype(float)
    out['12-month momentum: long if up, else cash'] = F(mom > 0).astype(float)
    out['Supertrend (10,3) long/cash'] = (st > 0).astype(float)
    out['Supertrend (10,3) long/short'] = st.astype(float)
    out['MACD (12,26,9) cross long/cash'] = F(macd > sig).astype(float)
    out['EMA 9/21 cross long/short'] = np.where(ema(c, 9) > ema(c, 21), 1.0, -1.0)
    out['Turtle 20-day breakout, 10-day exit, long'] = stateful(n, F(c > hi20), F(c < lo10))
    out['Turtle 20/10 long/short'] = stateful(n, F(c > hi20), F(c < lo10), F(c < lo20), F(c > hi10))
    out['Donchian 55-day long/short'] = stateful(n, F(c > hi55), F(c < lo55), F(c < lo55), F(c > hi55))
    out['RSI(2) < 10 above 200-day, exit above 5-day avg'] = stateful(n, F((r2 < 10) & (c > s200)), F(c > s5))
    out['RSI(2) < 10, no trend filter'] = stateful(n, F(r2 < 10), F(c > s5))
    out['IBS < 0.2 buy, exit IBS > 0.8'] = stateful(n, F(ibs < 0.2), F(ibs > 0.8))
    out['IBS < 0.2 above 200-day'] = stateful(n, F((ibs < 0.2) & (c > s200)), F(ibs > 0.8))
    out['3 down closes above 200-day, exit above 5-day avg'] = stateful(n, F(down3 & (c > s200)), F(c > s5))
    out['Bollinger (20,2) dip buy, exit at the middle'] = stateful(n, F(c < s20 - 2 * sd20), F(c > s20))
    out['Turnaround Tuesday (Monday down, hold one day)'] = F((wd == 0) & down).astype(float)
    return out


def stats(pos, o, c, cost, mask, t):
    """Daily returns of holding `pos` (decided at close i) over close i -> close i+1."""
    r = c[1:] / c[:-1] - 1
    p = pos[:-1]
    turn = np.abs(np.diff(np.insert(pos, 0, 0.0)))[:-1]
    net = p * r - turn * cost
    m = mask[1:]
    net, p, turn = net[m], p[m], turn[m]
    if len(net) < 60:
        return None
    eq = np.cumprod(1 + net)
    years = (t[1:][m][-1] - t[1:][m][0]) / 86400 / 365.25
    cagr = eq[-1] ** (1 / years) - 1 if eq[-1] > 0 else -1
    dd = (eq / np.maximum.accumulate(eq) - 1).min()
    sharpe = net.mean() / net.std() * math.sqrt(len(net) / years) if net.std() > 0 else 0
    trades = int((turn > 0).sum() / 2)
    return dict(cagr=cagr, dd=dd, sharpe=sharpe, inmkt=(p != 0).mean(), trades=trades, total=eq[-1] - 1)


def overnight(t, o, c, cost, mask):
    """Buy the close, sell the next open (and the reverse): two fills a day."""
    res = {}
    for name, r in (('Overnight only: buy close, sell next open', o[1:] / c[:-1] - 1), ('Day session only: buy open, sell close', c[1:] / o[1:] - 1)):
        net = (r - 2 * cost)[mask[1:]]
        eq = np.cumprod(1 + net)
        years = (t[1:][mask[1:]][-1] - t[1:][mask[1:]][0]) / 86400 / 365.25
        res[name] = dict(cagr=eq[-1] ** (1 / years) - 1 if eq[-1] > 0 else -1, dd=(eq / np.maximum.accumulate(eq) - 1).min(),
                         sharpe=net.mean() / net.std() * math.sqrt(len(net) / years), inmkt=0.5, trades=len(net), total=eq[-1] - 1)
    return res


def dca_bot(o, h, lo, c, mask, cost, step=0.02, scale=1.5, levels=6, tp=0.015):
    """The default crypto 'DCA bot': base order, then a safety order every `step` lower, each `scale` times larger,
    take profit `tp` above the average entry, restart at once. Return on the full capital reserved for all orders."""
    sizes = [scale ** k for k in range(levels + 1)]
    cap = sum(sizes)
    cash = cap
    units = 0.0
    spent = 0.0
    filled = 0
    base = None
    eq = []
    worst = 0.0
    for i in np.nonzero(mask)[0]:
        if base is None:
            base = o[i]
            units = sizes[0] / base * (1 - cost)
            spent, filled = sizes[0], 1
            cash -= sizes[0]
        while filled <= levels and lo[i] <= base * (1 - step * filled):
            px = base * (1 - step * filled)
            units += sizes[filled] / px * (1 - cost)
            spent += sizes[filled]
            cash -= sizes[filled]
            filled += 1
        avg = spent / units
        if h[i] >= avg * (1 + tp) and filled >= 1 and not (lo[i] <= base * (1 - step * (filled - 1)) and filled > 1 and c[i] < avg * (1 + tp)):
            cash += units * avg * (1 + tp) * (1 - cost)
            units, spent, filled, base = 0.0, 0.0, 0, None
        v = cash + units * c[i]
        eq.append(v)
    eq = np.array(eq) / cap
    return eq[-1] - 1, (eq / np.maximum.accumulate(eq) - 1).min()


def main():
    folder = sys.argv[1]
    for sym in ('NQ=F', 'GC=F', 'BTC-USD', 'SOL-USD'):
        t, o, h, lo, c = load(os.path.join(folder, sym + '.json'))
        strat = strategies(t, o, h, lo, c)
        end = t[-1]
        windows = [('all', t >= t[0] + 260 * 86400), ('last 10y', t >= end - 3652 * 86400), ('last 3y', t >= end - 1096 * 86400), ('last 1y', t >= end - 366 * 86400)]
        windows = [(w, m & (t >= t[0] + 260 * 86400)) for w, m in windows]
        print(f'\n================ {sym}  {datetime.date.fromtimestamp(t[0])} to {datetime.date.fromtimestamp(t[-1])}, cost {COST[sym] * 1e4:.0f} bp per side ================')
        print(f'{"strategy":<52}' + ''.join(f'| {w:^29} ' for w, _ in windows))
        print(f'{"":<52}' + ''.join(f'| {"CAGR":>6} {"maxDD":>6} {"Shrp":>5} {"in":>4} {"trd":>4} ' for _ in windows))
        rows = [(k, [stats(v, o, c, COST[sym], m, t) for _, m in windows]) for k, v in strat.items()]
        # overnight() is not reported here: futures and crypto daily bars have no real session gap (see the intraday script).
        for k, res in rows:
            print(f'{k:<52}' + ''.join(f'| {r["cagr"] * 100:6.1f} {r["dd"] * 100:6.0f} {r["sharpe"]:5.2f} {r["inmkt"] * 100:4.0f} {r["trades"]:4d} ' if r else f'| {"n/a":^29} ' for r in res))
        for (w, m) in windows:
            tot, dd = dca_bot(o, h, lo, c, m, COST[sym])
            print(f'    DCA bot (2% steps x1.5, 6 safety orders, +1.5% take profit), {w}: total {tot * 100:+.0f}% on reserved capital, max drawdown {dd * 100:.0f}%')


if __name__ == '__main__':
    main()
