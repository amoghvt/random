"""Double tops / double bottoms (equal highs / equal lows) on 1-minute Nasdaq-100 index candles.

Usage: python3 -I double_top_study.py <dir of YYYY-MM-DD.bi5>   (Dukascopy USATECHIDXUSD, see ten_am_fade_backtest.py)

Pattern on a timeframe (5m, 15m, 1h), described for tops (bottoms are mirrored):
  - two consecutive swing highs (highest high of K bars each side), 5 to 60 bars apart,
  - within TOL x ATR(14) of each other, nothing higher in between,
  - the low between them (the neckline) at least 1.5 ATR below the tops,
  - known K bars after the second high; skipped if the neckline already broke by then.
Questions:
  1. RACE: from the moment the pattern is known, does price take the equal highs or the neckline first?
     Compared with the no-edge expectation for where price sits between the two (distance to neckline / height).
  2. TRADES, resolved on 1-minute bars, stop assumed hit before target inside a bar, 1 point slippage per side:
     A classic  : sell the neckline break, stop 2 pts above the tops, target one pattern height below the neckline.
     B early    : sell when the pattern is known, same stop, target the neckline.
     C sweep    : tops are taken, then a bar closes back below them within 3 bars: sell that close,
                  stop 2 pts above the sweep high, target the neckline.
     D breakout : buy the break of the tops, stop 1 ATR below them, target 2 ATR above.
"""
import bisect
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ten_am_fade_backtest import load  # noqa: E402

K = 3
SLIP = 1.0
HORIZON = 5 * 1440  # 1-minute bars


def aggregate(bars, tf):
    out = []  # [t, o, h, l, c, last 1m index]
    cur = None
    for i, (t, o, h, lo, c) in enumerate(bars):
        k = int(t // (tf * 60))
        if k != cur:
            out.append([t, o, h, lo, c, i])
            cur = k
        else:
            b = out[-1]
            if h > b[2]:
                b[2] = h
            if lo < b[3]:
                b[3] = lo
            b[4] = c
            b[5] = i
    return out


def indicators(tb):
    atr, ema = [], []
    trs = []
    e = None
    for i, b in enumerate(tb):
        pc = tb[i - 1][4] if i else b[4]
        trs.append(max(b[2] - b[3], abs(b[2] - pc), abs(b[3] - pc)))
        atr.append(sum(trs[-14:]) / len(trs[-14:]))
        e = b[4] if e is None else b[4] * 2 / 201 + e * 199 / 201
        ema.append(e)
    return atr, ema


def pivots(tb, sign):
    """Indices of swing highs (sign=+1) or swing lows (sign=-1)."""
    v = [b[2] if sign == 1 else -b[3] for b in tb]
    out = []
    for i in range(K, len(v) - K):
        w = v[i - K:i + K + 1]
        if v[i] == max(w) and w.index(v[i]) == K:
            out.append(i)
    return out


def scan(bars, j, stop, target, s):
    """Short (s=-1) or long (s=+1) from 1m index j: returns +1 target, -1 stop, 0 timeout with last close."""
    for i in range(j, min(j + HORIZON, len(bars))):
        _t, _o, h, lo, c = bars[i]
        if (h >= stop) if s == -1 else (lo <= stop):
            return -1, stop
        if (lo <= target) if s == -1 else (h >= target):
            return 1, target
    return 0, bars[min(j + HORIZON, len(bars)) - 1][4]


def trade_r(bars, j, entry, stop, target, s):
    risk = abs(stop - entry)
    if risk < 2:
        return None
    _why, px = scan(bars, j, stop, target, s)
    pts = (px - entry) * s - 2 * SLIP
    return pts / risk


def study(bars, tf, tol):
    tb = aggregate(bars, tf)
    atr, ema = indicators(tb)
    ends = [b[5] for b in tb]
    ev = []
    for sign in (1, -1):  # +1 double top, -1 double bottom
        pv = pivots(tb, sign)
        for a, b2 in zip(pv, pv[1:]):
            if not 5 <= b2 - a <= 60 or b2 + K >= len(tb) - 1 or a < 250:
                continue
            A = atr[b2]
            x1 = tb[a][2] if sign == 1 else tb[a][3]
            x2 = tb[b2][2] if sign == 1 else tb[b2][3]
            if abs(x1 - x2) > tol * A:
                continue
            seg = tb[a:b2 + 1]
            if sign == 1:
                top, neck = max(x1, x2), min(q[3] for q in seg)
                if max(q[2] for q in seg) > top or top - neck < 1.5 * A:
                    continue
                if min(q[3] for q in tb[b2:b2 + K + 1]) <= neck:
                    continue
            else:
                top, neck = min(x1, x2), max(q[2] for q in seg)
                if min(q[3] for q in seg) < top or neck - top < 1.5 * A:
                    continue
                if max(q[2] for q in tb[b2:b2 + K + 1]) >= neck:
                    continue
            conf = b2 + K
            p0 = tb[conf][4]
            j0 = ends[conf] + 1
            height = abs(top - neck)
            expected = abs(p0 - neck) / height  # no-edge chance the equal level is taken first
            # race on 1-minute bars
            first, jx = None, None
            for i in range(j0, min(j0 + HORIZON, len(bars))):
                _t, _o, h, lo, _c = bars[i]
                hit_top = (h > top) if sign == 1 else (lo < top)
                hit_neck = (lo < neck) if sign == 1 else (h > neck)
                if hit_top or hit_neck:
                    first, jx = ('level' if hit_top else 'neck'), i
                    break
            trend = 1 if tb[conf][4] > ema[conf] else -1
            e = dict(sign=sign, first=first, expected=expected, with_trend=(trend == -sign), year=_year(tb[conf][0]),
                     A=None, B=None, C=None, D=None, swept_rev=None)
            s = -sign  # direction of the reversal trade
            stop = top + 2 * sign
            # B early
            e['B'] = trade_r(bars, j0, p0, stop, neck, s)
            if first == 'neck':
                e['A'] = trade_r(bars, jx + 1, neck, stop, neck - sign * height, s)
            if first == 'level':
                # D breakout in the direction of the sweep
                e['D'] = trade_r(bars, jx + 1, top, top - sign * A, top + sign * 2 * A, sign)
                # C sweep then close back inside within 3 timeframe bars
                bi = bisect.bisect_left(ends, jx)
                e['swept_rev'] = False
                for q in range(bi, min(bi + 4, len(tb) - 1)):
                    c = tb[q][4]
                    if (c < top) if sign == 1 else (c > top):
                        ext = max(z[2] for z in tb[bi:q + 1]) if sign == 1 else min(z[3] for z in tb[bi:q + 1])
                        e['C'] = trade_r(bars, ends[q] + 1, c, ext + 2 * sign, neck, s)
                        e['swept_rev'] = True
                        break
            ev.append(e)
    return ev


def _year(t):
    import datetime
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).year


def rline(label, rs):
    rs = [r for r in rs if r is not None]
    if len(rs) < 10:
        return f'    {label:<28} n={len(rs)}'
    w = sum(r > 0 for r in rs)
    return f'    {label:<28} n={len(rs):4d}  win {w / len(rs) * 100:3.0f}%  avg {st.mean(rs):+.2f}R  total {sum(rs):+7.1f}R'


def report(name, ev):
    done = [e for e in ev if e['first']]
    if len(done) < 20:
        print(f'  {name}: n={len(done)}')
        return
    lvl = sum(e['first'] == 'level' for e in done) / len(done)
    exp = st.mean(e['expected'] for e in done)
    print(f'  {name}: n={len(done)} | equal level taken first {lvl * 100:.0f}% (no-edge expectation {exp * 100:.0f}%) | neckline first {(1 - lvl) * 100:.0f}%')
    sw = [e for e in done if e['first'] == 'level']
    if sw:
        print(f'    after the level is taken: closes back inside within 3 bars {sum(e["swept_rev"] for e in sw) / len(sw) * 100:.0f}%')
    for k, lab in (('A', 'A classic neckline break'), ('B', 'B early at the second top'), ('C', 'C sweep then reclaim'), ('D', 'D breakout through level')):
        print(rline(lab, [e[k] for e in done]))


def main():
    bars = load(sys.argv[1])
    print(f'1-minute bars {len(bars):,}')
    for tf in (5, 15, 60):
        for tol in (0.1, 0.25):
            ev = study(bars, tf, tol)
            print(f'\n=== {tf}m, highs/lows within {tol} ATR ===')
            report('ALL', ev)
            report('double tops', [e for e in ev if e['sign'] == 1])
            report('double bottoms', [e for e in ev if e['sign'] == -1])
            report('reversal WITH the 200 EMA trend', [e for e in ev if e['with_trend']])
            report('reversal AGAINST the trend', [e for e in ev if not e['with_trend']])
            if tol == 0.25:
                for y in sorted({e['year'] for e in ev}):
                    report(str(y), [e for e in ev if e['year'] == y])


if __name__ == '__main__':
    main()
