"""Gold (XAUUSD) pattern study on Dukascopy hourly BID candles, one .bi5 per month (records >IIIIIf: seconds from the
start of the month, open, close, low, high, volume; prices x1000).

Usage: python3 -I gold_study.py <folder with XAUUSD_YYYY-MM.bi5, EURUSD_..., USATECHIDXUSD_...>

Every pattern is reported for an early period and a late period (split at 2020-01-01). A pattern is only called
consistent when both halves agree. Trading rules carry a round-trip cost of 0.03% of price.
"""
import collections
import datetime
import glob
import lzma
import math
import os
import statistics as st
import struct
import sys
import zoneinfo

ET = zoneinfo.ZoneInfo('America/New_York')
UTC = datetime.timezone.utc
SPLIT = '2020-01-01'
COST = 0.0003
SCALE = {'XAUUSD': 1000.0, 'EURUSD': 100000.0, 'USATECHIDXUSD': 1000.0}


def load(folder, sym):
    bars = []
    for fn in sorted(glob.glob(os.path.join(folder, f'{sym}_*.bi5'))):
        raw = open(fn, 'rb').read()
        if not raw:
            continue
        data = lzma.decompress(raw)
        y, m = int(fn[-11:-7]), int(fn[-6:-4])
        base = datetime.datetime(y, m, 1, tzinfo=UTC).timestamp()
        k = SCALE[sym]
        for i in range(len(data) // 24):
            s, o, c, lo, hi, v = struct.unpack('>IIIIIf', data[i * 24:i * 24 + 24])
            if v <= 0 and o == c == lo == hi:
                continue
            d = datetime.datetime.fromtimestamp(base + s, ET)
            bars.append(dict(t=base + s, o=o / k, h=hi / k, l=lo / k, c=c / k, hour=d.hour, wd=d.weekday(),
                             # the trading day rolls at 17:00 New York time
                             day=(d + datetime.timedelta(hours=7)).date().isoformat()))
    return bars


def daily(bars):
    out = collections.OrderedDict()
    for b in bars:
        d = out.get(b['day'])
        if d is None:
            out[b['day']] = dict(day=b['day'], o=b['o'], h=b['h'], l=b['l'], c=b['c'], n=1)
        else:
            d['h'] = max(d['h'], b['h']); d['l'] = min(d['l'], b['l']); d['c'] = b['c']; d['n'] += 1
    return [d for d in out.values() if d['n'] >= 12]


def stats(xs):
    if len(xs) < 8:
        return f'n={len(xs):4d}'
    m = st.mean(xs); sd = st.pstdev(xs) or 1e-12
    return f"n={len(xs):5d} mean {m * 100:+.3f}% t={m / (sd / math.sqrt(len(xs))):+5.2f} up {sum(x > 0 for x in xs) / len(xs) * 100:3.0f}%"


def halves(label, pairs):
    """pairs: (day, value). Prints early / late / all."""
    a = [v for d, v in pairs if d < SPLIT]; b = [v for d, v in pairs if d >= SPLIT]
    print(f'  {label:<44} early {stats(a)} | late {stats(b)}')


def perf(label, pairs, per_year=False):
    """pairs: (day, fractional return per trade). Sum, mean, win rate, worst drawdown, by half and optionally by year."""
    def line(v):
        if len(v) < 5:
            return f'n={len(v):3d}'
        cum = peak = dd = 0.0
        for x in v:
            cum += x; peak = max(peak, cum); dd = max(dd, peak - cum)
        w = [x for x in v if x > 0]; gl = -sum(x for x in v if x <= 0)
        return f"n={len(v):4d} win {len(w) / len(v) * 100:3.0f}% avg {st.mean(v) * 100:+.3f}% total {sum(v) * 100:+7.1f}% PF {(sum(w) / gl if gl else 9.99):4.2f} maxDD {dd * 100:5.1f}%"
    a = [v for d, v in pairs if d < SPLIT]; b = [v for d, v in pairs if d >= SPLIT]
    print(f'  {label}\n      early: {line(a)}\n      late:  {line(b)}')
    if per_year:
        by = collections.defaultdict(list)
        for d, v in pairs:
            by[d[:4]].append(v)
        print('      by year: ' + '  '.join(f"{y} {sum(v) * 100:+.0f}%" for y, v in sorted(by.items())))


def ema(xs, n):
    k = 2 / (n + 1); e = None; out = []
    for x in xs:
        e = x if e is None else x * k + e * (1 - k); out.append(e)
    return out


def atr(D, n=14):
    out = []; trs = []
    for i, d in enumerate(D):
        tr = d['h'] - d['l'] if i == 0 else max(d['h'] - d['l'], abs(d['h'] - D[i - 1]['c']), abs(d['l'] - D[i - 1]['c']))
        trs.append(tr); out.append(sum(trs[-n:]) / len(trs[-n:]))
    return out


def main():
    folder = sys.argv[1]
    G = load(folder, 'XAUUSD')
    D = daily(G)
    print(f"gold hourly bars {len(G):,} | days {len(D)} | {D[0]['day']} to {D[-1]['day']} | last {D[-1]['c']:.1f}")
    byday = collections.defaultdict(list)
    for b in G:
        byday[b['day']].append(b)

    print('\nA. HOUR OF DAY (New York time): average return of each hourly bar')
    hrs = collections.defaultdict(list)
    for b in G:
        hrs[b['hour']].append((b['day'], b['c'] / b['o'] - 1))
    for h in range(24):
        halves(f'{h:02d}:00-{(h + 1) % 24:02d}:00', hrs[h])

    print('\nB. SESSIONS (New York time): return from session start to session end')
    S = {'Asia 18:00-03:00': (18, 3), 'London 03:00-08:00': (3, 8), 'NY morning 08:00-12:00': (8, 12), 'NY afternoon 12:00-17:00': (12, 17)}
    sess = collections.defaultdict(list)
    for day, bs in byday.items():
        for name, (a, z) in S.items():
            w = [b for b in bs if (a <= b['hour'] or b['hour'] < z) if a > z] if a > z else [b for b in bs if a <= b['hour'] < z]
            if len(w) >= 3:
                sess[name].append((day, w[-1]['c'] / w[0]['o'] - 1))
    for name in S:
        halves(name, sess[name])
    smap = {name: dict(v) for name, v in sess.items()}
    print('  does one session predict the next? (average next-session return after an up vs a down session)')
    order = list(S)
    for a, b in zip(order, order[1:]):
        up = [(d, smap[b][d]) for d, v in smap[a].items() if v > 0.001 and d in smap[b]]
        dn = [(d, smap[b][d]) for d, v in smap[a].items() if v < -0.001 and d in smap[b]]
        halves(f'{b.split()[0]} after {a.split()[0]} UP >0.1%', up); halves(f'{b.split()[0]} after {a.split()[0]} DOWN', dn)

    print('\nC. DAY OF WEEK (close to close) and turn of month')
    dow = collections.defaultdict(list)
    rets = [(D[i]['day'], D[i]['c'] / D[i - 1]['c'] - 1) for i in range(1, len(D))]
    for d, r in rets:
        dow[datetime.date.fromisoformat(d).weekday()].append((d, r))
    for k, nm in enumerate(('Mon', 'Tue', 'Wed', 'Thu', 'Fri')):
        halves(nm, dow[k])
    tdom = {}
    seen = collections.Counter()
    for d, _r in rets:
        seen[d[:7]] += 1
        tdom[d] = seen[d[:7]]
    halves('first 3 trading days of the month', [(d, r) for d, r in rets if tdom[d] <= 3])
    halves('trading days 4 onward', [(d, r) for d, r in rets if tdom[d] > 3])
    halves('all days', rets)

    print('\nD. DAILY TREND FOLLOWING (cost charged on every change of position)')
    closes = [d['c'] for d in D]; A = atr(D)
    def run_signal(sig):
        out = []; pos = 0
        for i in range(1, len(D)):
            r = closes[i] / closes[i - 1] - 1
            new = sig(i - 1)
            pnl = pos * r
            if new != pos:
                pnl -= COST * abs(new - pos) / 1.0
            out.append((D[i]['day'], pnl)); pos = new
        return out
    e50 = ema(closes, 50); e200 = ema(closes, 200); e20 = ema(closes, 20)
    perf('long when close > 200-day EMA, flat otherwise', run_signal(lambda i: 1 if i > 200 and closes[i] > e200[i] else 0), True)
    perf('long/short on 50-day vs 200-day EMA', run_signal(lambda i: 0 if i < 200 else (1 if e50[i] > e200[i] else -1)), True)
    perf('long/short on sign of the 60-day return', run_signal(lambda i: 0 if i < 60 else (1 if closes[i] > closes[i - 60] else -1)), True)
    def donch(n_in, n_out):
        state = {'p': 0}
        def sig(i):
            if i < n_in:
                return 0
            hi = max(d['h'] for d in D[i - n_in:i]); lo = min(d['l'] for d in D[i - n_in:i])
            xh = max(d['h'] for d in D[i - n_out:i]); xl = min(d['l'] for d in D[i - n_out:i])
            p = state['p']
            if p == 0:
                p = 1 if closes[i] > hi else -1 if closes[i] < lo else 0
            elif p == 1 and closes[i] < xl:
                p = 0
            elif p == -1 and closes[i] > xh:
                p = 0
            state['p'] = p
            return p
        return sig
    perf('Donchian: enter on a 20-day breakout, exit on a 10-day reversal', run_signal(donch(20, 10)), True)
    perf('Donchian: enter on a 55-day breakout, exit on a 20-day reversal', run_signal(donch(55, 20)), True)
    perf('buy and hold', rets, True)

    print('\nE. DAILY MEAN REVERSION: next-day return after a large move (in ATRs)')
    for thr in (1.0, 1.5, 2.0):
        dn = [(D[i + 1]['day'], closes[i + 1] / closes[i] - 1) for i in range(20, len(D) - 1) if closes[i] - closes[i - 1] <= -thr * A[i - 1]]
        up = [(D[i + 1]['day'], closes[i + 1] / closes[i] - 1) for i in range(20, len(D) - 1) if closes[i] - closes[i - 1] >= thr * A[i - 1]]
        halves(f'after a drop of {thr} ATR or more', dn); halves(f'after a rise of {thr} ATR or more', up)
    up3 = [(D[i + 1]['day'], closes[i + 1] / closes[i] - 1) for i in range(5, len(D) - 1) if all(closes[i - k] > closes[i - k - 1] for k in range(3))]
    dn3 = [(D[i + 1]['day'], closes[i + 1] / closes[i] - 1) for i in range(5, len(D) - 1) if all(closes[i - k] < closes[i - k - 1] for k in range(3))]
    halves('after 3 up days in a row', up3); halves('after 3 down days in a row', dn3)
    pull = [(D[i + 1]['day'], closes[min(len(D) - 1, i + 3)] / closes[i] - 1) for i in range(200, len(D) - 3) if closes[i] > e200[i] and closes[i] < e20[i] and closes[i] < closes[i - 1] < closes[i - 2]]
    halves('uptrend (>200d), 2 down days below the 20d EMA: next 3 days', pull)

    print('\nF. INTRADAY RULES ON HOURLY BARS (New York time; one trade a day; 0.03% cost)')
    idx = {d['day']: i for i, d in enumerate(D)}
    def day_trend(day):
        i = idx.get(day)
        if i is None or i < 201:
            return 0
        return 1 if closes[i - 1] > e200[i - 1] and e50[i - 1] > e200[i - 1] else -1 if closes[i - 1] < e200[i - 1] and e50[i - 1] < e200[i - 1] else 0
    def breakout(range_from, range_to, start, end, mode, trend_only=False, fade=False):
        out = []
        for day, bs in byday.items():
            if datetime.date.fromisoformat(day).weekday() > 4:
                continue
            rng = [b for b in bs if (range_from <= b['hour'] or b['hour'] < range_to)] if range_from > range_to else [b for b in bs if range_from <= b['hour'] < range_to]
            win = [b for b in bs if start <= b['hour'] < end]
            if len(rng) < 4 or len(win) < 3:
                continue
            hi = max(b['h'] for b in rng); lo = min(b['l'] for b in rng)
            if hi - lo <= 0:
                continue
            tr = day_trend(day)
            pos = 0; ent = stop = None; res = None
            for b in win:
                if pos == 0:
                    up, dn = b['h'] > hi, b['l'] < lo
                    if up and dn:
                        break
                    if up or dn:
                        s = 1 if up else -1
                        if fade:
                            s = -s
                        if trend_only and tr != s:
                            break
                        pos = s; ent = hi if up else lo
                        mid = (hi + lo) / 2
                        stop = (mid if mode == 'mid' else (lo if up else hi)) if not fade else (ent + (hi - lo) * 0.5 * (1 if up else -1))
                        continue
                else:
                    if (b['l'] <= stop) if pos == 1 else (b['h'] >= stop):
                        res = pos * (stop / ent - 1); break
            if pos != 0:
                if res is None:
                    res = pos * (win[-1]['c'] / ent - 1)
                out.append((day, res - COST))
        return out
    perf('London breakout of the Asia range (18:00-03:00), held to 12:00, stop at mid-range', breakout(18, 3, 3, 12, 'mid'), True)
    perf('  same, only in the direction of the daily trend', breakout(18, 3, 3, 12, 'mid', True), True)
    perf('  same, FADED (sell the break of the Asia high, buy the break of the low)', breakout(18, 3, 3, 12, 'mid', False, True))
    perf('NY breakout of the London range (03:00-08:00), held to 16:00, stop at mid-range', breakout(3, 8, 8, 16, 'mid'), True)
    perf('  same, only in the direction of the daily trend', breakout(3, 8, 8, 16, 'mid', True), True)
    perf('  same, FADED', breakout(3, 8, 8, 16, 'mid', False, True))

    print('\n   Hourly trend pullback: daily trend, pullback to the 1h EMA 50, hourly close back in the trend; stop beyond the pullback, target 3R')
    hc = [b['c'] for b in G]; h20 = ema(hc, 20); h50 = ema(hc, 50); h200 = ema(hc, 200)
    def pullback(tgt, level):
        out = []; busy = -1
        for i in range(300, len(G) - 2):
            if i < busy:
                continue
            b = G[i]; tr = day_trend(b['day'])
            if tr == 0 or (1 if hc[i] > h200[i] else -1) != tr:
                continue
            lv = (h50 if level == 50 else h20)[i]
            touched = (b['l'] <= lv) if tr == 1 else (b['h'] >= lv)
            closed = (b['c'] > lv and b['c'] > b['o']) if tr == 1 else (b['c'] < lv and b['c'] < b['o'])
            if not (touched and closed):
                continue
            ent = G[i + 1]['o']; ext = min(x['l'] for x in G[i - 3:i + 1]) if tr == 1 else max(x['h'] for x in G[i - 3:i + 1])
            risk = (ent - ext) if tr == 1 else (ext - ent)
            if risk <= ent * 0.0005:
                continue
            res = None
            for j in range(i + 1, min(len(G), i + 1 + 72)):
                x = G[j]; adv = (ent - x['l']) if tr == 1 else (x['h'] - ent); fav = (x['h'] - ent) if tr == 1 else (ent - x['l'])
                if adv >= risk:
                    res = -1.0; break
                if fav >= tgt * risk:
                    res = float(tgt); break
            if res is None:
                j = min(len(G) - 1, i + 72); res = ((G[j]['c'] - ent) if tr == 1 else (ent - G[j]['c'])) / risk
            busy = j + 1
            out.append((b['day'], res, risk / ent))
        return out
    for level in (20, 50):
        for tgt in (2, 3):
            r = pullback(tgt, level)
            for nm, sel in (('early', lambda d: d < SPLIT), ('late', lambda d: d >= SPLIT)):
                v = [x[1] for x in r if sel(x[0])]
                if v:
                    print(f"   EMA {level}, target {tgt}R, {nm}: n={len(v):4d} win {sum(x > 0 for x in v) / len(v) * 100:3.0f}% avg {st.mean(v):+.2f}R total {sum(v):+6.1f}R | median stop {st.median(x[2] for x in r) * 100:.2f}% of price")
            by = collections.defaultdict(float)
            for d, x, _ in r:
                by[d[:4]] += x
            print('      by year (R): ' + '  '.join(f'{y} {v:+.0f}' for y, v in sorted(by.items())))

    print('\nG. GOLD AGAINST THE DOLLAR AND THE NASDAQ (daily)')
    for sym, nm in (('EURUSD', 'euro (inverse of the dollar)'), ('USATECHIDXUSD', 'Nasdaq 100')):
        X = daily(load(folder, sym))
        xr = {X[i]['day']: X[i]['c'] / X[i - 1]['c'] - 1 for i in range(1, len(X))}
        gr = dict(rets)
        days = sorted(set(xr) & set(gr))
        def corr(ds, lag=0):
            a = [gr[d] for d in ds[lag:]]; b = [xr[d] for d in ds[:len(ds) - lag]] if lag else [xr[d] for d in ds]
            ma, mb = st.mean(a), st.mean(b)
            return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
        e = [d for d in days if d < SPLIT]; l = [d for d in days if d >= SPLIT]; r1 = [d for d in days if d >= '2026-01-01']
        print(f'  same-day correlation with the {nm}: early {corr(e):+.2f}, late {corr(l):+.2f}, 2026 {corr(r1):+.2f} | does yesterday\'s {nm.split()[0]} move lead gold today: early {corr(e, 1):+.2f}, late {corr(l, 1):+.2f}')

    print('\nH. WHERE GOLD IS NOW')
    i = len(D) - 1
    hi252 = max(d['h'] for d in D[-252:])
    print(f"  close {closes[i]:.1f} | 20d EMA {e20[i]:.1f} | 50d EMA {e50[i]:.1f} | 200d EMA {e200[i]:.1f} | 14-day ATR {A[i]:.1f} ({A[i] / closes[i] * 100:.2f}%) | {(closes[i] / hi252 - 1) * 100:+.1f}% from the 1-year high {hi252:.1f}")
    print(f"  20-day return {(closes[i] / closes[i - 20] - 1) * 100:+.1f}% | 60-day {(closes[i] / closes[i - 60] - 1) * 100:+.1f}% | 250-day {(closes[i] / closes[i - 250] - 1) * 100:+.1f}%")


if __name__ == '__main__':
    main()
