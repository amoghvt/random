"""Turn raw bars into the picture a discretionary trader actually looks at.

Everything is computed in the session time zone (default America/New_York).
RTH = 09:30-16:00 ET. Globex session for "today" starts 18:00 ET the prior evening.
"""

from datetime import datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo

RTH_OPEN = dtime(9, 30)
RTH_CLOSE = dtime(16, 0)
GLOBEX_OPEN = dtime(18, 0)


def _dt(epoch, tz):
    return datetime.fromtimestamp(epoch, tz)


def ema(values, n):
    if not values:
        return []
    k = 2.0 / (n + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def atr(bars, n=14):
    if len(bars) < 2:
        return 0.0
    trs = []
    for prev, cur in zip(bars[:-1], bars[1:]):
        trs.append(max(cur["h"] - cur["l"], abs(cur["h"] - prev["c"]), abs(cur["l"] - prev["c"])))
    window = trs[-n:]
    return sum(window) / len(window) if window else 0.0


def vwap(bars):
    pv = vol = 0.0
    for b in bars:
        tp = (b["h"] + b["l"] + b["c"]) / 3.0
        v = b["v"] or 1
        pv += tp * v
        vol += v
    return pv / vol if vol else (bars[-1]["c"] if bars else 0.0)


def session_date(ts, tz):
    """The RTH trading date a timestamp belongs to. Bars at/after 18:00 ET roll to the next day."""
    d = _dt(ts, tz)
    if d.time() >= GLOBEX_OPEN:
        return (d + timedelta(days=1)).date()
    return d.date()


def phase(now_et):
    t = now_et.time()
    if now_et.weekday() >= 5:
        return "weekend"
    if dtime(4, 0) <= t < RTH_OPEN:
        return "pre-market"
    if RTH_OPEN <= t < dtime(10, 0):
        return "open-drive"
    if dtime(10, 0) <= t < dtime(11, 30):
        return "morning"
    if dtime(11, 30) <= t < dtime(13, 30):
        return "midday-chop"
    if dtime(13, 30) <= t < dtime(15, 0):
        return "afternoon"
    if dtime(15, 0) <= t < RTH_CLOSE:
        return "power-hour"
    if RTH_CLOSE <= t < dtime(17, 0):
        return "post-close"
    return "globex"


def compute(bars, now=None, tz_name="America/New_York", tick=0.25):
    """Return a dict of levels and state. `bars` must be ascending; `now` epoch seconds."""
    tz = ZoneInfo(tz_name)
    if not bars:
        return {"error": "no bars"}
    now = now or bars[-1]["t"]
    now_et = _dt(now, tz)
    last = bars[-1]
    today = session_date(last["t"], tz)

    by_day = {}
    for b in bars:
        by_day.setdefault(session_date(b["t"], tz), []).append(b)
    days = sorted(by_day)
    today_bars = by_day.get(today, [])
    prior_days = [d for d in days if d < today]
    prior = by_day[prior_days[-1]] if prior_days else []

    def rth(bs):
        return [b for b in bs if RTH_OPEN <= _dt(b["t"], tz).time() < RTH_CLOSE]

    def overnight(bs):
        return [b for b in bs if not (RTH_OPEN <= _dt(b["t"], tz).time() < RTH_CLOSE)]

    today_rth = rth(today_bars)
    today_on = overnight(today_bars)
    prior_rth = rth(prior)

    def hl(bs):
        if not bs:
            return None, None
        return max(b["h"] for b in bs), min(b["l"] for b in bs)

    pd_h, pd_l = hl(prior_rth)
    pd_c = prior_rth[-1]["c"] if prior_rth else (prior[-1]["c"] if prior else None)
    on_h, on_l = hl(today_on)
    rth_h, rth_l = hl(today_rth)
    rth_open = today_rth[0]["o"] if today_rth else None

    # opening range: first 15 minutes of RTH
    orb = [b for b in today_rth if _dt(b["t"], tz).time() < dtime(9, 45)]
    orb_h, orb_l = hl(orb)

    closes = [b["c"] for b in bars]
    e9, e21 = ema(closes, 9), ema(closes, 21)
    e50 = ema(closes, 50)
    trend = "up" if e9[-1] > e21[-1] > e50[-1] else "down" if e9[-1] < e21[-1] < e50[-1] else "mixed"

    a = atr(bars, 14)
    vw_rth = vwap(today_rth) if today_rth else None
    vw_sess = vwap(today_bars) if today_bars else None

    recent = bars[-20:]
    sw_h, sw_l = hl(recent)
    vols = [b["v"] for b in bars[-60:] if b["v"]]
    avg_vol = sum(vols) / len(vols) if vols else 0
    last5 = [b["v"] for b in bars[-5:] if b["v"]]
    rel_vol = (sum(last5) / len(last5) / avg_vol) if (last5 and avg_vol) else None

    price = last["c"]
    def dist(level):
        return round(price - level, 2) if level is not None else None

    bars_since_open = len(today_rth)
    return {
        "as_of_et": now_et.strftime("%Y-%m-%d %H:%M %Z"),
        "last_bar_et": _dt(last["t"], tz).strftime("%H:%M"),
        "stale_minutes": round((now - last["t"]) / 60.0, 1),
        "phase": phase(now_et),
        "price": price,
        "trend_ema": trend,
        "ema9": round(e9[-1], 2), "ema21": round(e21[-1], 2), "ema50": round(e50[-1], 2),
        "atr14": round(a, 2),
        "levels": {
            "prior_day_high": pd_h, "prior_day_low": pd_l, "prior_day_close": pd_c,
            "overnight_high": on_h, "overnight_low": on_l,
            "rth_open": rth_open, "rth_high": rth_h, "rth_low": rth_l,
            "orb_high": orb_h, "orb_low": orb_l,
            "vwap_rth": round(vw_rth, 2) if vw_rth else None,
            "vwap_session": round(vw_sess, 2) if vw_sess else None,
            "swing_high_20": sw_h, "swing_low_20": sw_l,
        },
        "distance_pts": {
            "to_vwap_rth": dist(vw_rth),
            "to_prior_day_high": dist(pd_h), "to_prior_day_low": dist(pd_l),
            "to_overnight_high": dist(on_h), "to_overnight_low": dist(on_l),
            "to_orb_high": dist(orb_h), "to_orb_low": dist(orb_l),
        },
        "day": {
            "bars_since_rth_open": bars_since_open,
            "rth_range_pts": round(rth_h - rth_l, 2) if rth_h is not None else None,
            "change_from_prior_close_pts": dist(pd_c),
            "gap_pts": round(rth_open - pd_c, 2) if (rth_open is not None and pd_c is not None) else None,
            "relative_volume": round(rel_vol, 2) if rel_vol else None,
        },
        "recent_bars": [
            {"t": _dt(b["t"], tz).strftime("%H:%M"), "o": b["o"], "h": b["h"], "l": b["l"],
             "c": b["c"], "v": b["v"]} for b in bars[-12:]
        ],
    }


def in_window(now_et, windows):
    t = now_et.time()
    for start, end in windows:
        s = dtime(*map(int, start.split(":")))
        e = dtime(*map(int, end.split(":")))
        if s <= t < e:
            return True
    return False


def in_blackout(now_et, blackouts):
    """Return the label of an event blackout covering now_et, else None."""
    for ev in blackouts or []:
        try:
            d = datetime.strptime(ev["date"], "%Y-%m-%d").date()
            hh, mm = map(int, ev["time"].split(":"))
        except (KeyError, ValueError):
            continue
        if d != now_et.date():
            continue
        center = now_et.replace(hour=hh, minute=mm, second=0, microsecond=0)
        start = center - timedelta(minutes=int(ev.get("minutes_before", 5)))
        end = center + timedelta(minutes=int(ev.get("minutes_after", 10)))
        if start <= now_et < end:
            return ev.get("label", "event")
    return None
