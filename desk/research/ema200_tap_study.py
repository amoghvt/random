"""200 EMA taps as support / resistance on the Nasdaq-100: 15-minute and 4-hour (1-minute resolution) and daily.

Usage: python3 -I ema200_tap_study.py <dir of YYYY-MM-DD.bi5> [yahoo ^NDX daily chart json]

Tap, described for support (resistance mirrored):
  - the last 5 closes are all above the 200 EMA (price is established on that side),
  - since the previous tap, a close has been at least 1.5 ATR(14) above the EMA (price left before coming back),
  - price trades down to the EMA. Entry: limit at the EMA value of the previous bar (or the open if it gaps through).
  - taps are numbered from the moment price established itself on that side; the count resets when the side flips.
Stop: a multiple of ATR beyond the entry. Target in R. Held up to 100 bars.
Intraday timeframes are resolved on 1-minute bars; daily on daily bars. Stop before target inside a bar, nothing good
counted in the fill bar, 1 point cost per trade plus 1 point slippage on stops.
"""
import datetime
import json
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
    atr, trs, ema = [], [], []
    e = None
    for i, x in enumerate(tb):
        pc = tb[i - 1][4] if i else x[4]
        trs.append(max(x[2] - x[3], abs(x[2] - pc), abs(x[3] - pc)))
        atr.append(sum(trs[-14:]) / len(trs[-14:]))
        e = x[4] if e is None else x[4] * 2 / 201 + e * 199 / 201
        ema.append(e)
    return atr, ema


def taps(tb, atr, ema):
    out = []
    side, armed, count = 0, False, 0
    for i in range(400, len(tb) - 1):
        last5 = [tb[k][4] - ema[k] for k in range(i - 5, i)]
        new_side = 1 if all(d > 0 for d in last5) else -1 if all(d < 0 for d in last5) else 0
        if new_side and new_side != side:
            side, armed, count = new_side, False, 0
        if not side:
            continue
        A, L = atr[i - 1], ema[i - 1]
        if (tb[i - 1][4] - L) * side >= 1.5 * A:
            armed = True
        _t, o, h, lo, _c, _j = tb[i]
        touched = (lo <= L) if side == 1 else (h >= L)
        if armed and touched and new_side == side:
            count += 1
            entry = min(o, L) if side == 1 else max(o, L)
            out.append(dict(i=i, s=side, entry=entry, atr=A, n=count, slope=(ema[i - 1] - ema[i - 21]) * side > 0, res={}))
            armed = False
    return out


def score(path, entry, s, atr):
    """path: iterable of (high, low, close) from the fill bar on; the first item is the fill bar."""
    res = {}
    for sm in STOPS:
        risk = sm * atr
        stop = entry - s * risk
        best, stopped, last = 0.0, False, entry
        for k, (h, lo, c) in enumerate(path):
            last = c
            if (lo <= stop) if s == 1 else (h >= stop):
                stopped = True
                break
            if k:
                best = max(best, (h - entry) if s == 1 else (entry - lo))
                if best >= TARGETS[-1] * risk:
                    break
        res[sm] = {tm: ((tm * risk - COST) if best >= tm * risk else (-risk - COST - SLIP) if stopped else ((last - entry) * s - COST)) / risk for tm in TARGETS}
    return res


def resolve_1m(bars, tb, g, tf):
    j0 = tb[g['i'] - 1][5] + 1
    fill = next((j for j in range(j0, tb[g['i']][5] + 1) if ((bars[j][3] <= g['entry']) if g['s'] == 1 else (bars[j][2] >= g['entry']))), j0)
    end = min(fill + 100 * tf, len(bars))
    g['res'] = score([(b[2], b[3], b[4]) for b in bars[fill:end]], g['entry'], g['s'], g['atr'])


def resolve_tf(tb, g):
    g['res'] = score([(b[2], b[3], b[4]) for b in tb[g['i']:g['i'] + 100]], g['entry'], g['s'], g['atr'])


def grid(sub, label):
    if len(sub) < 8:
        print(f'  {label}: n={len(sub)}')
        return
    print(f'  {label}: n={len(sub)}')
    for sm in STOPS:
        cells = []
        for tm in TARGETS:
            rs = [g['res'][sm][tm] for g in sub]
            cells.append(f'{tm}R: {sum(r > 0 for r in rs) / len(rs) * 100:3.0f}% {st.mean(rs):+.2f}R (total {sum(rs):+6.1f}R)')
        print(f'      stop {sm:.1f} ATR | ' + ' | '.join(cells))


def year(tb, g):
    return datetime.datetime.fromtimestamp(tb[g['i']][0], datetime.timezone.utc).year


def report(name, tb, sg, by=1):
    yrs = (tb[-1][0] - tb[400][0]) / 86400 / 365.25
    print(f'\n===== {name} =====  taps {len(sg)} over {yrs:.1f} years ({len(sg) / yrs / 12:.1f} a month)')
    grid(sg, 'ALL taps')
    grid([g for g in sg if g['n'] == 1], 'first tap')
    grid([g for g in sg if g['n'] == 2], 'second tap')
    grid([g for g in sg if g['n'] >= 3], 'third tap or later')
    grid([g for g in sg if g['slope']], 'EMA sloping with the trade')
    grid([g for g in sg if not g['slope']], 'EMA sloping against the trade')
    grid([g for g in sg if g['s'] == 1], 'support (longs)')
    grid([g for g in sg if g['s'] == -1], 'resistance (shorts)')
    ys = sorted({year(tb, g) // by * by for g in sg})
    print('  by period (stop 1.0 ATR, 2R): ' + ' | '.join(
        f"{y}: n={len(v)} {st.mean(g['res'][1.0][2] for g in v):+.2f}R" for y in ys for v in [[g for g in sg if year(tb, g) // by * by == y]]))


def main():
    bars = load(sys.argv[1])
    print(f'1-minute bars {len(bars):,}')
    for tf, name in ((15, '15-minute 200 EMA'), (240, '4-hour 200 EMA')):
        tb = aggregate(bars, tf)
        atr, ema = indicators(tb)
        sg = taps(tb, atr, ema)
        for g in sg:
            resolve_1m(bars, tb, g, tf)
        report(name, tb, sg)
    if len(sys.argv) > 2:
        d = json.load(open(sys.argv[2]))['chart']['result'][0]
        q = d['indicators']['quote'][0]
        tb = [[t, o, h, lo, c, 0] for t, o, h, lo, c in zip(d['timestamp'], q['open'], q['high'], q['low'], q['close']) if None not in (o, h, lo, c)]
        atr, ema = indicators(tb)
        sg = taps(tb, atr, ema)
        for g in sg:
            resolve_tf(tb, g)
        report('DAILY 200 EMA (Nasdaq-100 index, daily bars)', tb, sg, by=10)
        recent = [g for g in sg if year(tb, g) >= 2016]
        grid(recent, 'daily, 2016 onward')
        print('  last taps:', [(datetime.datetime.fromtimestamp(tb[g['i']][0], datetime.timezone.utc).date().isoformat(), 'long' if g['s'] == 1 else 'short', f"tap {g['n']}", f"{g['res'][1.0][2]:+.1f}R") for g in sg[-8:]])


if __name__ == '__main__':
    main()
