"""Grid of EMA crossover pairs over the past year, with a walk-forward check (best pair of months 1-6 scored on months 7-12).
Usage: python3 -I ema_cross_grid.py <hourly folder> <NQ 1-minute folder> <gold 1-minute folder>"""
import datetime, os, statistics as st, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ema_cross_test as E
UTC = datetime.timezone.utc
FAST = (5, 9, 12, 20, 30, 50, 60, 100); SLOW = (21, 50, 100, 130, 200, 260, 300, 400)
PAIRS = [(f, s) for f in FAST for s in SLOW if s >= 2 * f]

def run(series, f, s, cost, t0, t1):
    kf, ks = 2 / (f + 1), 2 / (s + 1); ef = es = None; pos = 0; prev = None; eq = peak = dd = 0.0; n = 0; flips = 0; wins = trades = 0; entry = None
    for t, c in series:
        ef = c if ef is None else c * kf + ef * (1 - kf); es = c if es is None else c * ks + es * (1 - ks); n += 1
        live = t0 <= t < t1
        if live and prev is not None and pos != 0:
            eq += pos * (c / prev - 1)
        prev = c
        if n < s * 2:
            continue
        want = 1 if ef > es else -1
        if want != pos:
            if live:
                eq -= cost * abs(want - pos); flips += 1
                if entry is not None:
                    trades += 1; wins += (pos * (c / entry - 1) - 2 * cost) > 0
            entry = c; pos = want
        if live:
            peak = max(peak, eq); dd = max(dd, peak - eq)
    return eq, dd, trades, wins

def ts(y, m, d): return datetime.datetime(y, m, d, tzinfo=UTC).timestamp()

def study(name, series, cost):
    end = series[-1][0]; y1 = end - 365 * 86400; mid = end - 182 * 86400; q = end - 91 * 86400
    hold = lambda a, b: [c for t, c in series if a <= t < b]
    h = hold(y1, end)
    print(f"\n{name}: past year to {datetime.datetime.fromtimestamp(end, UTC).date()} | buy and hold {(h[-1] / h[0] - 1) * 100:+.1f}%")
    full = {p: run(series, *p, cost, y1, end) for p in PAIRS}
    rank = sorted(full.items(), key=lambda kv: -kv[1][0])
    pos = sum(v[0] > 0 for v in full.values())
    print(f"  {len(PAIRS)} pairs tested: {pos} profitable, median {st.median(v[0] for v in full.values()) * 100:+.1f}%")
    for p, (eq, dd, n, w) in rank[:5]:
        print(f"   best: EMA {p[0]:3d}/{p[1]:3d} {eq * 100:+7.1f}%  maxDD {dd * 100:5.1f}%  trades {n:4d}  win {w / max(1, n) * 100:3.0f}%")
    p, (eq, dd, n, w) = rank[-1]; print(f"   worst: EMA {p[0]}/{p[1]} {eq * 100:+.1f}%")
    e = full[(60, 260)]; print(f"   60/260: {e[0] * 100:+.1f}% (rank {[k for k, _ in rank].index((60, 260)) + 1} of {len(PAIRS)})")
    a = {p: run(series, *p, cost, y1, mid)[0] for p in PAIRS}; b = {p: run(series, *p, cost, mid, end)[0] for p in PAIRS}
    top = sorted(a, key=lambda p: -a[p])[:5]
    print('  walk-forward: the 5 best pairs of months 1-6, and what each did in months 7-12:')
    print('   ' + '  '.join(f"{p[0]}/{p[1]}: {a[p] * 100:+.0f}% then {b[p] * 100:+.0f}%" for p in top))
    xs = [a[p] for p in PAIRS]; ys = [b[p] for p in PAIRS]; mx, my = st.mean(xs), st.mean(ys)
    corr = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)) ** 0.5
    print(f"   correlation between a pair's first-half and second-half result: {corr:+.2f} | second-half average of all pairs {my * 100:+.1f}%, of the top 5 {st.mean(b[p] for p in top) * 100:+.1f}%")
    r3 = {p: run(series, *p, cost, q, end)[0] for p in PAIRS}; best3 = sorted(r3, key=lambda p: -r3[p])[:3]
    h3 = hold(q, end)
    print(f"  last 3 months (hold {(h3[-1] / h3[0] - 1) * 100:+.1f}%): best " + ', '.join(f"{p[0]}/{p[1]} {r3[p] * 100:+.0f}%" for p in best3) + f" | profitable pairs {sum(v > 0 for v in r3.values())}/{len(PAIRS)}")

if __name__ == '__main__':
    hf, nq1, g1 = sys.argv[1:4]
    nq = E.minute(nq1); gm = E.minute(g1)
    for lbl, sec in (('5-minute', 300), ('15-minute', 900), ('1-hour', 3600), ('4-hour', 14400)):
        study(f'NASDAQ {lbl}', E.resample(nq, sec), 0.0001)
    for lbl, sec in (('5-minute', 300), ('15-minute', 900), ('1-hour', 3600), ('4-hour', 14400)):
        study(f'GOLD {lbl}', E.resample(gm, sec), 0.00015)
