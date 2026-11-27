"""Buying same-day (0DTE) at-the-money calls or puts on the session direction call. MODELLED prices, not option quotes.

Usage: python3 -I session_call_options.py <dir of Nasdaq 1-minute .bi5> <Yahoo ^VXN daily chart json>

For each first call of the day (see session_direction_signal.py): buy an at-the-money option on the index expiring at
that day's close, at the next minute's open. Price = Black-Scholes with zero rates, volatility = the prior day's VXN
close times a multiplier (0.6 to 1.3 shown, since real same-day implied volatility is not in
this data), time measured in trading minutes. Cost: 4% of the premium paid on entry and 4% of the value on any early exit.
Exits: hold to the close (intrinsic value), or sell at +100% of premium, with or without a -50% stop.
Results are per $1 of premium: +1.00 means the stake doubled, -1.00 means it expired worthless.
"""
import datetime
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot_strategies_intraday as B  # noqa: E402

YEAR_MIN = 252 * 390
FEE = 0.04


def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(spot, strike, vol, minutes, call):
    if minutes <= 0:
        return max(0.0, (spot - strike) if call else (strike - spot))
    t = minutes / YEAR_MIN
    sd = vol * math.sqrt(t)
    d1 = (math.log(spot / strike) + 0.5 * sd * sd) / sd
    d2 = d1 - sd
    return spot * ncdf(d1) - strike * ncdf(d2) if call else strike * ncdf(-d2) - spot * ncdf(-d1)


def main():
    names, O, H, L, C, V = B.load_sessions(sys.argv[1])
    d = json.load(open(sys.argv[2]))['chart']['result'][0]
    vxn = {datetime.datetime.fromtimestamp(t, datetime.timezone.utc).date().isoformat(): c for t, c in zip(d['timestamp'], d['indicators']['quote'][0]['close']) if c}
    vdays = sorted(vxn)
    N = B.N
    move = np.abs(C / O[:, :1] - 1)
    close = C[:, N - 1]
    calls = []
    for day in range(60, len(O)):
        sig = move[day - 14:day].mean(axis=0)
        pc = C[day - 1, N - 1]
        ub = max(O[day, 0], pc) * (1 + sig)
        lb = min(O[day, 0], pc) * (1 - sig)
        for m in range(29, N - 31, 30):
            s = 1 if C[day, m] > ub[m] else -1 if C[day, m] < lb[m] else 0
            if s:
                prev = [v for v in vdays if v < names[day]]
                if prev:
                    calls.append(dict(day=day, m=m + 1, s=s, vol=vxn[prev[-1]] / 100, with_trend=(1 if pc > close[day - 50:day].mean() else -1) == s))
                break

    def run(mult, take=None, stop=None, subset=lambda c: True):
        out = []
        for c in calls:
            if not subset(c):
                continue
            day, m, s = c['day'], c['m'], c['s']
            spot = O[day, m]
            vol = c['vol'] * mult
            prem = bs(spot, spot, vol, N - m, s == 1) * (1 + FEE)
            res = None
            if take or stop:
                for k in range(m, N - 1):
                    left = N - 1 - k
                    hi = bs(H[day, k] if s == 1 else L[day, k], spot, vol, left, s == 1)
                    lo = bs(L[day, k] if s == 1 else H[day, k], spot, vol, left, s == 1)
                    if stop and lo <= prem * (1 - stop):
                        res = prem * (1 - stop) * (1 - FEE) / prem - 1
                        break
                    if take and hi >= prem * (1 + take) and k > m:
                        res = (1 + take) * (1 - FEE) - 1
                        break
            if res is None:
                res = max(0.0, (C[day, N - 1] - spot) * s) / prem - 1
            out.append((names[day][:4], res, prem, max(0.0, (C[day, N - 1] - spot) * s)))
        return out

    def line(label, v):
        r = np.array([x[1] for x in v])
        by = {}
        for y, x, _p, _i in v:
            by[y] = by.get(y, 0.0) + x
        eq = np.cumsum(r)
        streak = cur = 0
        for x in r:
            cur = cur + 1 if x < 0 else 0
            streak = max(streak, cur)
        print(f'  {label:<52} n={len(r):4d} | made money {(r > 0).mean() * 100:3.0f}% | avg per $1 {r.mean():+.2f} | median {np.median(r):+.2f} | expired worthless {(r <= -0.999).mean() * 100:3.0f}% | '
              f'total {r.sum():+7.1f} | worst run {(eq - np.maximum.accumulate(eq)).min():+6.1f} | longest losing streak {streak} | ' + ' '.join(f'{y} {by[y]:+.0f}' for y in sorted(by)))

    base = run(1.0)
    prem = np.array([x[2] for x in base])
    print(f'calls {len(calls)} | typical modelled premium {np.median(prem):.0f} index points ({np.median(prem) / np.median(O[60:, 0]) * 100:.2f}% of the index), typical time left {np.median([N - c["m"] for c in calls]):.0f} minutes')
    for mult in (0.6, 0.8, 1.0, 1.3):
        print(f'\nVolatility = {mult} x prior-day VXN')
        line('hold to the close, all calls', run(mult))
        line('hold to the close, with the 50-day trend', run(mult, subset=lambda c: c['with_trend']))
        line('hold to the close, against the trend', run(mult, subset=lambda c: not c['with_trend']))
        line('sell at +100%, else hold, with trend', run(mult, take=1.0, subset=lambda c: c['with_trend']))
        line('sell at +100%, stop at -50%, with trend', run(mult, take=1.0, stop=0.5, subset=lambda c: c['with_trend']))
        line('sell at +200%, else hold, with trend', run(mult, take=2.0, subset=lambda c: c['with_trend']))
        line('with trend, call fired at 10:00 only, hold', run(mult, subset=lambda c: c['with_trend'] and c['m'] == 30))


if __name__ == '__main__':
    main()
