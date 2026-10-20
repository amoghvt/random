"""Market data adapters.

Bars are plain dicts: {"t": epoch_seconds, "o","h","l","c","v"}.

YahooDelayed  - free, no key, the NQ=F continuous contract from Yahoo's chart
                endpoint. Delayed and unofficial; good enough to run paper and
                to learn the system. Not good enough to scalp.
TradovateData - placeholder: Tradovate streams real-time CME data over a
                WebSocket for subscribers. Wire it here when you have it.
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = "Mozilla/5.0 (compatible; jarvis-nq/0.1)"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/%s?range=%s&interval=%s"
YAHOO_RSS = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%s&region=US&lang=en-US"


class DataError(Exception):
    pass


def _get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise DataError("HTTP %s from %s" % (e.code, url))
    except urllib.error.URLError as e:
        raise DataError("network error for %s: %s" % (url, e.reason))


def parse_yahoo_chart(payload):
    """Turn Yahoo's chart JSON into a list of bars. Rows with nulls are dropped."""
    data = json.loads(payload) if isinstance(payload, (bytes, str)) else payload
    chart = data.get("chart", {})
    if chart.get("error"):
        raise DataError("yahoo: %s" % chart["error"])
    results = chart.get("result") or []
    if not results:
        raise DataError("yahoo: empty result")
    r = results[0]
    ts = r.get("timestamp") or []
    q = (r.get("indicators", {}).get("quote") or [{}])[0]
    bars = []
    for i, t in enumerate(ts):
        try:
            o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
            v = (q.get("volume") or [None] * len(ts))[i]
        except (KeyError, IndexError):
            continue
        if None in (o, h, l, c):
            continue
        bars.append({"t": int(t), "o": float(o), "h": float(h), "l": float(l),
                     "c": float(c), "v": int(v or 0)})
    meta = r.get("meta", {})
    return bars, meta


class YahooDelayed:
    def __init__(self, symbol="NQ=F", interval="5m", lookback_days=5):
        self.symbol = symbol
        self.interval = interval
        self.lookback_days = lookback_days
        self.last_fetch = None

    def bars(self):
        rng = "%dd" % max(1, self.lookback_days)
        url = YAHOO_CHART % (urllib.parse.quote(self.symbol), rng, self.interval)
        bars, meta = parse_yahoo_chart(_get(url))
        self.last_fetch = time.time()
        if not bars:
            raise DataError("yahoo returned no bars for %s" % self.symbol)
        return bars, meta


class TradovateData:
    """Not implemented: Tradovate market data is a WebSocket (md.tradovateapi.com)
    behind a paid data subscription. Implement .bars() returning the same shape."""

    def __init__(self, *a, **k):
        raise DataError("Tradovate market data adapter not implemented; use source 'yahoo' "
                        "or wire your feed into jarvis_core/data.py")


def make_source(cfg):
    d = cfg["data"]
    if d["source"] == "yahoo":
        return YahooDelayed(cfg["instrument"]["yahoo_symbol"], d["interval"], d["lookback_days"])
    if d["source"] == "tradovate":
        return TradovateData()
    raise DataError("unknown data.source %r" % d["source"])


# ---- headlines -------------------------------------------------------------

def parse_rss(xml_bytes, limit=15):
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return out
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        pub = (item.findtext("pubDate") or "").strip()
        link = (item.findtext("link") or "").strip()
        if title:
            out.append({"title": re.sub(r"\s+", " ", title), "published": pub, "link": link})
        if len(out) >= limit:
            break
    return out


def headlines(symbols, limit_per=8):
    seen, out = set(), []
    for s in symbols:
        try:
            items = parse_rss(_get(YAHOO_RSS % urllib.parse.quote(s)), limit=limit_per)
        except DataError:
            continue
        for it in items:
            key = it["title"].lower()
            if key in seen:
                continue
            seen.add(key)
            it["symbol"] = s
            out.append(it)
    return out
