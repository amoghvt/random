"""The standard published intraday "bot" strategies on 1-minute Nasdaq-100 index candles, New York cash session only.

Usage: python3 -I bot_strategies_intraday.py <dir of YYYY-MM-DD.bi5>   (Dukascopy USATECHIDXUSD)

Results are in index points for one unit (1 point = $1 per Vest NQ contract, $20 per CME NQ contract).
Cost: 1 point per side (2 per round trip). Stops fill 1 point worse. Stop before target inside a minute.
Every position is closed at 15:59 New York time. Volume is the CFD feed's tick volume (used only for VWAP).
"""
import collections
import datetime
import lzma
import os
import struct
import sys
import zoneinfo

import numpy as np

ET = zoneinfo.ZoneInfo('America/New_York')
SIDE = 1.0  # cost per side, points
N = 390


def load_sessions(folder):
    days = collections.OrderedDict()
    for fn in sorted(os.listdir(folder)):
        raw = open(os.path.join(folder, fn), 'rb').read()
        if not raw:
            continue
        try:
            data = lzma.decompress(raw)
        except lzma.LZMAError:
            continue
        base = datetime.datetime.fromisoformat(fn[:10]).replace(tzinfo=datetime.timezone.utc).timestamp()
        for k in range(len(data) // 24):
            s, o, c, lo, hi, v = struct.unpack('>IIIIIf', data[k * 24:k * 24 + 24])
            if v <= 0 and o == c == lo == hi:
                continue
            d = datetime.datetime.fromtimestamp(base + s, ET)
            m = d.hour * 60 + d.minute - 570
            if d.weekday() > 4 or not 0 <= m < N:
                continue
            days.setdefault(d.date().isoformat(), {})[m] = (o / 1000, hi / 1000, lo / 1000, c / 1000, v)
    names, arr = [], []
    for day, mm in days.items():
        if len(mm) < 380 or 0 not in mm:
            continue
        a = np.zeros((N, 5))
        last = None
        for m in range(N):
            if m in mm:
                last = mm[m]
                a[m] = last
            else:
                a[m] = (last[3], last[3], last[3], last[3], 0.0)
        names.append(day)
        arr.append(a)
    A = np.array(arr)
    return names, A[:, :, 0], A[:, :, 1], A[:, :, 2], A[:, :, 3], A[:, :, 4]


def walk(O, H, L, C, d, m0, side, entry, stop=None, target=None, m1=N - 1):
    """From minute m0 (entry already filled at `entry` at the start of m0) to the close: points before costs."""
    for m in range(m0, m1 + 1):
        if stop is not None and ((L[d, m] <= stop) if side == 1 else (H[d, m] >= stop)):
            return (stop - entry) * side - SIDE  # extra point of slippage on a stop
        if target is not None and m > m0 and ((H[d, m] >= target) if side == 1 else (L[d, m] <= target)):
            return (target - entry) * side
    return (C[d, m1] - entry) * side


def orb_first_candle(O, H, L, C, V, minutes=5, rr=10):
    out = []
    for d in range(len(O)):
        o, c = O[d, 0], C[d, minutes - 1]
        hi, lo = H[d, :minutes].max(), L[d, :minutes].min()
        if c == o:
            continue
        side = 1 if c > o else -1
        e = O[d, minutes]
        stop = lo if side == 1 else hi
        risk = (e - stop) * side
        if risk < 2:
            continue
        out.append((d, walk(O, H, L, C, d, minutes, side, e, stop, e + side * rr * risk) - 2 * SIDE))
    return out


def orb_breakout(O, H, L, C, V, minutes=15, stop_at='opposite', last_entry=360):
    out = []
    for d in range(len(O)):
        hi, lo = H[d, :minutes].max(), L[d, :minutes].min()
        if hi - lo < 4:
            continue
        for m in range(minutes, last_entry):
            up, dn = H[d, m] > hi, L[d, m] < lo
            if up and dn:
                break
            if up or dn:
                side = 1 if up else -1
                e = max(hi, O[d, m]) if up else min(lo, O[d, m])
                stop = (lo if up else hi) if stop_at == 'opposite' else (hi + lo) / 2
                # the entry minute can also hit the stop: handled by walk (adverse first)
                out.append((d, walk(O, H, L, C, d, m, side, e, stop) - 2 * SIDE))
                break
    return out


def noise_bands(O, H, L, C, V, lookback=14, use_vwap=False):
    """Zarattini, Aziz, Barbon (2024): trade outside the 'noise area' around the open, checked every half hour."""
    out = []
    move = np.abs(C / O[:, :1] - 1)
    tp = (H + L + C) / 3
    for d in range(lookback + 1, len(O)):
        sig = move[d - lookback:d].mean(axis=0)
        pc = C[d - 1, N - 1]
        ub = max(O[d, 0], pc) * (1 + sig)
        lb = min(O[d, 0], pc) * (1 - sig)
        vw = np.cumsum(tp[d] * V[d]) / np.maximum(np.cumsum(V[d]), 1e-9)
        pos, entry, pts, trades = 0, 0.0, 0.0, 0
        for m in range(29, N - 1, 30):
            c = C[d, m]
            want = pos
            if pos == 1 and c < (max(ub[m], vw[m]) if use_vwap else ub[m]):
                want = 0
            if pos == -1 and c > (min(lb[m], vw[m]) if use_vwap else lb[m]):
                want = 0
            if want == 0:
                want = 1 if c > ub[m] else -1 if c < lb[m] else 0
            if want != pos:
                px = O[d, m + 1]
                if pos:
                    pts += (px - entry) * pos - 2 * SIDE
                    trades += 1
                pos, entry = want, px
        if pos:
            pts += (C[d, N - 1] - entry) * pos - 2 * SIDE
            trades += 1
        if trades:
            out.append((d, pts))
    return out


def first_last_half_hour(O, H, L, C, V):
    out = []
    for d in range(1, len(O)):
        r = C[d, 29] / C[d - 1, N - 1] - 1
        if r == 0:
            continue
        side = 1 if r > 0 else -1
        out.append((d, (C[d, N - 1] - O[d, 360]) * side - 2 * SIDE))
    return out


def vwap_trend(O, H, L, C, V, bar=1):
    out = []
    tp = (H + L + C) / 3
    for d in range(len(O)):
        vw = np.cumsum(tp[d] * V[d]) / np.maximum(np.cumsum(V[d]), 1e-9)
        pos, entry, pts = 0, 0.0, 0.0
        for m in range(bar - 1, N - 1, bar):
            want = 1 if C[d, m] > vw[m] else -1 if C[d, m] < vw[m] else pos
            if want != pos:
                px = O[d, m + 1]
                if pos:
                    pts += (px - entry) * pos - 2 * SIDE
                pos, entry = want, px
        if pos:
            pts += (C[d, N - 1] - entry) * pos - 2 * SIDE
        out.append((d, pts))
    return out


def bars5(O, H, L, C):
    D = len(O)
    return (O[:, ::5], H.reshape(D, 78, 5).max(axis=2), L.reshape(D, 78, 5).min(axis=2), C[:, 4::5])


def ema_arr(x, n):
    out = np.empty(len(x))
    k, e = 2 / (n + 1), x[0]
    for i, v in enumerate(x):
        e = v * k + e * (1 - k)
        out[i] = e
    return out


def signal_follow(O, H, L, C, V, kind='supertrend'):
    """Always-in on 5-minute bars inside the session, flat at the close. Indicators run over the joined session bars."""
    o5, h5, l5, c5 = bars5(O, H, L, C)
    D = len(O)
    fo, fh, fl, fc = o5.ravel(), h5.ravel(), l5.ravel(), c5.ravel()
    if kind == 'ema':
        d = np.where(ema_arr(fc, 9) > ema_arr(fc, 21), 1, -1)
    else:
        pc = np.roll(fc, 1)
        pc[0] = fc[0]
        tr = np.maximum(fh - fl, np.maximum(abs(fh - pc), abs(fl - pc)))
        a = np.convolve(tr, np.ones(10) / 10, mode='full')[:len(tr)]
        mid = (fh + fl) / 2
        ub, lb = mid + 3 * a, mid - 3 * a
        d = np.ones(len(fc), dtype=int)
        for i in range(1, len(fc)):
            if not (ub[i] < ub[i - 1] or fc[i - 1] > ub[i - 1]):
                ub[i] = ub[i - 1]
            if not (lb[i] > lb[i - 1] or fc[i - 1] < lb[i - 1]):
                lb[i] = lb[i - 1]
            d[i] = 1 if fc[i] > ub[i - 1] else -1 if fc[i] < lb[i - 1] else d[i - 1]
    d = d.reshape(D, 78)
    out = []
    for day in range(1, D):
        pos, entry, pts = 0, 0.0, 0.0
        for b in range(77):
            want = d[day, b]
            if want != pos:
                px = o5[day, b + 1]
                if pos:
                    pts += (px - entry) * pos - 2 * SIDE
                pos, entry = want, px
        pts += (c5[day, 77] - entry) * pos - 2 * SIDE
        out.append((day, pts))
    return out


def bollinger_rsi(O, H, L, C, V):
    o5, h5, l5, c5 = bars5(O, H, L, C)
    D = len(O)
    fc = c5.ravel()
    n = len(fc)
    mid = np.convolve(fc, np.ones(20) / 20, mode='full')[:n]
    sd = np.array([fc[max(0, i - 19):i + 1].std() for i in range(n)])
    dlt = np.diff(fc, prepend=fc[0])
    au = ad = 0.0
    rsi = np.empty(n)
    for i in range(n):
        au = (au * 13 + max(dlt[i], 0)) / 14
        ad = (ad * 13 + max(-dlt[i], 0)) / 14
        rsi[i] = 100 - 100 / (1 + au / max(ad, 1e-12))
    tr = (h5 - l5).ravel()
    atr = np.convolve(tr, np.ones(14) / 14, mode='full')[:n]
    out = []
    for day in range(1, D):
        b = 0
        while b < 76:
            i = day * 78 + b
            side = 1 if (fc[i] < mid[i] - 2 * sd[i] and rsi[i] < 30) else -1 if (fc[i] > mid[i] + 2 * sd[i] and rsi[i] > 70) else 0
            if not side:
                b += 1
                continue
            e = o5[day, b + 1]
            stop = e - side * 1.5 * atr[i]
            pts, nb = None, 77
            for q in range(b + 1, 78):
                j = day * 78 + q
                if (l5[day, q] <= stop) if side == 1 else (h5[day, q] >= stop):
                    pts, nb = (stop - e) * side - SIDE, q
                    break
                if (fc[j] >= mid[j]) if side == 1 else (fc[j] <= mid[j]):
                    pts, nb = (fc[j] - e) * side, q
                    break
            if pts is None:
                pts = (c5[day, 77] - e) * side
            out.append((day, pts - 2 * SIDE))
            b = nb + 1
    return out


def gap_fade(O, H, L, C, V, min_gap=0.003):
    out = []
    for d in range(1, len(O)):
        pc, o = C[d - 1, N - 1], O[d, 0]
        g = o / pc - 1
        if abs(g) < min_gap:
            continue
        side = -1 if g > 0 else 1
        out.append((d, walk(O, H, L, C, d, 0, side, o, o - side * abs(o - pc), pc) - 2 * SIDE))
    return out


def sessions_split(O, H, L, C, V):
    on = [(d, O[d, 0] - C[d - 1, N - 1] - 2 * SIDE) for d in range(1, len(O))]
    day = [(d, C[d, N - 1] - O[d, 0] - 2 * SIDE) for d in range(len(O))]
    return on, day


def line(name, res, names, years):
    if not res:
        return f'{name:<58} no trades'
    p = np.array([x[1] for x in res])
    eq = np.cumsum(p)
    dd = (eq - np.maximum.accumulate(eq)).min()
    gp, gl = p[p > 0].sum(), -p[p < 0].sum()
    by = {y: 0.0 for y in years}
    for d, v in res:
        by[names[d][:4]] += v
    return (f'{name:<58} {len(p):5d} {(p > 0).mean() * 100:4.0f}% {p.mean():+7.1f} {eq[-1]:+9.0f} {gp / max(gl, 1e-9):5.2f} {dd:8.0f} | '
            + ' '.join(f'{by[y]:+8.0f}' for y in years))


def main():
    names, O, H, L, C, V = load_sessions(sys.argv[1])
    years = sorted({n[:4] for n in names})
    print(f'sessions {len(names)}  {names[0]} to {names[-1]}; index {O[0, 0]:.0f} -> {C[-1, -1]:.0f}')
    print(f'{"strategy (days or trades counted)":<58} {"n":>5} {"win":>5} {"avg":>7} {"total":>9} {"PF":>5} {"maxDD":>8} | ' + ' '.join(f'{y:>8}' for y in years))
    on, day = sessions_split(O, H, L, C, V)
    rows = [
        ('Hold the cash session (open to close), long', day),
        ('Hold overnight (close to next open), long', on),
        ('ORB: first 5m candle direction, stop its other end, 10R', orb_first_candle(O, H, L, C, V, 5)),
        ('ORB: first 15m candle direction, same', orb_first_candle(O, H, L, C, V, 15)),
        ('ORB 15m range breakout, stop opposite side', orb_breakout(O, H, L, C, V, 15)),
        ('ORB 30m range breakout, stop opposite side', orb_breakout(O, H, L, C, V, 30)),
        ('ORB 60m range breakout, stop opposite side', orb_breakout(O, H, L, C, V, 60)),
        ('ORB 30m range breakout, stop at the middle', orb_breakout(O, H, L, C, V, 30, 'mid')),
        ('Noise-band intraday momentum (half-hour checks)', noise_bands(O, H, L, C, V)),
        ('Noise-band momentum with VWAP trailing exit', noise_bands(O, H, L, C, V, use_vwap=True)),
        ('First half hour predicts last half hour', first_last_half_hour(O, H, L, C, V)),
        ('VWAP trend, 1-minute flips', vwap_trend(O, H, L, C, V, 1)),
        ('VWAP trend, 15-minute flips', vwap_trend(O, H, L, C, V, 15)),
        ('Supertrend (10,3) on 5m, always in', signal_follow(O, H, L, C, V)),
        ('EMA 9/21 cross on 5m, always in', signal_follow(O, H, L, C, V, 'ema')),
        ('Bollinger (20,2) + RSI(14) reversal on 5m', bollinger_rsi(O, H, L, C, V)),
        ('Gap fade (gap >= 0.3%), target prior close', gap_fade(O, H, L, C, V)),
    ]
    for name, res in rows:
        print(line(name, res, names, years))
    half = len(names) // 2
    print('\nFirst half of the history vs second half, total points:')
    for name, res in rows:
        a = sum(v for d, v in res if d < half)
        b = sum(v for d, v in res if d >= half)
        print(f'  {name:<58} {a:+9.0f} {b:+9.0f}')


if __name__ == '__main__':
    main()


# ───────── Account-aware check: minute-by-minute, so an intraday dip that breaches the drawdown counts ─────────
def noise_band_paths(O, H, L, C, V, lookback=14):
    """Per traded day: (day index, final points, worst running points during the day), costs included."""
    out = []
    move = np.abs(C / O[:, :1] - 1)
    for d in range(lookback + 1, len(O)):
        sig = move[d - lookback:d].mean(axis=0)
        pc = C[d - 1, N - 1]
        ub = max(O[d, 0], pc) * (1 + sig)
        lb = min(O[d, 0], pc) * (1 - sig)
        pos, entry, pts, worst, traded = 0, 0.0, 0.0, 0.0, False
        for m in range(N):
            if pos:
                adverse = (L[d, m] - entry) if pos == 1 else (entry - H[d, m])
                worst = min(worst, pts + adverse - 2 * SIDE)
            if m % 30 == 29 and m < N - 1:
                c = C[d, m]
                want = pos
                if pos == 1 and c < ub[m]:
                    want = 0
                if pos == -1 and c > lb[m]:
                    want = 0
                if want == 0:
                    want = 1 if c > ub[m] else -1 if c < lb[m] else 0
                if want != pos:
                    px = O[d, m + 1]
                    if pos:
                        pts += (px - entry) * pos - 2 * SIDE
                    pos, entry, traded = want, px, True
        if pos:
            pts += (C[d, N - 1] - entry) * pos - 2 * SIDE
        if traded:
            out.append((d, pts, min(worst, pts)))
    return out


def account(paths, contracts, room, fee):
    """Static drawdown `room` below the starting balance. Profit above the start is claimed at each day's close.
    A breach at any minute loses the account (cost: the fee) and a new one starts the next day."""
    deficit, blown, claimed = 0.0, 0, 0.0
    for _d, pts, worst in paths:
        if deficit + contracts * worst <= -room:
            blown += 1
            deficit = 0.0
            continue
        bal = deficit + contracts * pts
        if bal > 0:
            claimed += bal
            bal = 0.0
        deficit = bal
    return blown, claimed, claimed - blown * fee


def account_report(argv):
    names, O, H, L, C, V = load_sessions(argv[1])
    paths = noise_band_paths(O, H, L, C, V)
    yrs = len(names) / 252
    print(f'\nNoise-band momentum on a prop account, {len(paths)} traded days over {yrs:.1f} years')
    for label, room, fee, sizes in (('10k account, $400 drawdown, $400 fee', 400, 400, (0.5, 1, 2, 4, 9, 18.5)),
                                    ('50k account, $2,000 drawdown, $1,900 fee', 2000, 1900, (2, 5, 10, 20, 40))):
        print(f'  {label}')
        for ct in sizes:
            b, cl, net = account(paths, ct, room, fee)
            print(f'    {ct:>5} contracts: accounts lost {b:3d}, claimed ${cl:9,.0f}, net ${net:9,.0f}  (${net / yrs:8,.0f} a year)')
        half = len(paths) // 2
        for ct in sizes[1:4]:
            a, b2 = account(paths[:half], ct, room, fee)[2], account(paths[half:], ct, room, fee)[2]
            print(f'    {ct:>5} contracts, first half ${a:,.0f} | second half ${b2:,.0f}')


if __name__ == '__main__' and len(sys.argv) > 2 and sys.argv[2] == 'account':
    account_report(sys.argv)
