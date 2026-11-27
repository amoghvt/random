"""Every pattern tested so far on the Nasdaq, re-run on the seven major FX pairs.

Usage:
  python3 -I fx_patterns.py h <dir of SYM_YYYY-MM.bi5 hourly files>      timeframes 1h and 4h, resolved on hourly bars
  python3 -I fx_patterns.py m <dir of SYM/YYYY-MM-DD.bi5 1-minute files> timeframes 15m and 1h, resolved on 1-minute bars
  python3 -I fx_patterns.py y <dir of SYM.json Yahoo 1h chart files>     timeframes 1h and 4h, resolved on hourly bars
  python3 -I fx_patterns.py y5 <dir of SYM.json Yahoo 5m chart files>    timeframes 15m and 1h, resolved on 5-minute bars
Data: Dukascopy BID candles (records >IIIIIf = second offset, open, close, low, high, volume).

Every pattern becomes an order (market, limit or stop-entry) with a stop. All are scored the same way:
  targets at 1R, 2R and 3R, stop checked before target inside a bar, nothing good counted in the fill bar,
  held at most 60 bars of the pattern's timeframe, cost 1 pip per round trip plus 0.2 pip slippage on stops.
ATR = 14-bar average true range of the pattern's timeframe. Swing = highest/lowest of 3 bars each side.
"""
import collections
import datetime
import lzma
import os
import struct
import sys
import zoneinfo

PAIRS = ('EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD')
LONDON = zoneinfo.ZoneInfo('Europe/London')
UTC = datetime.timezone.utc
K = 3
HOLD = 60
TARGETS = (1, 2, 3)


def pip(sym):
    return 0.01 if 'JPY' in sym else 0.0001


def read(path, base_ts, scale):
    raw = open(path, 'rb').read()
    if not raw:
        return []
    try:
        data = lzma.decompress(raw)
    except lzma.LZMAError:
        return []
    out = []
    for k in range(len(data) // 24):
        s, o, c, lo, hi, v = struct.unpack('>IIIIIf', data[k * 24:k * 24 + 24])
        if v <= 0 and o == c == lo == hi:
            continue
        out.append((base_ts + s, o / scale, hi / scale, lo / scale, c / scale))
    return out


def load(mode, folder, sym):
    scale = 1000 if 'JPY' in sym else 100000
    bars = []
    if mode in ('y', 'y5'):  # Yahoo chart json, one file per pair
        import json
        d = json.load(open(os.path.join(folder, sym + '.json')))['chart']['result'][0]
        q = d['indicators']['quote'][0]
        step = 3600 if mode == 'y' else 300
        seen = set()
        for t, o, h, lo, c in zip(d['timestamp'], q['open'], q['high'], q['low'], q['close']):
            t -= t % step
            if None in (o, h, lo, c) or t in seen:
                continue
            seen.add(t)
            bars.append((t, o, h, lo, c))
        return bars
    if mode == 'h':
        for fn in sorted(f for f in os.listdir(folder) if f.startswith(sym + '_')):
            y, m = int(fn[len(sym) + 1:len(sym) + 5]), int(fn[len(sym) + 6:len(sym) + 8])
            bars += read(os.path.join(folder, fn), datetime.datetime(y, m, 1, tzinfo=UTC).timestamp(), scale)
    else:
        d = os.path.join(folder, sym)
        for fn in sorted(os.listdir(d)):
            bars += read(os.path.join(d, fn), datetime.datetime.fromisoformat(fn[:10]).replace(tzinfo=UTC).timestamp(), scale)
    return bars


def aggregate(bars, sec):
    out, cur = [], None
    for i, (t, o, h, lo, c) in enumerate(bars):
        k = int(t // sec)
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
    atr, e50, e200, trs = [], [], [], []
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


def pivots(tb, sign):
    v = [b[2] if sign == 1 else -b[3] for b in tb]
    out = []
    for i in range(K, len(v) - K):
        w = v[i - K:i + K + 1]
        if v[i] == max(w) and w.index(v[i]) == K:
            out.append(i)
    return out


def trend_of(tb, e50, e200, i):
    c = tb[i][4]
    return 1 if (c > e200[i] and e50[i] > e200[i]) else -1 if (c < e200[i] and e50[i] < e200[i]) else 0


# ───────── pattern generators: each yields (name, order) ─────────
# order: i = timeframe bar after whose close the order is live, s = side, kind = market | limit | stop,
#        level (for limit/stop), stop price, valid = bars the order stays live, cancel = price that voids it before a fill.

def gen_double(tb, atr, e50, e200):
    for sign in (1, -1):
        pv = pivots(tb, sign)
        for a, b2 in zip(pv, pv[1:]):
            if not 5 <= b2 - a <= 60 or b2 + K + 45 >= len(tb) or a < 250:
                continue
            A = atr[b2]
            x1, x2 = (tb[a][2], tb[b2][2]) if sign == 1 else (tb[a][3], tb[b2][3])
            if abs(x1 - x2) > 0.25 * A:
                continue
            seg = tb[a:b2 + 1]
            if sign == 1:
                top, neck = max(x1, x2), min(q[3] for q in seg)
                if max(q[2] for q in seg) > top or top - neck < 1.5 * A or min(q[3] for q in tb[b2:b2 + K + 1]) <= neck:
                    continue
            else:
                top, neck = min(x1, x2), max(q[2] for q in seg)
                if min(q[3] for q in seg) < top or neck - top < 1.5 * A or max(q[2] for q in tb[b2:b2 + K + 1]) >= neck:
                    continue
            conf = b2 + K
            s = -sign
            wt = 'with trend' if trend_of(tb, e50, e200, conf) == s else 'other'
            buf = 0.1 * A
            yield f'Double top/bottom: fade at the second touch | {wt}', dict(i=conf, s=s, kind='market', stop=top + sign * buf)
            yield f'Double top/bottom: neckline break | {wt}', dict(i=conf, s=s, kind='stop', level=neck, stop=top + sign * buf, valid=40, cancel=top)
            yield f'Equal highs/lows: trade the break through them | {"with trend" if trend_of(tb, e50, e200, conf) == sign else "other"}', \
                dict(i=conf, s=sign, kind='stop', level=top, stop=top - sign * A, valid=40, cancel=neck)
            # sweep of the equal level, then a close back inside within 3 bars
            for j in range(conf + 1, conf + 41):
                h, lo = tb[j][2], tb[j][3]
                if (lo < neck) if sign == 1 else (h > neck):
                    break
                if (h > top) if sign == 1 else (lo < top):
                    for q in range(j, j + 4):
                        if (tb[q][4] < top) if sign == 1 else (tb[q][4] > top):
                            ext = max(z[2] for z in tb[j:q + 1]) if sign == 1 else min(z[3] for z in tb[j:q + 1])
                            yield f'Equal highs/lows swept, close back inside: fade | {wt}', dict(i=q, s=s, kind='market', stop=ext + sign * buf)
                            break
                    break


def gen_fvg(tb, atr, e50, e200):
    for i in range(252, len(tb) - 2):
        A = atr[i - 1]
        for s in (1, -1):
            gap = (tb[i][3] - tb[i - 2][2]) if s == 1 else (tb[i - 2][3] - tb[i][2])
            if gap < 0.25 * A:
                continue
            near = tb[i][3] if s == 1 else tb[i][2]      # edge of the gap closest to price
            far = tb[i - 2][2] if s == 1 else tb[i - 2][3]  # far edge
            wt = 'with trend' if trend_of(tb, e50, e200, i) == s else 'other'
            yield f'FVG: enter at the near edge, stop beyond the gap | {wt}', dict(i=i, s=s, kind='limit', level=near, stop=far - s * 0.1 * A, valid=20)
            mid = (near + far) / 2
            origin = tb[i - 1][3] if s == 1 else tb[i - 1][2]
            origin = min(origin, far) if s == 1 else max(origin, far)
            yield f'FVG: enter at the midpoint, stop beyond the gap candle | {wt}', dict(i=i, s=s, kind='limit', level=mid, stop=origin - s * 0.1 * A, valid=20)


def gen_lrlr(tb, atr, e50, e200):
    for sign in (1, -1):
        pv = pivots(tb, sign)
        val = (lambda i: tb[i][2]) if sign == 1 else (lambda i: tb[i][3])
        for a, b, c in zip(pv, pv[1:], pv[2:]):
            if c < 252 or c + K >= len(tb) - 1 or c - a > 80:
                continue
            stair = (val(a) > val(b) > val(c)) if sign == 1 else (val(a) < val(b) < val(c))
            if not stair:
                continue
            conf = c + K
            A = atr[conf]
            wt = 'with trend' if trend_of(tb, e50, e200, conf) == sign else 'other'
            yield f'LRLR: three stepped highs/lows, trade the run through them | {wt}', \
                dict(i=conf, s=sign, kind='stop', level=val(c), stop=val(c) - sign * A, valid=30)


def gen_wickless(tb, atr, e50, e200):
    for i in range(252, len(tb) - 2):
        _t, o, h, lo, c, _j = tb[i]
        A = atr[i - 1]
        if c == o or A <= 0:
            continue
        s = 1 if c > o else -1
        if trend_of(tb, e50, e200, i) != s:
            continue
        if ((o - lo) if s == 1 else (h - o)) <= 0.03 * A:
            yield 'Wickless trend candle: limit at its open | with trend', dict(i=i, s=s, kind='limit', level=o, stop=o - s * A, valid=20)


def gen_ema_tap(tb, atr, e50, e200):
    side, armed, count = 0, False, 0
    for i in range(400, len(tb) - 1):
        last5 = [tb[k][4] - e200[k] for k in range(i - 5, i)]
        ns = 1 if all(d > 0 for d in last5) else -1 if all(d < 0 for d in last5) else 0
        if ns and ns != side:
            side, armed, count = ns, False, 0
        if not side:
            continue
        A, L = atr[i - 1], e200[i - 1]
        if (tb[i - 1][4] - L) * side >= 1.5 * A:
            if not armed:
                count += 1
                yield f'200 EMA tap | {"first tap" if count == 1 else "later tap"}', dict(i=i - 1, s=side, kind='limit', level=L, stop=L - side * A, valid=10)
            armed = True
        if armed and ((tb[i][3] <= L) if side == 1 else (tb[i][2] >= L)):
            armed = False


def gen_sweep(tb, atr, e50, e200):
    """A bar dips under the latest swing low by at most 0.5 ATR and closes back above it (mirrored for highs)."""
    for sign in (1, -1):  # sign=1: sweep of a low -> long
        pv = pivots(tb, -sign)
        lvl = (lambda i: tb[i][3]) if sign == 1 else (lambda i: tb[i][2])
        used = set()
        p = 0
        for i in range(252, len(tb) - 1):
            while p + 1 < len(pv) and pv[p + 1] + K < i:
                p += 1
            if p >= len(pv) or pv[p] + K >= i or pv[p] in used or i - pv[p] > 60:
                continue
            L = lvl(pv[p])
            A = atr[i - 1]
            _t, _o, h, lo, c, _j = tb[i]
            pierced = (L - lo) if sign == 1 else (h - L)
            if pierced <= 0:
                continue
            used.add(pv[p])
            if pierced <= 0.5 * A and ((c > L) if sign == 1 else (c < L)):
                wt = 'with trend' if trend_of(tb, e50, e200, i) == sign else 'other'
                ext = lo if sign == 1 else h
                yield f'Shallow sweep of a swing, close back through it | {wt}', dict(i=i, s=sign, kind='market', stop=ext - sign * 0.1 * A)


def gen_asian(tb, atr, e50, e200, sec):
    """Asian range = 23:00 to 07:00 London time. Breakout and false-break fade during 07:00 to 12:00 London."""
    days = collections.OrderedDict()
    for i, b in enumerate(tb):
        d = datetime.datetime.fromtimestamp(b[0], LONDON)
        key = (d + datetime.timedelta(hours=1)).date()
        hr = d.hour + d.minute / 60
        if d.weekday() > 4 and not (d.weekday() == 6 and hr >= 23):
            continue
        days.setdefault(key, {'range': [], 'trade': []})
        if hr >= 23 or hr < 7:
            days[key]['range'].append(i)
        elif hr < 12:
            days[key]['trade'].append(i)
    need = 8 * 3600 // sec
    for day in days.values():
        r, tr = day['range'], day['trade']
        if len(r) < 0.7 * need or len(tr) < 2 or r[0] < 252:
            continue
        hi, lo = max(tb[i][2] for i in r), min(tb[i][3] for i in r)
        A = atr[r[-1]]
        if hi - lo < 0.5 * A:
            continue
        mid = (hi + lo) / 2
        i0 = r[-1]
        t = trend_of(tb, e50, e200, i0)
        yield f'Asian range breakout: buy the high | {"with trend" if t == 1 else "other"}', dict(i=i0, s=1, kind='stop', level=hi, stop=mid, valid=len(tr), cancel=lo)
        yield f'Asian range breakout: sell the low | {"with trend" if t == -1 else "other"}', dict(i=i0, s=-1, kind='stop', level=lo, stop=mid, valid=len(tr), cancel=hi)
        for q, i in enumerate(tr):
            up, dn = tb[i][2] > hi, tb[i][3] < lo
            if not (up or dn):
                continue
            if up and dn:
                break
            for j in tr[q:q + 4]:
                if (tb[j][4] < hi) if up else (tb[j][4] > lo):
                    ext = max(tb[z][2] for z in tr[q:tr.index(j) + 1]) if up else min(tb[z][3] for z in tr[q:tr.index(j) + 1])
                    s = -1 if up else 1
                    yield f'Asian range false break: fade back into the range | {"with trend" if t == s else "other"}', \
                        dict(i=j, s=s, kind='market', stop=ext - s * 0.1 * A)
                    break
            break


# ───────── scoring ─────────
def resolve(bars, tb, od, per, cost, slip):
    s = od['s']
    j0 = tb[od['i']][5] + 1
    if j0 >= len(bars):
        return None
    kind = od['kind']
    fill = entry = None
    if kind == 'market':
        fill, entry = j0, bars[j0][1]
    else:
        L = od['level']
        cancel = od.get('cancel')
        for j in range(j0, min(j0 + od['valid'] * per, len(bars))):
            _t, o, h, lo, _c = bars[j]
            if cancel is not None and ((lo <= cancel) if (cancel < L) else (h >= cancel)):
                return None
            if kind == 'limit' and ((lo <= L) if s == 1 else (h >= L)):
                fill, entry = j, L
                break
            if kind == 'stop' and ((h >= L) if s == 1 else (lo <= L)):
                fill, entry = j, (max(L, o) if s == 1 else min(L, o))
                break
        if fill is None:
            return None
    stop = od['stop']
    risk = (entry - stop) * s
    if risk < 4 * cost:
        return None
    best, stopped, last = 0.0, False, entry
    for j in range(fill, min(fill + HOLD * per, len(bars))):
        _t, _o, h, lo, c = bars[j]
        last = c
        if j == fill and kind == 'stop':
            # a stop-entry fills on the way through the level: the bar's far extreme came before the fill,
            # so in the fill bar only a close beyond the stop counts as stopped
            if (c <= stop) if s == 1 else (c >= stop):
                stopped = True
                break
            continue
        if (lo <= stop) if s == 1 else (h >= stop):
            stopped = True
            break
        if j > fill:
            fav = (h - entry) if s == 1 else (entry - lo)
            if fav > best:
                best = fav
                if best >= TARGETS[-1] * risk:
                    break
    return tuple(((tm * risk - cost) if best >= tm * risk else (-risk - cost - slip) if stopped else ((last - entry) * s - cost)) / risk for tm in TARGETS), bars[fill][0]


def main():
    mode, folder = sys.argv[1], sys.argv[2]
    tfs = {'h': ((3600, '1h', 1), (14400, '4h', 4)), 'y': ((3600, '1h', 1), (14400, '4h', 4)),
           'y5': ((900, '15m', 3), (3600, '1h', 12)), 'm': ((900, '15m', 15), (3600, '1h', 60))}[mode]
    res = collections.defaultdict(list)  # (tf, name) -> [(pair, time, (r1, r2, r3))]
    span = {}
    for sym in PAIRS:
        bars = load(mode, folder, sym)
        if len(bars) < 2000:
            print(f'{sym}: not enough data ({len(bars)} bars)')
            continue
        span[sym] = (bars[0][0], bars[-1][0])
        cost, slip = 1.0 * pip(sym), 0.2 * pip(sym)
        for sec, label, per in tfs:
            tb = aggregate(bars, sec)
            atr, e50, e200 = indicators(tb)
            gens = [gen_double(tb, atr, e50, e200), gen_fvg(tb, atr, e50, e200), gen_lrlr(tb, atr, e50, e200), gen_wickless(tb, atr, e50, e200),
                    gen_ema_tap(tb, atr, e50, e200), gen_sweep(tb, atr, e50, e200)]
            if sec <= 3600:
                gens.append(gen_asian(tb, atr, e50, e200, sec))
            for g in gens:
                for name, od in g:
                    r = resolve(bars, tb, od, per, cost, slip)
                    if r:
                        res[(label, name)].append((sym, r[1], r[0]))
        print(f'{sym}: {len(bars):,} bars, {datetime.date.fromtimestamp(bars[0][0])} to {datetime.date.fromtimestamp(bars[-1][0])}', flush=True)
    t0 = min(v[0] for v in span.values())
    t1 = max(v[1] for v in span.values())
    midt = (t0 + t1) / 2
    print('\nPooled over the pairs. R after costs. "halves" = average R at the 2R target in the first and second half of the period.')
    print(f'{"tf":<4}{"pattern":<74}{"n":>6} | {"1R win":>6} {"avg":>6} | {"2R win":>6} {"avg":>6} | {"3R win":>6} {"avg":>6} | {"halves (2R)":>14} | pairs +')
    rows = []
    for (label, name), v in res.items():
        if len(v) < 40:
            continue
        cells = []
        for k in range(3):
            rs = [x[2][k] for x in v]
            cells.append((sum(r > 0 for r in rs) / len(rs) * 100, sum(rs) / len(rs)))
        a = [x[2][1] for x in v if x[1] < midt]
        b = [x[2][1] for x in v if x[1] >= midt]
        ha, hb = (sum(a) / len(a) if a else 0), (sum(b) / len(b) if b else 0)
        pos = sum(1 for p in PAIRS if (lambda q: q and sum(q) / len(q) > 0)([x[2][1] for x in v if x[0] == p]))
        rows.append((label, name, len(v), cells, ha, hb, pos))
    for label, name, n, cells, ha, hb, pos in sorted(rows, key=lambda r: (r[0], r[1])):
        print(f'{label:<4}{name:<74}{n:>6} | ' + ' | '.join(f'{w:5.0f}% {a:+.2f}R' for w, a in cells) + f' | {ha:+.2f} / {hb:+.2f} | {pos}/7')
    print('\nPer pair, average R at the 2R target, for every row positive in both halves:')
    for label, name, n, cells, ha, hb, pos in sorted(rows, key=lambda r: -min(r[4], r[5])):
        if ha > 0 and hb > 0:
            v = res[(label, name)]
            per_pair = []
            for p in PAIRS:
                q = [x[2][1] for x in v if x[0] == p]
                per_pair.append(f'{p} {sum(q) / len(q):+.2f} ({len(q)})' if q else f'{p} n/a')
            print(f'  {label} {name}: ' + ', '.join(per_pair))


if __name__ == '__main__':
    main()
