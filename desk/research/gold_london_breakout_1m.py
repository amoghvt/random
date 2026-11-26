"""1-minute check of the gold "New York breaks the London range" rule (see gold_study.py section F).

Data: Dukascopy XAUUSD BID 1-minute candles, one .bi5 per UTC day. Usage: python3 -I gold_london_breakout_1m.py <dir>
Rule: range = high/low of 03:00-08:00 New York time. From 08:00, the first trade beyond the range enters in that direction
at the range edge (or the bar's open if it gaps), stop at the middle of the range, exit at 16:00. One trade a day.
`cost` is the round trip in dollars per ounce (spread plus slippage); the stop is checked before anything else in each minute.
"""
import collections, datetime, lzma, os, statistics as st, struct, sys, zoneinfo

ET = zoneinfo.ZoneInfo('America/New_York'); UTC = datetime.timezone.utc

def load(folder):
    days = collections.defaultdict(list)
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
            d = datetime.datetime.fromtimestamp(base + s, ET)
            if d.weekday() < 5:
                days[d.date().isoformat()].append((d.hour * 60 + d.minute, o / 1000, hi / 1000, lo / 1000, c / 1000))
    return days

def run(days, cost=1.0, exit_m=960, max_range_pct=None, stop='mid'):
    out = []
    for day, bs in sorted(days.items()):
        rng = [b for b in bs if 180 <= b[0] < 480]; win = [b for b in bs if 480 <= b[0] < exit_m]
        if len(rng) < 200 or len(win) < 200:
            continue
        hi = max(b[2] for b in rng); lo = min(b[3] for b in rng); mid = (hi + lo) / 2
        if max_range_pct is not None and (hi - lo) / lo * 100 >= max_range_pct:
            continue
        pos = 0; res = None
        for m, o, h, l, c in win:
            if pos == 0:
                if h > hi and l < lo:
                    break
                if h > hi or l < lo:
                    pos = 1 if h > hi else -1
                    ent = max(hi, o) if pos == 1 else min(lo, o)
                    stp = mid if stop == 'mid' else (lo if pos == 1 else hi)
                    if (l <= stp) if pos == 1 else (h >= stp):
                        res = pos * (stp - ent); break
                    em = m
            elif (l <= stp) if pos == 1 else (h >= stp):
                res = pos * (stp - ent); break
        if pos != 0:
            if res is None:
                res = pos * (win[-1][4] - ent)
            out.append((day, (res - cost) / ent, (hi - lo) / lo * 100, pos))
    return out

def line(r):
    if len(r) < 10:
        return f'n={len(r)}'
    v = [x[1] for x in r]; w = [x for x in v if x > 0]; gl = -sum(x for x in v if x <= 0)
    cum = peak = dd = 0.0
    for x in v:
        cum += x; peak = max(peak, cum); dd = max(dd, peak - cum)
    return f"n={len(v):4d} win {len(w) / len(v) * 100:3.0f}% avg {st.mean(v) * 100:+.3f}% avgWin {st.mean(w) * 100:.2f}% avgLoss {-gl / max(1, len(v) - len(w)) * 100:.2f}% total {sum(v) * 100:+6.1f}% PF {sum(w) / gl:4.2f} maxDD {dd * 100:4.1f}%"

if __name__ == '__main__':
    D = load(sys.argv[1]); ks = sorted(D)
    print('sessions', len(ks), ks[0], 'to', ks[-1])
    for c in (0.5, 1.0, 1.5, 2.5):
        print(f' cost ${c:.2f}/oz round trip:', line(run(D, c)))
    base = run(D, 1.0)
    for y in sorted({d[:4] for d, *_ in base}):
        print(f'  {y}:', line([x for x in base if x[0][:4] == y]))
    print(' longs: ', line([x for x in base if x[3] == 1])); print(' shorts:', line([x for x in base if x[3] == -1]))
    print(' London range under 0.3%:', line(run(D, 1.0, max_range_pct=0.3)))
    print(' range under 0.45%:      ', line(run(D, 1.0, max_range_pct=0.45)))
    print(' out at 12:00:           ', line(run(D, 1.0, exit_m=720)))
    print(' stop at far side:       ', line(run(D, 1.0, stop='far')))
    med = st.median(x[2] for x in base)
    print(f' median London range {med:.2f}% of price')
