"""Intel for the brain: macro snapshot, today's economic calendar, a news wire, and the session direction call.

Everything here is free public data and can be missing or late. Each piece degrades to "unavailable" on its own;
nothing here places or blocks a trade except through risk.py reading what this module wrote into the day state.

The session direction call is the one item with a measured record (desk/research/session_direction_signal.py,
731 Nasdaq cash sessions, 2023-01 to 2026-10): the first half-hour check from 10:00 to 15:30 New York time where price
is outside its normal range from the open for that time of day. 57% of calls closed further in the called direction;
63% when the call agreed with the 50-day trend, 49% when it did not. Price typically moved 65 to 77 points against the
call first. Entering on it with a 20 to 40 point stop was about break-even in the same data: it tells direction, it
is not an entry.
"""
import hashlib
import json
import re
import time
from email.utils import parsedate_to_datetime
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import data as data_mod

MACRO = [("VIX", "^VIX"), ("US 10Y yield", "^TNX"), ("Dollar index", "DX-Y.NYB"), ("S&P 500 futures", "ES=F"),
         ("Semiconductors (SMH)", "SMH"), ("Crude oil", "CL=F"), ("Gold", "GC=F"), ("Bitcoin", "BTC-USD")]
CALENDAR_URL = "https://economic-calendar.tradingview.com/events?from=%s&to=%s&countries=US"
WIRE_RSS = "https://www.financialjuice.com/feed.ashx?xy=rss"
TRUMP_RSS = "https://www.trumpstruth.org/feed"  # public archive of Truth Social posts
CHECKS = list(range(600, 931, 30))  # 10:00 .. 15:30 as minutes of the day
OPEN_MIN, CLOSE_MIN, LOOKBACK, MIN_SESSIONS, TREND_DAYS = 570, 960, 14, 10, 50
RECORD = {"all_right_pct": 57, "with_trend_right_pct": 63, "against_trend_right_pct": 49, "typical_heat_points": 65,
          "sample": "731 sessions, 2023-01 to 2026-10", "note": "direction filter, not an entry; with a 20-40 point stop it was about break-even"}


def _yahoo(symbol, rng, interval):
    return data_mod.parse_yahoo_chart(data_mod._get(data_mod.YAHOO_CHART % (urllib.parse.quote(symbol), rng, interval)))


def macro_snapshot(fetch=_yahoo):
    out = []
    for label, sym in MACRO:
        try:
            bars, meta = fetch(sym, "5d", "1d")
            last = meta.get("regularMarketPrice") or bars[-1]["c"]
            prev = meta.get("chartPreviousClose") if len(bars) < 2 else bars[-2]["c"]
            row = {"name": label, "last": round(float(last), 3)}
            if prev:
                row["change_pct_vs_prior_close"] = round((float(last) / float(prev) - 1) * 100, 2)
            out.append(row)
        except Exception:  # one missing quote must not take the rest down
            out.append({"name": label, "unavailable": True})
    return out


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": data_mod.UA, "Origin": "https://www.tradingview.com", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def parse_calendar(payload, tz_name="America/New_York", min_importance=1):
    """TradingView calendar rows -> events with local time. importance: -1 low, 0 medium, 1 high."""
    tz = ZoneInfo(tz_name)
    out = []
    for e in (payload or {}).get("result", []):
        if e.get("importance", -1) < min_importance:
            continue
        try:
            t = datetime.fromisoformat(e["date"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        lt = t.astimezone(tz)
        out.append({"title": e.get("title"), "date": lt.strftime("%Y-%m-%d"), "time": lt.strftime("%H:%M"), "ts": t.timestamp(),
                    "actual": e.get("actual"), "forecast": e.get("forecast"), "previous": e.get("previous"), "unit": e.get("unit")})
    return sorted(out, key=lambda x: x["ts"])


def calendar(now, tz_name="America/New_York", fetch=_get_json):
    a = datetime.fromtimestamp(now, timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    b = a + timedelta(days=2)
    url = CALENDAR_URL % (urllib.parse.quote(a.strftime("%Y-%m-%dT%H:%M:%S.000Z")), urllib.parse.quote(b.strftime("%Y-%m-%dT%H:%M:%S.000Z")))
    return parse_calendar(fetch(url), tz_name)


def blackouts(events, before_min=10, after_min=15):
    """[start_ts, end_ts, label] around every high-importance release."""
    return [[e["ts"] - before_min * 60, e["ts"] + after_min * 60, e["title"], e["ts"]] for e in events]


def _stamp(items, prefix=""):
    out = []
    for it in items:
        try:
            ts = parsedate_to_datetime(it.get("published", "")).timestamp()
        except (TypeError, ValueError):
            ts = None
        title = re.sub(r"^FinancialJuice:\s*", "", it["title"])
        out.append({"title": prefix + title, "published": it.get("published", ""), "ts": ts})
    return out


def wire(limit=40):
    try:
        return _stamp(data_mod.parse_rss(data_mod._get(WIRE_RSS), limit=limit))
    except data_mod.DataError:
        return []


def trump_posts(limit=15):
    try:
        items = data_mod.parse_rss(data_mod._get(TRUMP_RSS), limit=limit)
    except data_mod.DataError:
        return []
    return _stamp([i for i in items if not re.match(r"(Image|Video) post from", i["title"])], prefix="Trump (Truth Social): ")


# ---- which headlines can move the index on their own ----------------------------------------------------------------
_DATA = r"\b(core cpi|cpi|core pce|pce|non-?farm payrolls|nfp|unemployment rate|gdp|ism (manufacturing|services)|retail sales|initial jobless claims|jobless claims|ppi|jolts)\b"
_POLICY = (r"tariffs?|\bfed\b|federal reserve|powell|interest rates?|rate cuts?|trade deal|trade war|executive order|nvidia|\bchips?\b|semiconductors?|"
           r"export controls?|sanctions?|government shutdown|debt ceiling|stock market|stocks are|nasdaq|china (trade|deal|tariff)|tax cuts?")
IMPACT_3 = [
    ("trump policy", r"\btrump\b.*(%s)|(%s).*\btrump\b" % (_POLICY, _POLICY)),
    ("fed decision", r"\b(fed|fomc|powell)\b.*\b(cuts? rates|hikes? rates|rate (cut|hike)|emergency|rate decision|statement|raises rates|lowers rates|holds rates|leaves rates unchanged)\b"),
    ("data release", r"^(us|u\.s\.)\s.*" + _DATA + r".*\bactual\b"),
    ("geopolitical shock", r"\b(missile (strike|attack)|invades|invasion of|declares war|nuclear (strike|test|weapon)|assassinat|launch(es|ed)? strikes on|attack on (us|u\.s\.|american|israel|iran|taiwan))\b"),
    ("market stress", r"\b(circuit breaker|trading halt(ed)?|emergency (fed )?meeting|downgrades? (the )?(us|u\.s\.)|us default)\b"),
]
IMPACT_2 = [
    ("tariffs", r"\btariffs?\b"), ("fed speaker", r"\b(powell|fomc|fed's|fed chair|fed governor)\b"), ("white house", r"\btrump\b|white house"),
    ("megacap", r"\b(nvidia|apple|microsoft|amazon|alphabet|google|meta|tesla|broadcom)\b.*\b(earnings|guidance|results|revenue|ban|probe|export)\b"),
    ("china", r"\bchina\b.*\b(export|chip|retaliat|sanction|rare earth)"), ("supply", r"\b(opec|treasury auction|refunding)\b"),
    ("us data", r"^(us|u\.s\.)\s.*\bactual\b"), ("geopolitics", r"\b(ceasefire|missile|nuclear|strikes?)\b"),
]
_TRUMP_PREFIX = "trump (truth social): "
_PRINT = re.compile(r"actual\s*(-?[\d.]+)\s*[%kmb]*\s*\(forecast\s*(-?[\d.]+)", re.I)


def score(title):
    """(impact 0-3, tag). 3 = can move the index by itself; 2 = matters; below that it is background.
    A Truth Social post is scored on its text alone (every one of them mentions Trump). A data print that only
    matches its forecast is not a surprise and is held at 2."""
    t = title.lower()
    own_post = t.startswith(_TRUMP_PREFIX)
    body = t[len(_TRUMP_PREFIX):] if own_post else t
    if own_post:
        return (3, "trump policy") if re.search(_POLICY, body) else (1, "trump post")
    for tag, rx in IMPACT_3:
        if re.search(rx, body):
            if tag == "data release":
                m = _PRINT.search(body)
                if m and float(m.group(1)) == float(m.group(2)):
                    return 2, "data in line with forecast"
            return 3, tag
    for tag, rx in IMPACT_2:
        if re.search(rx, body):
            return 2, tag
    return 0, None


def _cid(text):
    return hashlib.sha1(text[:90].lower().encode()).hexdigest()[:12]


def release_catalysts(events, now, max_age_min):
    """A scheduled high-importance release whose actual number is out."""
    out = []
    for e in events:
        if e.get("actual") is None or not 0 <= now - e["ts"] <= max_age_min * 60:
            continue
        text = "DATA: %s actual %s%s (forecast %s, previous %s)" % (e["title"], e["actual"], e.get("unit") or "", e.get("forecast"), e.get("previous"))
        out.append({"id": _cid("release " + e["title"] + e["date"]), "impact": 3, "tag": "data release", "title": text, "ts": e["ts"], "source": "calendar"})
    return out


def headline_catalysts(items, now, max_age_min, min_impact, source):
    out = []
    for it in items:
        if it.get("ts") is None or not 0 <= now - it["ts"] <= max_age_min * 60:
            continue
        impact, tag = score(it["title"])
        if impact >= min_impact:
            out.append({"id": _cid(it["title"]), "impact": impact, "tag": tag, "title": it["title"], "ts": it["ts"], "source": source})
    return out


def pick_catalyst(candidates, used_ids, now):
    """The strongest, then newest, catalyst that has not been traded yet."""
    fresh = [c for c in candidates if c["id"] not in set(used_ids)]
    if not fresh:
        return None
    best = sorted(fresh, key=lambda c: (-c["impact"], -c["ts"]))[0]
    return dict(best, age_minutes=round((now - best["ts"]) / 60, 1), others=[c["title"][:140] for c in fresh if c["id"] != best["id"]][:4])


# ---- session direction call ----------------------------------------------------------------------------------------
def _sessions(bars, tz):
    """bars (any interval up to 15 minutes) -> {day: {"open", "marks" {minute: price}, "close"}} for the cash session."""
    days = {}
    for b in bars:
        d = datetime.fromtimestamp(b["t"], tz)
        m = d.hour * 60 + d.minute
        if d.weekday() > 4 or m < OPEN_MIN or m >= CLOSE_MIN:
            continue
        s = days.setdefault(d.strftime("%Y-%m-%d"), {"open": None, "marks": {}, "close": None, "last": None, "first_min": m})
        if m == OPEN_MIN:
            s["open"] = b["o"]
        s["last"] = (m, b["c"])
        for c in CHECKS:  # the last bar that starts before a check is the price at that check
            if m < c:
                s["marks"][c] = b["c"]
                s.setdefault("_mark_min", {})[c] = m
                break
    out = {}
    for day, s in days.items():
        if s["open"] is None:
            continue
        # a mark only counts when a bar within 15 minutes before the check exists
        marks = {c: p for c, p in s["marks"].items() if c - s["_mark_min"][c] <= 15}
        last_m, last_c = s["last"]
        out[day] = {"open": s["open"], "marks": marks, "close": last_c if last_m >= CLOSE_MIN - 15 else None, "last": last_c, "last_min": last_m}
    return out


def session_call(hist_bars, live_bars, daily_closes, now, tz_name="America/New_York"):
    """hist_bars: at least ~3 weeks of bars for the range statistics (percent moves, so its price basis does not matter).
    live_bars: today's and yesterday's bars on the venue's price. daily_closes: oldest first, excluding today."""
    tz = ZoneInfo(tz_name)
    now_dt = datetime.fromtimestamp(now, tz)
    today = now_dt.strftime("%Y-%m-%d")
    now_min = now_dt.hour * 60 + now_dt.minute
    hist = _sessions(hist_bars, tz)
    live = _sessions(live_bars, tz)
    out = {"status": "no_session", "record": RECORD}
    if today not in live:
        return out
    prior_days = sorted(d for d in hist if d < today and hist[d]["close"] is not None)
    prev_close = next((live[d]["close"] for d in sorted(live, reverse=True) if d < today and live[d]["close"] is not None), None)
    if prev_close is None or not prior_days:
        return dict(out, status="not_enough_history")
    s = live[today]
    trend = None
    if len(daily_closes) >= TREND_DAYS:
        trend = "up" if prev_close > sum(daily_closes[-TREND_DAYS:]) / TREND_DAYS else "down"
    gap = "up" if s["open"] > prev_close else "down"

    def band(minute):
        moves = [abs(hist[d]["marks"][minute] / hist[d]["open"] - 1) for d in prior_days[-LOOKBACK:] if minute in hist[d]["marks"]]
        if len(moves) < MIN_SESSIONS:
            return None
        sig = sum(moves) / len(moves)
        return max(s["open"], prev_close) * (1 + sig), min(s["open"], prev_close) * (1 - sig)

    out.update(open=s["open"], prior_close=prev_close, last=s["last"], trend_50d=trend, gap=gap)
    nxt = next((c for c in CHECKS if c > now_min), None)
    if nxt:
        b = band(nxt)
        if b:
            out["next_check"] = {"time": "%02d:%02d" % divmod(nxt, 60), "up_above": round(b[0], 2), "down_below": round(b[1], 2)}
    ready = False
    for c in CHECKS:
        if c > now_min or c not in s["marks"]:
            continue
        b = band(c)
        if not b:
            continue
        ready = True
        px = s["marks"][c]
        side = "up" if px > b[0] else "down" if px < b[1] else None
        if side:
            agrees = None if trend is None else trend == side
            return dict(out, status=side, time="%02d:%02d" % divmod(c, 60), price=px, band=round(b[0] if side == "up" else b[1], 2),
                        agrees_with_trend=agrees, agrees_with_gap=gap == side,
                        still_beyond_band=(s["last"] > b[0]) if side == "up" else (s["last"] < b[1]),
                        measured_right_pct=RECORD["with_trend_right_pct"] if agrees else RECORD["against_trend_right_pct"] if agrees is False else RECORD["all_right_pct"])
    if now_min < CHECKS[0]:
        return dict(out, status="before_first_check")
    if not ready:
        return dict(out, status="not_enough_history")
    return dict(out, status="no_call_yet" if nxt else "no_call_today")


class Intel:
    """Fetches each piece on its own clock and hands the brain one dict."""

    def __init__(self, cfg, now_fn=time.time):
        self.cfg = cfg
        self.now = now_fn
        self._cache = {}

    def _cached(self, key, ttl, fn, default):
        hit = self._cache.get(key)
        if hit and self.now() - hit[0] < ttl:
            return hit[1]
        try:
            val = fn()
        except Exception as e:  # network or parse trouble: keep the old value, else the default
            val = hit[1] if hit else dict(default, error=str(e)[:120]) if isinstance(default, dict) else default
        self._cache[key] = (self.now(), val)
        return val

    def _events(self, now):
        tz = self.cfg["session"]["timezone"]
        hit = self._cache.get("calendar")
        # poll fast around a release so the actual number is seen within seconds, slowly otherwise
        near = bool(hit) and any(e.get("actual") is None and -120 <= now - e["ts"] <= 600 for e in hit[1])
        return self._cached("calendar", 20 if near else 1800, lambda: calendar(now, tz), [])

    def catalyst(self, used_ids=()):
        """The freshest high-impact item not yet traded, or None. Cheap enough to run every heartbeat."""
        c = self.cfg.get("catalyst", {})
        if not c.get("enabled", True):
            return None
        now, age, floor = self.now(), c.get("max_age_minutes", 10), c.get("min_impact", 3)
        cands = release_catalysts(self._events(now), now, age)
        cands += headline_catalysts(self._cached("wire", 20, wire, []), now, age, floor, "FinancialJuice")
        cands += headline_catalysts(self._cached("trump", 30, trump_posts, []), now, age, floor, "Truth Social")
        return pick_catalyst(cands, used_ids, now)

    def gather(self, bars):
        tz = self.cfg["session"]["timezone"]
        sym = self.cfg["instrument"]["yahoo_symbol"]
        now = self.now()
        events = self._events(now)
        hist = self._cached("hist", 6 * 3600, lambda: _yahoo(sym, "60d", "15m")[0], [])
        daily = self._cached("daily", 6 * 3600, lambda: [b["c"] for b in _yahoo(sym, "6mo", "1d")[0]], [])
        today = datetime.fromtimestamp(now, ZoneInfo(tz)).strftime("%Y-%m-%d")
        daily_ex_today = daily[:-1] if daily and hist and datetime.fromtimestamp(hist[-1]["t"], ZoneInfo(tz)).strftime("%Y-%m-%d") == today else daily
        try:
            call = session_call(hist, bars, daily_ex_today, now, tz) if hist else {"status": "unavailable"}
        except Exception as e:
            call = {"status": "unavailable", "error": str(e)[:120]}
        return {
            "session_call": call,
            "macro": self._cached("macro", 300, macro_snapshot, []),
            "calendar_high_importance": [dict(e, minutes_away=round((e["ts"] - now) / 60)) for e in events if e["date"] >= today][:12],
            "wire": [dict(w, impact=score(w["title"])[0]) for w in self._cached("wire", 20, wire, [])[:15]],
            "trump_posts": [w["title"][:400] + " (%s)" % w["published"] for w in self._cached("trump", 30, trump_posts, [])[:4]],
            "blackouts": blackouts(events),
        }
