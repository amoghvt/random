"""A daily buy/sell call for the Nasdaq from layered information, tested walk-forward.

Usage: python3 -I daily_direction_model.py <dir with Yahoo daily chart json: QQQ ^VIX ^VIX3M ^TNX DX-Y.NYB HYG TLT SMH IWM>

Two calls are tested on QQQ (the Nasdaq-100 ETF, whose open and close are the New York cash session):
  DAY call     made at the close, for the next close-to-close move (includes the overnight gap).
  SESSION call made at the open, for that day's open-to-close move, knowing the overnight gap.
Layers (all known at decision time): price state (returns, where the close sat in the day's range, RSI 2, distance from the
20- and 200-day averages, volatility), fear (VIX level, change, and VIX against 3-month VIX), rates (10-year yield change),
the dollar, credit (high-yield bonds), long bonds, chips and small caps against the index, and the calendar.
Model: logistic regression with L2 penalty, refitted every 250 trading days on all earlier data only (never on the future).
Costs: 1 basis point per side each time the position changes.
"""
import datetime
import json
import math
import os
import sys

import numpy as np


def series(folder, name):
    d = json.load(open(os.path.join(folder, name + '.json')))['chart']['result'][0]
    q = d['indicators']['quote'][0]
    out = {}
    for t, o, h, lo, c in zip(d['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if None in (o, h, lo, c) or c <= 0:
            continue
        out[datetime.datetime.fromtimestamp(t, datetime.timezone.utc).date()] = (o, h, lo, c)
    return out


def aligned(folder, dates, name):
    s = series(folder, name)
    out, last = [], None
    for d in dates:
        if d in s:
            last = s[d][3]
        out.append(np.nan if last is None else last)
    return np.array(out)


def sma(x, n):
    out = np.full(len(x), np.nan)
    cs = np.cumsum(np.insert(x, 0, 0.0))
    out[n - 1:] = (cs[n:] - cs[:-n]) / n
    return out


def chg(x, n=1):
    out = np.full(len(x), np.nan)
    out[n:] = x[n:] / x[:-n] - 1
    return out


def rsi(c, n):
    d = np.diff(c, prepend=c[0])
    a = b = 0.0
    out = np.empty(len(c))
    for i in range(len(c)):
        a = (a * (n - 1) + max(d[i], 0)) / n
        b = (b * (n - 1) + max(-d[i], 0)) / n
        out[i] = 100 - 100 / (1 + a / max(b, 1e-12))
    return out


def fit_logit(X, y, l2=10.0, iters=30):
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (p - y) + l2 * np.r_[0, w[1:]]
        H = (X * (p * (1 - p))[:, None]).T @ X + l2 * np.diag(np.r_[0, np.ones(X.shape[1] - 1)])
        w -= np.linalg.solve(H, g)
    return w


def walk_forward(F, y, start, step=250):
    """Out-of-sample probability of an up move for every row from `start` on."""
    p = np.full(len(y), np.nan)
    w_last = None
    for a in range(start, len(y), step):
        mu, sd = F[:a].mean(axis=0), F[:a].std(axis=0) + 1e-12
        X = np.c_[np.ones(a), (F[:a] - mu) / sd]
        w = fit_logit(X, y[:a])
        b = min(a + step, len(y))
        p[a:b] = 1 / (1 + np.exp(-np.c_[np.ones(b - a), (F[a:b] - mu) / sd] @ w))
        w_last = w
    return p, w_last


def perf(pos, r, dates, cost=0.0001):
    turn = np.abs(np.diff(np.insert(pos, 0, 0.0)))
    net = pos * r - turn * cost
    eq = np.cumprod(1 + net)
    yrs = (dates[-1] - dates[0]).days / 365.25
    return (eq[-1] ** (1 / yrs) - 1) * 100, (eq / np.maximum.accumulate(eq) - 1).min() * 100, net.mean() / (net.std() + 1e-12) * math.sqrt(252)


def report(title, p, r, dates, start):
    p, r, dates = p[start:], r[start:], dates[start:]
    up = r > 0
    print(f'\n===== {title} =====  out-of-sample {dates[0]} to {dates[-1]}, {len(r)} days')
    call = p > 0.5
    print(f'  up days {up.mean() * 100:.1f}% | the call was right {(call == up).mean() * 100:.1f}% of days | "buy" given on {call.mean() * 100:.0f}% of days')
    print('  by confidence (probability of an up day):')
    edges = [0, 0.45, 0.48, 0.52, 0.55, 0.60, 1.01]
    for lo, hi in zip(edges, edges[1:]):
        m = (p >= lo) & (p < hi)
        if m.sum() >= 20:
            print(f'    {lo:.2f}-{min(hi, 1):.2f}: days {m.sum():5d} | up {up[m].mean() * 100:5.1f}% | average move {r[m].mean() * 1e4:+6.1f} bp')
    strategies = [('always long (hold)', np.ones(len(r))), ('long when buy, cash when sell', call.astype(float)),
                  ('long when buy, short when sell', np.where(call, 1.0, -1.0)),
                  ('long above 0.55, short below 0.45, else cash', np.where(p > 0.55, 1.0, np.where(p < 0.45, -1.0, 0.0))),
                  ('long above 0.52, cash otherwise', (p > 0.52).astype(float))]
    periods = [('all', np.ones(len(r), bool))]
    n = len(r)
    for k in range(3):
        m = np.zeros(n, bool)
        m[k * n // 3:(k + 1) * n // 3] = True
        periods.append((f'{dates[k * n // 3].year}-{dates[(k + 1) * n // 3 - 1].year}', m))
    m = np.zeros(n, bool)
    m[-252:] = True
    periods.append(('last year', m))
    print(f'  {"":<46}' + ''.join(f'| {lab:^22} ' for lab, _ in periods))
    print(f'  {"strategy":<46}' + ''.join(f'| {"%/yr":>6} {"maxDD":>6} {"Shrp":>6}   ' for _ in periods))
    for name, pos in strategies:
        row = ''
        for _lab, m in periods:
            c, dd, sh = perf(pos[m], r[m], dates[m])
            row += f'| {c:6.1f} {dd:6.0f} {sh:6.2f}   '
        print(f'  {name:<46}{row}')


def main():
    folder = sys.argv[1]
    q = series(folder, 'QQQ')
    dates = np.array(sorted(q))
    o, h, lo, c = (np.array([q[d][k] for d in dates]) for k in range(4))
    vix, vix3, tnx, dxy = (aligned(folder, dates, s) for s in ('^VIX', '^VIX3M', '^TNX', 'DX-Y.NYB'))
    hyg, tlt, smh, iwm = (aligned(folder, dates, s) for s in ('HYG', 'TLT', 'SMH', 'IWM'))
    n = len(c)
    r1 = chg(c)
    ibs = (c - lo) / np.maximum(h - lo, 1e-9)
    rng = (h - lo) / c
    streak = np.zeros(n)
    for i in range(1, n):
        streak[i] = (streak[i - 1] - 1 if streak[i - 1] < 0 else -1) if c[i] < c[i - 1] else (streak[i - 1] + 1 if streak[i - 1] > 0 else 1)
    vol20 = np.array([np.nan] * 20 + [np.nanstd(r1[i - 19:i + 1]) for i in range(20, n)])
    wd = np.array([d.weekday() for d in dates])
    month = np.array([d.month for d in dates])
    nxt_wd = np.r_[wd[1:], (wd[-1] + 1) % 5]
    # turn of the month for the NEXT trading day: it is the last trading day of a month or one of the first three
    last_of_month = np.r_[month[1:] != month[:-1], False]
    dom_rank = np.zeros(n)
    for i in range(1, n):
        dom_rank[i] = 0 if month[i] != month[i - 1] else dom_rank[i - 1] + 1
    next_is_tom = np.r_[(last_of_month[1:] | (dom_rank[1:] <= 2)), False].astype(float)
    feats = {
        'yesterday return': r1, '2-day return': chg(c, 2), '5-day return': chg(c, 5), '20-day return': chg(c, 20),
        'close position in the day range (IBS)': ibs, 'RSI 2': rsi(c, 2) / 100, 'distance from 20-day average': c / sma(c, 20) - 1,
        'distance from 200-day average': c / sma(c, 200) - 1, 'above 200-day average': (c > sma(c, 200)).astype(float),
        'day range vs normal': rng / sma(rng, 20), 'up/down streak': streak, '20-day volatility': vol20,
        'VIX level (log)': np.log(vix), 'VIX 1-day change': chg(vix), 'VIX vs its 20-day average': vix / sma(vix, 20) - 1,
        'VIX / 3-month VIX': vix / vix3, '10-year yield 1-day change': np.r_[np.nan, np.diff(tnx)], '10-year yield 5-day change': np.r_[[np.nan] * 5, tnx[5:] - tnx[:-5]],
        'dollar 1-day change': chg(dxy), 'dollar 5-day change': chg(dxy, 5), 'high-yield bonds 1-day': chg(hyg), 'high-yield bonds 5-day': chg(hyg, 5),
        'long bonds 1-day': chg(tlt), 'chips vs index, 5-day': chg(smh, 5) - chg(c, 5), 'small caps vs index, 5-day': chg(iwm, 5) - chg(c, 5),
        'next day is Monday': (nxt_wd == 0).astype(float), 'next day is Friday': (nxt_wd == 4).astype(float), 'next day is turn of month': next_is_tom,
    }
    names = list(feats)
    F = np.column_stack([feats[k] for k in names])
    # DAY call: features at close t -> return close t to close t+1
    y_ret = np.r_[c[1:] / c[:-1] - 1, np.nan]
    ok = ~np.isnan(F).any(axis=1) & ~np.isnan(y_ret)
    first = np.argmax(ok)
    Fd, rd, dd = F[first:-1], y_ret[first:-1], dates[first + 1:]  # date of the day being predicted
    keep = ~np.isnan(Fd).any(axis=1)
    Fd, rd, dd = Fd[keep], rd[keep], dd[keep]
    start = 1250
    p, w = walk_forward(Fd, (rd > 0).astype(float), start)
    report('DAY call (made at the close, for the next close-to-close move)', p, rd, dd, start)
    order = np.argsort(-np.abs(w[1:]))
    print('  what the model leans on (latest fit; + means it raises the chance of an up day):')
    for k in order[:10]:
        print(f'    {names[k]:<40} {w[k + 1]:+.3f}')
    # SESSION call: add the overnight gap, predict open -> close of the same day
    gap = np.r_[np.nan, o[1:] / c[:-1] - 1]
    sess = c / o - 1
    Fs = np.column_stack([F[:-1], gap[1:], np.abs(gap[1:])])
    rs, ds = sess[1:], dates[1:]
    keep = ~np.isnan(Fs).any(axis=1)
    Fs, rs, ds = Fs[keep], rs[keep], ds[keep]
    p2, w2 = walk_forward(Fs, (rs > 0).astype(float), start)
    report('SESSION call (made at the open, for that day open-to-close)', p2, rs, ds, start)
    names2 = names + ['overnight gap', 'size of the overnight gap']
    order = np.argsort(-np.abs(w2[1:]))
    print('  what the model leans on:')
    for k in order[:8]:
        print(f'    {names2[k]:<40} {w2[k + 1]:+.3f}')
    print(f'\n  latest DAY-call reading: for {dd[-1]} the model gave an up-probability of {p[-1]:.2f}')


if __name__ == '__main__':
    main()
