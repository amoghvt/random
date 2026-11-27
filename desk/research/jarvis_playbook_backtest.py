"""Virtual backtest of a mechanical playbook for the Vest bot, inside Jarvis's own risk limits.

Usage: python3 -I jarvis_playbook_backtest.py <dir of Nasdaq 1-minute .bi5>

Direction: the session call (first half-hour check, 10:00 to 15:30 New York, where price is outside its normal range
from the open for that time of day). Only days with a call are traded, only in the called direction.
Entries tested after the call:
  call     enter at the next minute's open, fixed stop.
  ema1     wait for a pullback: a 1-minute bar touches the 1-minute EMA 20 and closes back beyond it; enter next open,
           stop 2 points past the low/high of the last three bars.
  ema5     the same on 5-minute bars and the 5-minute EMA 20; stop 2 points past the signal bar.
Limits (Jarvis config): stop between 5 and 40 points (60 for ema5), entries until 15:45, flat at 15:55, at most
`attempts` entries a day, no entry after a win.
Exit: stop, or target at a multiple of the stop distance, or the 15:55 close. Costs: 2 points per round trip, 1 more on a stop.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot_strategies_intraday as B  # noqa: E402

N = B.N
LAST_ENTRY, FLAT = 375, 385
COST, SLIP = 2.0, 1.0


def ema(x, n):
    out = np.empty(len(x))
    k, e = 2 / (n + 1), x[0]
    for i, v in enumerate(x):
        e = v * k + e * (1 - k)
        out[i] = e
    return out


def calls(O, C, names):
    move = np.abs(C / O[:, :1] - 1)
    close = C[:, N - 1]
    out = {}
    for d in range(60, len(O)):
        sig = move[d - 14:d].mean(axis=0)
        pc = C[d - 1, N - 1]
        ub = max(O[d, 0], pc) * (1 + sig)
        lb = min(O[d, 0], pc) * (1 - sig)
        for m in range(29, N - 31, 30):
            s = 1 if C[d, m] > ub[m] else -1 if C[d, m] < lb[m] else 0
            if s:
                out[d] = (m, s, (1 if pc > close[d - 50:d].mean() else -1) == s)
                break
    return out


def walk(O, H, L, C, d, k, s, entry, stop, target):
    """From minute k (filled at its open). Returns (points before costs, exit minute, 'stop'|'target'|'time')."""
    for m in range(k, FLAT + 1):
        if (L[d, m] <= stop) if s == 1 else (H[d, m] >= stop):
            return (stop - entry) * s - SLIP, m, 'stop'
        if target is not None and m > k and ((H[d, m] >= target) if s == 1 else (L[d, m] <= target)):
            return (target - entry) * s, m, 'target'
    return (C[d, FLAT] - entry) * s, FLAT, 'time'


def run(O, H, L, C, names, cl, entry_kind, rr, attempts=1, fixed_stop=40.0, trend_only=True, e1=None, e5=None, c5=None, h5=None, l5=None):
    trades = []
    for d, (m, s, wt) in cl.items():
        if trend_only and not wt:
            continue
        k = m + 1
        tries = 0
        while k <= LAST_ENTRY and tries < attempts:
            entry = stop = None
            if entry_kind == 'call':
                if tries:
                    break
                entry, stop = O[d, k], O[d, k] - s * fixed_stop
            elif entry_kind == 'ema1':
                for q in range(k, LAST_ENTRY):
                    touched = (L[d, q] <= e1[d, q - 1]) if s == 1 else (H[d, q] >= e1[d, q - 1])
                    back = (C[d, q] > e1[d, q]) if s == 1 else (C[d, q] < e1[d, q])
                    if touched and back:
                        ext = L[d, q - 2:q + 1].min() if s == 1 else H[d, q - 2:q + 1].max()
                        en = O[d, q + 1]
                        risk = (en - (ext - 2 * s)) * s
                        if 5 <= risk <= 40:
                            entry, stop, k = en, ext - 2 * s, q + 1
                            break
            else:  # ema5
                for b in range(k // 5 + 1, LAST_ENTRY // 5):
                    touched = (l5[d, b] <= e5[d, b - 1]) if s == 1 else (h5[d, b] >= e5[d, b - 1])
                    back = (c5[d, b] > e5[d, b]) if s == 1 else (c5[d, b] < e5[d, b])
                    if touched and back:
                        ext = l5[d, b] if s == 1 else h5[d, b]
                        q = (b + 1) * 5
                        en = O[d, q]
                        risk = (en - (ext - 2 * s)) * s
                        if 5 <= risk <= 60:
                            entry, stop, k = en, ext - 2 * s, q
                            break
            if entry is None:
                break
            risk = (entry - stop) * s
            pts, mx, why = walk(O, H, L, C, d, k, s, entry, stop, None if rr is None else entry + s * rr * risk)
            trades.append(dict(d=d, pts=pts - COST, risk=risk, why=why, year=names[d][:4], wt=wt))
            tries += 1
            if why != 'stop':
                break
            k = mx + 1
    return trades


def summary(label, t, half):
    if len(t) < 20:
        return f'  {label:<46} n={len(t)}'
    p = np.array([x['pts'] for x in t])
    r = np.array([x['pts'] / x['risk'] for x in t])
    eq = np.cumsum(r)
    by = {}
    for x in t:
        by[x['year']] = by.get(x['year'], 0.0) + x['pts'] / x['risk']
    a = sum(x['pts'] / x['risk'] for x in t if x['d'] < half)
    b = sum(x['pts'] / x['risk'] for x in t if x['d'] >= half)
    return (f'  {label:<46} n={len(t):4d} win {(p > 0).mean() * 100:3.0f}% | avg {r.mean():+.2f}R ({p.mean():+5.1f} pts) | total {r.sum():+6.1f}R | worst run {(eq - np.maximum.accumulate(eq)).min():+5.1f}R'
            f' | median stop {np.median([x["risk"] for x in t]):3.0f} | halves {a:+5.1f} / {b:+5.1f} | ' + ' '.join(f'{y} {by[y]:+.0f}' for y in sorted(by)))


def account(t, room, fee, risk_usd, cap_units):
    """Static drawdown; each trade risks `risk_usd` (less when the remaining room is smaller); profit is claimed daily."""
    deficit, lost, claimed = 0.0, 0, 0.0
    for x in t:
        left = room + deficit
        units = min(cap_units, min(risk_usd, 0.9 * left) / (x['risk'] + SLIP + COST))
        deficit += x['pts'] * units
        if deficit <= -room * 0.999:
            lost += 1
            deficit = 0.0
        elif deficit > 0:
            claimed += deficit
            deficit = 0.0
    return lost, claimed, claimed - lost * fee


def main():
    names, O, H, L, C, V = B.load_sessions(sys.argv[1])
    D = len(O)
    cl = calls(O, C, names)
    e1 = ema(C.ravel(), 20).reshape(D, N)
    c5 = C[:, 4::5]
    h5 = H.reshape(D, 78, 5).max(axis=2)
    l5 = L.reshape(D, 78, 5).min(axis=2)
    e5 = ema(c5.ravel(), 20).reshape(D, 78)
    kw = dict(e1=e1, e5=e5, c5=c5, h5=h5, l5=l5)
    half = (60 + D) // 2
    yrs = (D - 60) / 252
    print(f'sessions {D - 60} ({yrs:.1f} years), days with a call {len(cl)}, with the 50-day trend {sum(1 for v in cl.values() if v[2])}')
    keep = {}
    for trend_only in (True, False):
        print(f'\n=== {"WITH-TREND calls only" if trend_only else "ALL calls"} ===')
        for kind, variants in (('call', [(20.0, 1), (40.0, 1)]), ('ema1', [(None, 1), (None, 2)]), ('ema5', [(None, 1), (None, 2)])):
            for fs, att in variants:
                for rr in (1.5, 2.0, 3.0, None):
                    lab = f'{kind}{"" if fs is None else f" stop {fs:.0f}"}, {att} attempt{"s" if att > 1 else ""}, ' + ('hold to 15:55' if rr is None else f'target {rr}R')
                    t = run(O, H, L, C, names, cl, kind, rr, attempts=att, fixed_stop=fs or 40.0, trend_only=trend_only, **kw)
                    print(summary(lab, t, half))
                    keep[(trend_only, lab)] = t
    print('\n=== On Vest accounts (the rows that were positive in both halves, with-trend calls) ===')
    for (to, lab), t in keep.items():
        if not to or len(t) < 20:
            continue
        a = sum(x['pts'] / x['risk'] for x in t if x['d'] < half)
        b = sum(x['pts'] / x['risk'] for x in t if x['d'] >= half)
        if a <= 0 or b <= 0:
            continue
        print(f'  {lab}')
        for name, room, fee, risks, cap in (('10k / $400', 400, 400, (100, 200, 320), 18.5), ('50k / $2,000', 2000, 1900, (500, 1000, 1600), 92.5)):
            for ru in risks:
                lost, claimed, net = account(t, room, fee, ru, cap)
                h1 = account([x for x in t if x['d'] < half], room, fee, ru, cap)[2]
                h2 = account([x for x in t if x['d'] >= half], room, fee, ru, cap)[2]
                print(f'      {name:<13} risk ${ru:>5} a trade: accounts lost {lost:3d} | claimed ${claimed:9,.0f} | net ${net:9,.0f} (${net / yrs / 12:7,.0f} a month) | halves ${h1:8,.0f} / ${h2:8,.0f}')


if __name__ == '__main__':
    main()
