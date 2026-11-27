"""A session direction call that can be checked: the first time the Nasdaq leaves its normal range for that time of day.

Usage: python3 -I session_direction_signal.py <dir of Nasdaq 1-minute .bi5>

Signal (the noise-band rule from bot_strategies_intraday.py, first trigger of the day only): at each half hour from 10:00,
if price is above  max(open, prior close) x (1 + the 14-day average move from the open at that time)  the call is UP,
below the mirrored level the call is DOWN. Measured from the next minute's open to the 15:59 close, no stop, no costs.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot_strategies_intraday as B  # noqa: E402


def main():
    names, O, H, L, C, V = B.load_sessions(sys.argv[1])
    N = B.N
    move = np.abs(C / O[:, :1] - 1)
    daily_close = C[:, N - 1]
    rows = []
    for d in range(60, len(O)):
        sig = move[d - 14:d].mean(axis=0)
        pc = C[d - 1, N - 1]
        ub = max(O[d, 0], pc) * (1 + sig)
        lb = min(O[d, 0], pc) * (1 - sig)
        for m in range(29, N - 31, 30):
            s = 1 if C[d, m] > ub[m] else -1 if C[d, m] < lb[m] else 0
            if s:
                e = O[d, m + 1]
                to_close = (C[d, N - 1] - e) * s
                worst = (e - L[d, m + 1:].min()) if s == 1 else (H[d, m + 1:].max() - e)
                best = (H[d, m + 1:].max() - e) if s == 1 else (e - L[d, m + 1:].min())
                trend = 1 if pc > daily_close[d - 50:d].mean() else -1
                gap = 1 if O[d, 0] > pc else -1
                rows.append(dict(d=d, m=m + 1, s=s, pts=to_close, worst=worst, best=best, with_trend=trend == s, with_gap=gap == s, year=names[d][:4]))
                break
    print(f'sessions {len(O) - 60}, days with a call {len(rows)} ({len(rows) / (len(O) - 60) * 100:.0f}%)')

    def show(label, v):
        if len(v) < 15:
            print(f'  {label:<44} n={len(v)}')
            return
        p = np.array([x['pts'] for x in v])
        print(f'  {label:<44} n={len(v):4d} | closed further in the called direction {(p > 0).mean() * 100:3.0f}% | average {p.mean():+6.1f} pts | median {np.median(p):+6.1f}'
              f' | typical heat against {np.median([x["worst"] for x in v]):4.0f} pts | typical best run {np.median([x["best"] for x in v]):4.0f} pts')
    show('ALL calls', rows)
    show('UP calls', [x for x in rows if x['s'] == 1])
    show('DOWN calls', [x for x in rows if x['s'] == -1])
    show('call agrees with the 50-day trend', [x for x in rows if x['with_trend']])
    show('call against the 50-day trend', [x for x in rows if not x['with_trend']])
    show('call agrees with the overnight gap', [x for x in rows if x['with_gap']])
    show('call against the overnight gap', [x for x in rows if not x['with_gap']])
    for lab, a, b in (('first call at 10:00', 30, 30), ('first call 10:30-11:30', 60, 120), ('first call 12:00-13:30', 150, 240), ('first call 14:00 or later', 270, 400)):
        show(lab, [x for x in rows if a <= x['m'] <= b])
    for y in sorted({x['year'] for x in rows}):
        show(y, [x for x in rows if x['year'] == y])
    show('last 60 calls', rows[-60:])


if __name__ == '__main__':
    main()
