import unittest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from _fx import bars_for, ET
from jarvis_core import features, data

ET = ZoneInfo("America/New_York")


class Features(unittest.TestCase):
    def test_compute_levels(self):
        bars = bars_for(days=2)
        pic = features.compute(bars, now=bars[-1]["t"])
        L = pic["levels"]
        for k in ("prior_day_high", "prior_day_low", "overnight_high", "overnight_low", "rth_open", "orb_high", "vwap_rth"):
            self.assertIsNotNone(L[k], k)
        self.assertGreaterEqual(L["prior_day_high"], L["prior_day_low"])
        self.assertGreaterEqual(L["orb_high"], L["orb_low"])
        self.assertIn(pic["trend_ema"], ("up", "down", "mixed"))
        self.assertGreater(pic["atr14"], 0)
        self.assertEqual(len(pic["recent_bars"]), 12)
        self.assertEqual(pic["phase"], "morning")  # 10:30 ET
        self.assertEqual(pic["day"]["bars_since_rth_open"], 13)  # 09:30..10:30 inclusive at 5m

    def test_orb_is_first_15_minutes(self):
        bars = bars_for(days=1)
        pic = features.compute(bars, now=bars[-1]["t"])
        last_day = datetime.fromtimestamp(bars[-1]["t"], ET).date()
        rth = [b for b in bars if datetime.fromtimestamp(b["t"], ET).time() >= features.RTH_OPEN
               and datetime.fromtimestamp(b["t"], ET).date() == last_day]
        first3 = rth[:3]
        self.assertEqual(pic["levels"]["orb_high"], max(b["h"] for b in first3))

    def test_session_date_rolls_at_1800(self):
        d = datetime(2026, 10, 19, 18, 30, tzinfo=ET)
        self.assertEqual(features.session_date(d.timestamp(), ET), d.date() + timedelta(days=1))
        d2 = datetime(2026, 10, 19, 17, 30, tzinfo=ET)
        self.assertEqual(features.session_date(d2.timestamp(), ET), d2.date())

    def test_phase(self):
        mk = lambda h, m: datetime(2026, 10, 20, h, m, tzinfo=ET)
        self.assertEqual(features.phase(mk(9, 45)), "open-drive")
        self.assertEqual(features.phase(mk(12, 0)), "midday-chop")
        self.assertEqual(features.phase(mk(15, 30)), "power-hour")
        self.assertEqual(features.phase(mk(20, 0)), "globex")
        self.assertEqual(features.phase(datetime(2026, 10, 24, 10, 0, tzinfo=ET)), "weekend")

    def test_in_window(self):
        now = datetime(2026, 10, 20, 10, 0, tzinfo=ET)
        self.assertTrue(features.in_window(now, [["09:35", "11:30"]]))
        self.assertFalse(features.in_window(now.replace(hour=12), [["09:35", "11:30"]]))

    def test_empty(self):
        self.assertIn("error", features.compute([]))


class YahooParse(unittest.TestCase):
    def test_parse_drops_nulls(self):
        payload = {"chart": {"result": [{"timestamp": [1, 2, 3], "meta": {"symbol": "NQ=F"},
                   "indicators": {"quote": [{"open": [1, None, 3], "high": [2, 2, 4], "low": [0, 0, 2],
                                             "close": [1.5, 1.5, 3.5], "volume": [10, 10, None]}]}}], "error": None}}
        bars, meta = data.parse_yahoo_chart(payload)
        self.assertEqual([b["t"] for b in bars], [1, 3])
        self.assertEqual(bars[1]["v"], 0)

    def test_parse_error(self):
        with self.assertRaises(data.DataError):
            data.parse_yahoo_chart({"chart": {"result": None, "error": {"code": "Not Found"}}})

    def test_rss(self):
        xml = b"<rss><channel><item><title>NQ  futures   rise</title><pubDate>x</pubDate><link>l</link></item></channel></rss>"
        self.assertEqual(data.parse_rss(xml)[0]["title"], "NQ futures rise")


if __name__ == "__main__":
    unittest.main()
