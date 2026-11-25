"""Mechanical backtest of the 10:00 ET with-trend fade on 1-minute Nasdaq-100 index candles.

Data: Dukascopy USATECHIDXUSD BID 1-minute candles, one .bi5 per UTC day (LZMA; records >IIIIIf = second offset, open,
close, low, high, volume; prices x1000). Usage: python3 -I ten_am_fade_backtest.py <dir of YYYY-MM-DD.bi5>

The rule, for a decision candle starting at X (10:00 by default), short side (longs mirrored):
  1. Trend: at 09:30 the last 5-minute close is below the 5m EMA 200 and the EMA 50 is below the EMA 200.
  2. Bounce into X: the 5-minute candle [X, X+5) makes a high at or above every high of the previous 15 minutes.
  3. Trigger: after that candle closes, price trades below its low within the next `window` minutes.
     If price trades above its high first, the setup is cancelled.
  4. Stop: 2 points above that candle's high.
  5. One attempt per day. Exit at the target or at 12:00 ET.
Fills: at the trigger (or the bar's open if it gaps through), 1 point of slippage each side. Inside a 1-minute bar the stop
is assumed to be hit before the target.
"""
import bisect
import collections
import datetime
import lzma
import os
import statistics as st
import struct
import sys
import zoneinfo

ET = zoneinfo.ZoneInfo('America/New_York')
UTC = datetime.timezone.utc
SLIP = 1.0


def load(folder):
    bars = []
    for fn in sorted(os.listdir(folder)):
        raw = open(os.path.join(folder, fn), 'rb').read()
        if not raw:
            continue
        try:
            data = lzma.decompress(raw)
        except lzma.LZMAError:
            continue
        day = datetime.datetime.fromisoformat(fn[:10]).replace(tzinfo=UTC).timestamp()
        for k in range(len(data) // 24):
            s, o, c, lo, hi, v = struct.unpack('>IIIIIf', data[k * 24:k * 24 + 24])
            if v <= 0 and o == c == lo == hi:
                continue
            bars.append((day + s, o / 1000, hi / 1000, lo / 1000, c / 1000))
    return bars


def five_minute_emas(bars):
    """5-minute closes with EMA 50 and EMA 200, as parallel lists keyed by the 5m bar's end time."""
    ends, closes = [], []
    cur = None
    for t, _o, _h, _l, c in bars:
        k = int(t // 300)
        if cur is not None and k != cur:
            ends.append((cur + 1) * 300)
            closes.append(last)
        cur, last = k, c
    e50 = e200 = None
    out50, out200 = [], []
    for c in closes:
        e50 = c if e50 is None else c * 2 / 51 + e50 * 49 / 51
        e200 = c if e200 is None else c * 2 / 201 + e200 * 199 / 201
        out50.append(e50)
        out200.append(e200)
    return ends, closes, out50, out200


def sessions(bars):
    """Per ET weekday: {minute of day: (index into bars)} for 09:00-12:05."""
    out = collections.OrderedDict()
    for i, b in enumerate(bars):
        d = datetime.datetime.fromtimestamp(b[0], ET)
        if d.weekday() > 4:
            continue
        m = d.hour * 60 + d.minute
        if 540 <= m < 725:
            out.setdefault(d.date().isoformat(), {})[m] = i
    return {k: v for k, v in out.items() if len(v) >= 150}


def run(bars, sess, emas, at=600, window=5, trend='with', exit_m=720):
    ends, closes, e50, e200 = emas
    trades = []
    for day, idx in sess.items():
        cand = [idx.get(m) for m in range(at, at + 5)]
        prior = [idx.get(m) for m in range(at - 15, at)]
        if None in cand or sum(p is not None for p in prior) < 12:
            continue
        ch = max(bars[i][2] for i in cand)
        cl = min(bars[i][3] for i in cand)
        ph = max(bars[i][2] for i in prior if i is not None)
        pl = min(bars[i][3] for i in prior if i is not None)
        up_into, down_into = ch >= ph, cl <= pl
        if up_into == down_into:
            continue
        s = -1 if up_into else 1  # fade: short a high, buy a low
        open_i = idx.get(570)
        if open_i is None:
            continue
        k = bisect.bisect_right(ends, bars[open_i][0]) - 1
        if k < 250:
            continue
        tr = -1 if (closes[k] < e200[k] and e50[k] < e200[k]) else 1 if (closes[k] > e200[k] and e50[k] > e200[k]) else 0
        if trend == 'with' and tr != s:
            continue
        if trend == 'counter' and tr != -s:
            continue
        trigger = cl if s == -1 else ch
        stop = ch + 2 if s == -1 else cl - 2
        entry = None
        for m in range(at + 5, at + 5 + window):
            i = idx.get(m)
            if i is None:
                continue
            _t, o, h, lo, _c = bars[i]
            beyond = (h > ch) if s == -1 else (lo < cl)
            broke = (lo < trigger) if s == -1 else (h > trigger)
            if beyond:
                break  # the candle's extreme was taken out first (or in the same minute): no trade
            if broke:
                fill = (min(trigger, o) - SLIP) if s == -1 else (max(trigger, o) + SLIP)
                entry = (m, i, fill)
                break
        if entry is None:
            continue
        m0, i0, px = entry
        risk = (stop - px) if s == -1 else (px - stop)
        if risk < 3:
            continue
        # path after entry: (minute, adverse excursion, favourable excursion, close) per 1-minute bar
        path = []
        for m in range(m0, exit_m):
            i = idx.get(m)
            if i is None:
                continue
            _t, o, h, lo, c = bars[i]
            adv = (h - px) if s == -1 else (px - lo)
            fav = (px - lo) if s == -1 else (h - px)
            if m == m0:
                fav = 0.0  # nothing is assumed to go right inside the entry minute
            path.append((m, adv, fav, (px - c) if s == -1 else (c - px)))
        if not path:
            continue
        trades.append(dict(day=day, s=s, px=px, risk=risk, path=path, entry_m=m0))
    return trades


def outcome(t, stop_pts, target_pts):
    """Points made: -stop if the stop distance is touched first, +target if reached, else the 12:00 mark, less exit slippage."""
    for _m, adv, fav, _c in t['path']:
        if adv >= stop_pts:
            return -stop_pts - SLIP, 'stop'
        if fav >= target_pts:
            return target_pts - SLIP, 'target'
    return t['path'][-1][3] - SLIP, 'time'


def full_port(trades, target_pts, balance=10_000, lev=50, room=400, fee=400):
    """50x on the account: the floor is `room` dollars away; a structural stop inside the floor is honoured."""
    claimed = lost = 0
    kept_loss = 0.0
    wins = 0
    for t in trades:
        ct = balance * lev / t['px']
        floor_pts = room / ct
        stop_pts = min(t['risk'], floor_pts)
        pts, why = outcome(t, stop_pts, target_pts if target_pts > 0 else -target_pts * t['risk'])
        usd = pts * ct
        if why == 'stop' and stop_pts >= floor_pts - 1e-9:
            lost += 1
        elif usd > 0:
            claimed += usd
            wins += 1
        else:
            kept_loss += usd
    n = len(trades)
    return dict(n=n, wins=wins, lost=lost, claimed=claimed, net=claimed - lost * fee + kept_loss)


def sized(trades, r_mult, risk_usd=320, balance=10_000, lev=50):
    """Contracts sized so the structural stop costs `risk_usd`, capped at full port."""
    tot = 0.0
    wins = 0
    rs = []
    for t in trades:
        ct = min(balance * lev / t['px'], risk_usd / t['risk'])
        pts, _why = outcome(t, t['risk'], r_mult * t['risk'])
        tot += pts * ct
        wins += pts > 0
        rs.append(pts / t['risk'])
    return dict(n=len(trades), wins=wins, net=tot, avg_r=st.mean(rs) if rs else 0.0, total_r=sum(rs))


def line(label, trades):
    if len(trades) < 5:
        return f'{label:>34} n={len(trades):3d}'
    a, b, c = full_port(trades, 100), full_port(trades, 200), full_port(trades, -3)
    z = sized(trades, 3)
    med = st.median(t['risk'] for t in trades)
    return (f"{label:>34} n={len(trades):3d} stop {med:3.0f} | FULL PORT +100: win {a['wins'] / a['n'] * 100:3.0f}% lost {a['lost']:3d} net ${a['net']:9,.0f}"
            f" | +200: win {b['wins'] / b['n'] * 100:3.0f}% net ${b['net']:9,.0f} | 3R: net ${c['net']:9,.0f}"
            f" || SIZED $320 risk, 3R: win {z['wins'] / z['n'] * 100:3.0f}% {z['avg_r']:+.2f}R net ${z['net']:8,.0f}")


def main():
    bars = load(sys.argv[1])
    emas = five_minute_emas(bars)
    sess = sessions(bars)
    days = list(sess)
    print(f'1-minute bars {len(bars):,} | sessions {len(days)} | {days[0]} to {days[-1]}')
    base = run(bars, sess, emas)
    print('\nTHE RULE: with trend, 10:00 candle, trigger within the next 5 minutes')
    print(line('all', base))
    print(line('shorts (10:00 high in a downtrend)', [t for t in base if t['s'] == -1]))
    print(line('longs (10:00 low in an uptrend)', [t for t in base if t['s'] == 1]))
    for y in sorted({t['day'][:4] for t in base}):
        for h, lab in (('H1', lambda d: d[5:7] <= '06'), ('H2', lambda d: d[5:7] > '06')):
            v = [t for t in base if t['day'][:4] == y and lab(t['day'])]
            if v:
                print(line(f'{y} {h}', v))
    print('\nVARIANTS')
    print(line('trigger window 15 minutes', run(bars, sess, emas, window=15)))
    print(line('no trend filter', run(bars, sess, emas, trend='any')))
    print(line('counter-trend only', run(bars, sess, emas, trend='counter')))
    print('\nSAME RULE AT OTHER TIMES (is 10:00 special?)')
    for at in (585, 590, 595, 600, 605, 610, 615, 630, 645, 660):
        print(line(f'candle starting {at // 60:02d}:{at % 60:02d}', run(bars, sess, emas, at=at)))
    recent = [t for t in base if t['day'] >= '2026-11-16']
    print('\nrecent signals:', [(t['day'], 'short' if t['s'] == -1 else 'long', round(t['px']), f"stop {t['risk']:.0f}", outcome(t, t['risk'], 3 * t['risk'])[1]) for t in recent])


if __name__ == '__main__':
    main()
