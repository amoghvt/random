import os
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ET = ZoneInfo("America/New_York")


def bars_for(days=2, interval_min=5, start_price=24800.0, tz=ET):
    """Synthetic 24h bars ending today 10:30 ET, Globex 18:00 -> 17:00."""
    end = datetime.now(tz).replace(hour=10, minute=30, second=0, microsecond=0)
    while end.weekday() >= 5:  # keep the synthetic session on a weekday
        end -= timedelta(days=1)
    start = (end - timedelta(days=days)).replace(hour=18, minute=0)
    out, p, t = [], start_price, start
    i = 0
    while t <= end:
        if t.weekday() < 5 or True:
            o = p
            h = o + 3 + (i % 5)
            l = o - 3 - (i % 3)
            c = o + ((i % 7) - 3) * 0.5
            out.append({"t": int(t.timestamp()), "o": o, "h": h, "l": l, "c": c, "v": 100 + (i % 20)})
            p = c
        t += timedelta(minutes=interval_min)
        i += 1
    return out


def cfg_for(tmpdir, **over):
    from jarvis_core import config as c
    base = c._merge(c.DEFAULTS, over)
    base["_root"] = tmpdir
    base["_path"] = os.path.join(tmpdir, "config.json")
    c.validate(base)
    return base
