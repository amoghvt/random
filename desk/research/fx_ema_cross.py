"""EMA crossovers (always in the market, flip on the cross) on the seven major FX pairs, 1h and 4h closes.

Usage: python3 -I fx_ema_cross.py <dir of SYM.json Yahoo 1h chart files>
Cost 0.5 pip per side. Returns are unleveraged percent of price over the whole period.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fx_patterns as F  # noqa: E402

PAIRS_SET = ((9, 21), (20, 50), (20, 100), (50, 100), (50, 200), (60, 260), (100, 200), (100, 400))


def run(closes, f, s, cost):
    ef = es = closes[0]
    pos, total, half = 0, 0.0, [0.0, 0.0]
    mid = len(closes) // 2
    for i in range(1, len(closes)):
        r = closes[i] / closes[i - 1] - 1
        total += pos * r
        half[i >= mid] += pos * r
        ef = closes[i] * 2 / (f + 1) + ef * (1 - 2 / (f + 1))
        es = closes[i] * 2 / (s + 1) + es * (1 - 2 / (s + 1))
        want = 0 if i < s else (1 if ef > es else -1)
        if want != pos:
            c = abs(want - pos) * cost / closes[i]
            total -= c
            half[i >= mid] -= c
            pos = want
    return total, half


def main():
    for sec, label in ((3600, '1h'), (14400, '4h')):
        print(f'\n{label}: total % over the period (first half / second half), per pair, then the average')
        data = {p: [b[4] for b in F.aggregate(F.load('y', sys.argv[1], p), sec)] for p in F.PAIRS}
        for f, s in PAIRS_SET:
            cells, tot = [], []
            for p in F.PAIRS:
                t, h = run(data[p], f, s, 0.5 * F.pip(p))
                tot.append(t)
                cells.append(f'{p} {t * 100:+5.1f}')
            a = sum(tot) / len(tot) * 100
            print(f'  {f:>3}/{s:<3} ' + ' | '.join(cells) + f' | avg {a:+5.1f}% | pairs positive {sum(t > 0 for t in tot)}/7')


if __name__ == '__main__':
    main()
