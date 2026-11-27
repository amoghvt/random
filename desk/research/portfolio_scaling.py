"""What the best tested intraday rules make per month at size, and what drawdown that takes.

Usage: python3 -I portfolio_scaling.py <dir of Nasdaq 1-minute .bi5> [<dir of gold 1-minute .bi5>]

Rules (see bot_strategies_intraday.py): noise-band intraday momentum and the 30-minute opening range breakout,
one unit each, on the New York cash session, costs included. Dollars use the CME NQ contract ($20 a point).
"""
import collections
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot_strategies_intraday as B  # noqa: E402


def monthly(names, daily):
    m = collections.OrderedDict()
    for d, v in daily.items():
        m[names[d][:7]] = m.get(names[d][:7], 0.0) + v
    return m


def describe(label, names, daily, usd_per_pt):
    days = sorted(daily)
    p = np.array([daily[d] for d in days])
    eq = np.cumsum(p)
    dd = (eq - np.maximum.accumulate(eq)).min()
    mo = np.array(list(monthly(names, daily).values()))
    # longest stretch below a previous equity high, in trading days
    under, longest = 0, 0
    peak = -1e18
    for v in eq:
        if v >= peak:
            peak, under = v, 0
        else:
            under += 1
            longest = max(longest, under)
    print(f'\n{label}')
    print(f'  months {len(mo)} | average month {mo.mean():+.0f} pts | median {np.median(mo):+.0f} | positive months {(mo > 0).mean() * 100:.0f}% | '
          f'worst month {mo.min():+.0f} | best {mo.max():+.0f} | max drawdown {dd:.0f} pts | longest time under water {longest} trading days')
    print(f'  worst day {p.min():+.0f} pts | monthly Sharpe (annualised) {mo.mean() / mo.std() * 12 ** 0.5:.2f}')
    print('  monthly points: ' + ' '.join(f'{v:+.0f}' for v in mo))
    print('  To AVERAGE this much a month you need this many units, and must be able to sit through this drawdown:')
    for goal in (10_000, 50_000, 100_000):
        units = goal / (mo.mean() * usd_per_pt)
        print(f'    ${goal:>7,} a month: {units:6.1f} contracts | worst month ${mo.min() * usd_per_pt * units:>10,.0f} | max drawdown ${dd * usd_per_pt * units:>10,.0f}'
              f' | worst day ${p.min() * usd_per_pt * units:>9,.0f} | losing months {(mo < 0).mean() * 100:.0f}%')
    return mo


def main():
    names, O, H, L, C, V = B.load_sessions(sys.argv[1])
    nb = dict((d, v) for d, v in B.noise_bands(O, H, L, C, V))
    orb = dict((d, v) for d, v in B.orb_breakout(O, H, L, C, V, 30))
    both = {d: nb.get(d, 0.0) + orb.get(d, 0.0) for d in set(nb) | set(orb)}
    print(f'Nasdaq sessions {len(names)}  {names[0]} to {names[-1]}')
    describe('NOISE-BAND MOMENTUM, 1 unit', names, nb, 20)
    describe('30-MINUTE OPENING RANGE BREAKOUT, 1 unit', names, orb, 20)
    describe('BOTH TOGETHER, 1 unit each (2 contracts per "unit" at most)', names, both, 20)
    a = np.array([nb.get(d, 0.0) for d in range(len(names))])
    b = np.array([orb.get(d, 0.0) for d in range(len(names))])
    print(f'\n  daily correlation between the two: {np.corrcoef(a, b)[0, 1]:.2f}')
    if len(sys.argv) > 2:
        gn, GO, GH, GL, GC, GV = B.load_sessions(sys.argv[2])
        B.SIDE = 0.15
        g = dict((d, v) for d, v in B.noise_bands(GO, GH, GL, GC, GV))
        go = dict((d, v) for d, v in B.orb_breakout(GO, GH, GL, GC, GV, 30))
        print(f'\nGold sessions {len(gn)}  {gn[0]} to {gn[-1]} (cost $0.15 per side; $100 a point on the CME GC contract)')
        describe('GOLD noise-band momentum, 1 unit', gn, g, 100)
        describe('GOLD 30-minute opening range breakout, 1 unit', gn, go, 100)


if __name__ == '__main__':
    main()
