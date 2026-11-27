"""Astral's published starter strategies: hourly loser / winner rotation across BTC, ETH, SOL.

Usage: python3 -I astral_rotation_test.py <dir with Yahoo 1h chart json for BTC-USD ETH-USD SOL-USD>

Rule (from Astral's strategy reference): each hour buy whichever of the three fell most (loser) or rose most (winner)
over the last completed hour, hold 2 hours, 20% of capital per pick. Two picks overlap, so 40% is deployed.
Fills at the hourly close. Fee per side: 0 (Astral's backtest default), 0.1% (perps), 0.5% (Astral's Solana fee).
"""
import json
import math
import os
import sys

import numpy as np


def main():
    series = {}
    for s in ('BTC-USD', 'ETH-USD', 'SOL-USD'):
        d = json.load(open(os.path.join(sys.argv[1], s + '.json')))['chart']['result'][0]
        series[s] = {t - t % 3600: c for t, c in zip(d['timestamp'], d['indicators']['quote'][0]['close']) if c}
    ts = sorted(set.intersection(*(set(v) for v in series.values())))
    ts = [t for i, t in enumerate(ts) if i >= 3 and ts[i] - ts[i - 3] == 3 * 3600 and i + 2 < len(ts) and ts[i + 2] - t == 7200]
    P = {s: v for s, v in series.items()}
    years = (ts[-1] - ts[0]) / 86400 / 365.25
    print(f'hours tested {len(ts)} over {years:.2f} years')
    hold = {s: P[s][ts[-1]] / P[s][ts[0]] - 1 for s in P}
    print('buy and hold: ' + ', '.join(f'{s} {v * 100:+.0f}%' for s, v in hold.items()))
    for kind in ('loser', 'winner'):
        gross = []
        for t in ts:
            r = {s: P[s][t] / P[s][t - 3600] - 1 for s in P}
            pick = min(r, key=r.get) if kind == 'loser' else max(r, key=r.get)
            gross.append(P[pick][t + 7200] / P[pick][t] - 1)
        g = np.array(gross)
        half = len(g) // 2
        for fee in (0.0, 0.001, 0.005):
            net = 0.2 * (g - 2 * fee)  # 20% of capital per pick
            eq = np.cumprod(1 + net)
            dd = (eq / np.maximum.accumulate(eq) - 1).min()
            a, b = np.prod(1 + net[:half]) - 1, np.prod(1 + net[half:]) - 1
            print(f'  {kind:<6} fee {fee * 100:.1f}% per side: avg trade {g.mean() * 1e4 - 2 * fee * 1e4:+6.1f} bp, win {(g > 2 * fee).mean() * 100:.0f}%, '
                  f'total {(eq[-1] - 1) * 100:+7.1f}%, max drawdown {dd * 100:.0f}%, first half {a * 100:+.0f}%, second half {b * 100:+.0f}%')


if __name__ == '__main__':
    main()
