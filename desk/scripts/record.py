"""Record raw free-source market data into data/recorded/. Raw provider JSON is
kept verbatim (gzipped) so the replay and fixtures are reproducible. Run: python3 scripts/record.py"""
import gzip, json, sys, time, urllib.parse, urllib.request, pathlib, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent / "data" / "recorded"
UA = {"User-Agent": "Mozilla/5.0"}
SYMS = ["NQ=F","ES=F","YM=F","RTY=F","MNQ=F","^SOX","^VIX","^VIX3M","DX-Y.NYB","^IRX","^FVX","^TNX","^TYX","ZT=F","ZN=F","ZQ=F",
        "NVDA","AMZN","INTC","CRWV","NBIS","SNDK","TTWO","AMD","AVGO","MU","TSM","QQQ","RSP","SPY","XLP","XLU","SOXX","GLD","IBIT",
        "CL=F","GC=F","BTC-USD","ETH-USD","^NDX"]
FRAMES = [("1m","7d"),("5m","60d"),("15m","60d"),("1h","730d"),("1d","5y")]

def get(url, headers=UA, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
                return r.read()
        except Exception as e:
            err = e; time.sleep(1.5 * (i + 1))
    raise err

def main():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {"recorded_at": stamp, "source": "query1.finance.yahoo.com v8 chart (delayed, unofficial)", "files": {}}
    for s in SYMS:
        for iv, rg in FRAMES:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(s)}?interval={iv}&range={rg}&includePrePost=true"
            name = f"{s.replace('^','_').replace('=','_')}.{iv}.json.gz"
            try:
                raw = get(url); res = json.loads(raw)["chart"]["result"][0]; n = len(res.get("timestamp") or [])
                if n == 0: raise ValueError("empty")
                (ROOT / "candles" / name).write_bytes(gzip.compress(raw, 9, mtime=0))
                manifest["files"][name] = {"symbol": s, "interval": iv, "bars": n, "first": res["timestamp"][0], "last": res["timestamp"][-1]}
            except Exception as e:
                manifest["files"][name] = {"symbol": s, "interval": iv, "error": str(e)[:120]}
            time.sleep(0.15)
    hdr = dict(UA, Origin="https://www.tradingview.com")
    cal = []
    start = datetime.date(2024, 7, 1)
    while start < datetime.date(2026, 12, 15):
        end = start + datetime.timedelta(days=28)
        url = f"https://economic-calendar.tradingview.com/events?from={start}T00:00:00.000Z&to={end}T00:00:00.000Z&countries=US"
        cal += json.loads(get(url, hdr)).get("result", []); start = end; time.sleep(0.2)
    seen = {}
    for e in cal: seen[e["id"]] = e
    (ROOT / "calendar" / "us_events.json.gz").write_bytes(gzip.compress(json.dumps(sorted(seen.values(), key=lambda e: e["date"])).encode(), 9, mtime=0))
    manifest["calendar"] = {"source": "economic-calendar.tradingview.com", "events": len(seen)}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    ok = sum(1 for f in manifest["files"].values() if "bars" in f); print("ok", ok, "err", len(manifest["files"]) - ok, "calendar", len(seen))
    for k, f in manifest["files"].items():
        if "error" in f: print("ERR", k, f["error"])
main()
