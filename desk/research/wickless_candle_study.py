"""Wickless trend candles: does price come back to the open of a candle with no bottom wick (uptrend) / no top wick
(downtrend), and does buying / selling that level pay?

Usage: python3 -I wickless_candle_study.py <dir of YYYY-MM-DD.bi5>   (Dukascopy USATECHIDXUSD 1-minute candles)

Signal on a timeframe, described for longs (shorts mirrored):
  - trend: close above EMA 200 and EMA 50 above EMA 200 on that timeframe,
  - a bullish candle whose open is its low (open - low <= 3% of ATR 14),
  - level = that candle's open.
Control: the same bullish trend candles that DO have a bottom wick, level = their open.
Return: does price trade back to the level within 5 / 20 bars after the candle closes.
Trade: limit order at the level, valid 20 bars; stop a multiple of ATR beyond it; target in R; held up to 100 bars.
Resolved on 1-minute bars: stop before target inside a bar, nothing good counted in the fill minute,
1 point cost per trade plus 1 point slippage on stops.
"""
import datetime
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ten_am_fade_backtest import load  # noqa: E402
from double_top_study import aggregate  # noqa: E402

COST, SLIP = 1.0, 1.0
STOPS = (0.5, 1.0, 1.5)
TARGETS = (1, 2, 3)


def indicators(tb):
    atr, trs, e50, e200 = [], [], [], []
    a = b = None
    for i, x in enumerate(tb):
        pc = tb[i - 1][4] if i else x[4]
        trs.append(max(x[2] - x[3], abs(x[2] - pc), abs(x[3] - pc)))
        atr.append(sum(trs[-14:]) / len(trs[-14:]))
        a = x[4] if a is None else x[4] * 2 / 51 + a * 49 / 51
        b = x[4] if b is None else x[4] * 2 / 201 + b * 199 / 201
        e50.append(a)
        e200.append(b)
    return atr, e50, e200


def signals(tb, atr, e50, e200, trend='with'):
    out = []
    for i in range(250, len(tb) - 2):
        _t, o, h, lo, c, _j = tb[i]
        A = atr[i - 1]
        if A <= 0 or c == o:
            continue
        s = 1 if c > o else -1
        tr = 1 if (c > e200[i] and e50[i] > e200[i]) else -1 if (c < e200[i] and e50[i] < e200[i]) else 0
        if trend == 'with' and tr != s:
            continue
        if trend == 'counter' and tr != -s:
            continue
        wick = (o - lo) if s == 1 else (h - o)
        out.append(dict(i=i, s=s, level=o, atr=A, wickless=wick <= 0.03 * A, body=abs(c - o) / A, wick=wick / A))
    return out


def resolve(bars, tb, sig, tf):
    """Fill time and, per stop multiple, the 1-minute path needed to score any target."""
    i, s, L = sig['i'], sig['s'], sig['level']
    j0 = tb[i][5] + 1
    fill = None
    for j in range(j0, min(j0 + 20 * tf, len(bars))):
        if (bars[j][3] <= L) if s == 1 else (bars[j][2] >= L):
            fill = j
            break
    sig['fill_bars'] = None if fill is None else (fill - j0) / tf
    sig['res'] = {}
    if fill is None:
        return
    end = min(fill + 100 * tf, len(bars))
    for sm in STOPS:
        risk = sm * sig['atr']
        stop = L - s * risk
        best = 0.0
        stopped = False
        reach = {}  # target multiple -> reached before the stop
        for j in range(fill, end):
            _t, _o, h, lo, _c = bars[j]
            if (lo <= stop) if s == 1 else (h >= stop):
                stopped = True
                break
            if j > fill:
                fav = (h - L) if s == 1 else (L - lo)
                if fav > best:
                    best = fav
                    if best >= TARGETS[-1] * risk:
                        break
        last = (bars[end - 1][4] - L) * s
        for tm in TARGETS:
            if best >= tm * risk:
                reach[tm] = (tm * risk - COST) / risk
            elif stopped:
                reach[tm] = (-risk - COST - SLIP) / risk
            else:
                reach[tm] = (last - COST) / risk
        sig['res'][sm] = reach


def grid(sigs):
    rows = []
    for sm in STOPS:
        cells = []
        for tm in TARGETS:
            rs = [g['res'][sm][tm] for g in sigs if g['res']]
            cells.append(f'{sum(r > 0 for r in rs) / len(rs) * 100:3.0f}% {st.mean(rs):+.2f}R' if len(rs) >= 20 else '   n<20   ')
        rows.append(f'      stop {sm:.1f} ATR | ' + ' | '.join(f'{tm}R: {c}' for tm, c in zip(TARGETS, cells)))
    return '\n'.join(rows)


def taps(sigs):
    n = len(sigs)
    f = [g['fill_bars'] for g in sigs]
    return (f'n={n:5d} | back to the level within 5 bars {sum(x is not None and x <= 5 for x in f) / n * 100:3.0f}%,'
            f' within 20 bars {sum(x is not None for x in f) / n * 100:3.0f}%')


def year(tb, g):
    return datetime.datetime.fromtimestamp(tb[g['i']][0], datetime.timezone.utc).year


def main():
    bars = load(sys.argv[1])
    print(f'1-minute bars {len(bars):,}')
    for tf in (3, 5, 15, 60, 240):
        tb = aggregate(bars, tf)
        atr, e50, e200 = indicators(tb)
        sg = signals(tb, atr, e50, e200)
        for g in sg:
            resolve(bars, tb, g, tf)
        wl = [g for g in sg if g['wickless']]
        ctl = [g for g in sg if not g['wickless']]
        print(f'\n===== {tf}m =====  trend candles {len(sg)}, wickless {len(wl)} ({len(wl) / len(sg) * 100:.0f}%)')
        print('  WICKLESS, with trend:   ', taps(wl))
        print(grid(wl))
        print('  CONTROL (has a wick):   ', taps(ctl))
        print(grid(ctl))
        big = [g for g in wl if g['body'] >= 0.7]
        if len(big) >= 30:
            print('  WICKLESS, body >= 0.7 ATR:', taps(big))
            print(grid(big))
        for lab, sub in (('longs', [g for g in wl if g['s'] == 1]), ('shorts', [g for g in wl if g['s'] == -1])):
            if len(sub) >= 30:
                print(f'  WICKLESS {lab}:', taps(sub))
                print(grid(sub))
        ct = signals(tb, atr, e50, e200, trend='counter')
        ct = [g for g in ct if g['wickless']]
        for g in ct:
            resolve(bars, tb, g, tf)
        if len(ct) >= 30:
            print('  WICKLESS, AGAINST trend:', taps(ct))
            print(grid(ct))
        print('  WICKLESS by year (stop 1.0 ATR): ' + ' | '.join(
            f"{y}: n={len(v)} 1R {st.mean(g['res'][1.0][1] for g in v):+.2f} 2R {st.mean(g['res'][1.0][2] for g in v):+.2f}"
            for y in sorted({year(tb, g) for g in wl})
            for v in [[g for g in wl if year(tb, g) == y and g['res']]] if len(v) >= 10))


if __name__ == '__main__':
    main()
