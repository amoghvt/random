"""EMA crossover test (fast above slow = long, below = short; position flips at the close of the crossing bar).

Usage: python3 -I ema_cross_test.py <hourly folder> <NQ 1-minute folder> <gold 1-minute folder>
Data: Dukascopy BID candles (hourly per month, 1-minute per day). Cost per flip side: 0.01% of price for NQ, 0.015% for gold.
Each result is shown next to nearby EMA pairs and to buy-and-hold, by year, so one lucky pair or one lucky year stands out.
"""
import collections, datetime, glob, lzma, math, os, statistics as st, struct, sys, zoneinfo

UTC = datetime.timezone.utc
SCALE = {'XAUUSD': 1000.0, 'USATECHIDXUSD': 1000.0}

def hourly(folder, sym):
    out = []
    for fn in sorted(glob.glob(os.path.join(folder, f'{sym}_*.bi5'))):
        raw = open(fn, 'rb').read()
        if not raw:
            continue
        data = lzma.decompress(raw); y, m = int(fn[-11:-7]), int(fn[-6:-4]); base = datetime.datetime(y, m, 1, tzinfo=UTC).timestamp()
        for i in range(len(data) // 24):
            s, o, c, lo, hi, v = struct.unpack('>IIIIIf', data[i * 24:i * 24 + 24])
            if v <= 0 and o == c == lo == hi:
                continue
            out.append((base + s, c / SCALE[sym]))
    return out

def minute(folder):
    out = []
    for fn in sorted(os.listdir(folder)):
        raw = open(os.path.join(folder, fn), 'rb').read()
        if not raw:
            continue
        try:
            data = lzma.decompress(raw)
        except lzma.LZMAError:
            continue
        base = datetime.datetime.fromisoformat(fn[:10]).replace(tzinfo=UTC).timestamp()
        for k in range(len(data) // 24):
            s, o, c, lo, hi, v = struct.unpack('>IIIIIf', data[k * 24:k * 24 + 24])
            if v <= 0 and o == c == lo == hi:
                continue
            out.append((base + s, c / 1000.0))
    return out

def resample(series, sec):
    out = []; cur = None
    for t, c in series:
        k = int(t // sec)
        if cur is not None and k != cur:
            out.append((cur * sec, last))
        cur, last = k, c
    if cur is not None:
        out.append((cur * sec, last))
    return out

def cross(series, fast, slow, cost, long_only=False):
    kf, ks = 2 / (fast + 1), 2 / (slow + 1); ef = es = None; pos = 0; prev = None
    trades = []; entry = None; eq = 0.0; peak = 0.0; dd = 0.0; by = collections.defaultdict(float); n = 0
    for t, c in series:
        ef = c if ef is None else c * kf + ef * (1 - kf); es = c if es is None else c * ks + es * (1 - ks); n += 1
        if prev is not None and pos != 0:
            r = pos * (c / prev - 1); eq += r; by[datetime.datetime.fromtimestamp(t, UTC).year] += r
        prev = c
        if n < slow * 2:
            continue
        want = 1 if ef > es else -1
        if long_only and want == -1:
            want = 0
        if want != pos:
            flips = abs(want - pos)
            eq -= cost * flips; by[datetime.datetime.fromtimestamp(t, UTC).year] -= cost * flips
            if entry is not None and pos != 0:
                trades.append(pos * (c / entry - 1) - 2 * cost)
            entry = c; pos = want
        peak = max(peak, eq); dd = max(dd, peak - eq)
    return dict(total=eq, dd=dd, trades=trades, by=dict(by))

def hold(series):
    by = collections.defaultdict(float); prev = None
    for t, c in series:
        if prev is not None:
            by[datetime.datetime.fromtimestamp(t, UTC).year] += c / prev - 1
        prev = c
    return by

def show(name, series, cost, pairs=((60, 260), (50, 200), (20, 100), (100, 300), (30, 130), (9, 21))):
    a = datetime.datetime.fromtimestamp(series[0][0], UTC).date(); b = datetime.datetime.fromtimestamp(series[-1][0], UTC).date()
    print(f'\n{name}: {len(series):,} bars, {a} to {b}')
    h = hold(series)
    for f, s in pairs:
        r = cross(series, f, s, cost); tr = r['trades']
        if len(tr) < 5:
            print(f'  EMA {f}/{s}: too few trades'); continue
        w = [x for x in tr if x > 0]; gl = -sum(x for x in tr if x <= 0)
        yrs = r['by']; green = sum(v > 0 for v in yrs.values())
        tag = '  <-- the pair you asked for' if (f, s) == (60, 260) else ''
        print(f"  EMA {f:3d}/{s:3d}: trades {len(tr):5d} win {len(w) / len(tr) * 100:3.0f}% avgWin {st.mean(w) * 100:5.2f}% avgLoss {-gl / max(1, len(tr) - len(w)) * 100:5.2f}% PF {(sum(w) / gl if gl else 9.99):4.2f} total {r['total'] * 100:+7.1f}% maxDD {r['dd'] * 100:5.1f}% green years {green}/{len(yrs)}{tag}")
    r = cross(series, 60, 260, cost); lo = cross(series, 60, 260, cost, long_only=True)
    print('    60/260 by year:   ' + '  '.join(f'{y} {v * 100:+.0f}%' for y, v in sorted(r['by'].items())))
    print('    buy and hold:     ' + '  '.join(f'{y} {v * 100:+.0f}%' for y, v in sorted(h.items())))
    print(f"    60/260 long-only (flat when below): total {lo['total'] * 100:+.1f}% maxDD {lo['dd'] * 100:.1f}% | buy and hold total {sum(h.values()) * 100:+.1f}%")

if __name__ == '__main__':
    hfolder, nq1, g1 = sys.argv[1:4]
    nqm = minute(nq1); gm = minute(g1); gh = hourly(hfolder, 'XAUUSD'); nh = hourly(hfolder, 'USATECHIDXUSD')
    print('NASDAQ 100 (index CFD)')
    for lbl, sec in (('1-minute', 60), ('5-minute', 300), ('15-minute', 900), ('1-hour', 3600), ('4-hour', 14400)):
        show(f'NQ {lbl}', resample(nqm, sec), 0.0001)
    if len(nh) > 2000:
        show('NQ 1-hour, long history', nh, 0.0001); show('NQ 4-hour, long history', resample(nh, 14400), 0.0001); show('NQ daily, long history', resample(nh, 86400), 0.0001)
    print('\n\nGOLD (XAUUSD)')
    for lbl, sec in (('5-minute', 300), ('15-minute', 900)):
        show(f'Gold {lbl}', resample(gm, sec), 0.00015)
    show('Gold 1-hour', gh, 0.00015); show('Gold 4-hour', resample(gh, 14400), 0.00015); show('Gold daily', resample(gh, 86400), 0.00015)
