"""Catalyst mode: which headlines qualify, how fresh they must be, and exactly what the risk layer waives for them."""
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from _fx import cfg_for
from jarvis_core import intel, risk

NOW = 1_800_000_000.0


class Scoring(unittest.TestCase):
    def test_index_moving_headlines_score_3(self):
        for t in ("Trump: We will impose 100% tariffs on China from Monday",
                  "Trump (Truth Social): The Fed must cut interest rates NOW",
                  "US CPI YoY Actual 3.4% (Forecast 3.1%, Previous 3.0%)",
                  "US Non-Farm Payrolls Actual 45k (Forecast 150k, Previous 130k)",
                  "FOMC statement: Fed cuts rates by 50bps",
                  "Israel launches strikes on Iran nuclear sites",
                  "Trump (Truth Social): Stocks are down sharply because of the election results"):
            self.assertEqual(intel.score(t)[0], 3, t)

    def test_background_headlines_do_not(self):
        for t in ("Turkish Foreign Minister: Mecca pact allies agreed on some principles",
                  "MOC Imbalance", "Venezuela's Rodriguez expects oil output at 1.3m b/d by year-end.",
                  "OpenAI countersues Apple for stealing trade secrets - FT. $AAPL",
                  "Trump (Truth Social): Happy Thanksgiving to all",
                  "Trump (Truth Social): Fake News CNN was hoping for a bad outcome in Iowa",
                  "German Unemployment Rate Actual 6.4% (Forecast 6.4%, Previous 6.4%)",
                  "Spanish CPI YoY Flash Actual 4.1% (Forecast 4.7%, Previous 4.9%)",
                  "US CPI YoY Actual 3.1% (Forecast 3.1%, Previous 3.0%)",
                  "Ukraine's FM: Oil could only be part of a bigger energy ceasefire deal.",
                  "Putin will hold a meeting on the development of the Navy's multi-purpose nuclear submarine group"):
            self.assertLess(intel.score(t)[0], 3, t)

    def test_fed_speaker_is_2_not_3(self):
        self.assertEqual(intel.score("Fed's Waller: inflation progress has stalled")[0], 2)


class Picking(unittest.TestCase):
    def items(self):
        return [{"title": "Trump: 100% tariffs on China from Monday", "ts": NOW - 120},
                {"title": "Trump: 100% tariffs on China from Monday (old)", "ts": NOW - 3600},
                {"title": "MOC Imbalance", "ts": NOW - 30},
                {"title": "Fed's Waller: inflation progress has stalled", "ts": NOW - 60}]

    def test_only_fresh_high_impact_items_qualify(self):
        c = intel.headline_catalysts(self.items(), NOW, 10, 3, "FinancialJuice")
        self.assertEqual([x["title"] for x in c], ["Trump: 100% tariffs on China from Monday"])
        self.assertEqual(intel.headline_catalysts(self.items(), NOW + 3600, 10, 3, "x"), [])

    def test_a_used_catalyst_is_not_offered_again(self):
        c = intel.headline_catalysts(self.items(), NOW, 10, 3, "x")
        best = intel.pick_catalyst(c, [], NOW)
        self.assertEqual(best["age_minutes"], 2.0)
        self.assertIsNone(intel.pick_catalyst(c, [best["id"]], NOW))

    def test_a_release_becomes_a_catalyst_only_once_the_number_is_out(self):
        ev = [{"title": "CPI YoY", "date": "2027-01-15", "ts": NOW - 60, "actual": None, "forecast": 3.1, "previous": 3.0, "unit": "%"}]
        self.assertEqual(intel.release_catalysts(ev, NOW, 10), [])
        ev[0]["actual"] = 3.4
        c = intel.release_catalysts(ev, NOW, 10)
        self.assertEqual((c[0]["impact"], c[0]["tag"]), (3, "data release"))
        self.assertIn("actual 3.4% (forecast 3.1", c[0]["title"])


class Gates(unittest.TestCase):
    def setUp(self):
        self.cfg = dict(cfg_for(tempfile.mkdtemp()), intel={"require_with_trend_call": True})
        self.cat = {"id": "abc", "impact": 3, "title": "Trump: tariffs", "ts": NOW}

    def entry(self, basis):
        return {"action": "short", "contracts": 1, "entry_type": "market", "entry_price": None, "stop_price": 20020.0,
                "target_price": 19940.0, "confidence": 0.9, "basis": basis}

    def test_a_catalyst_trade_skips_the_trend_gate_but_needs_a_real_catalyst(self):
        state = {"day": {}, "positions": [], "intel": {"session_call": {"status": "up", "agrees_with_trend": True}, "catalyst": self.cat}}
        self.assertIn("against the session call", repr(risk.check(self.cfg, self.entry("technical"), state, 20000.0)))
        self.assertTrue(risk.check(self.cfg, self.entry("catalyst"), state, 20000.0))
        state["intel"]["catalyst"] = None
        self.assertIn("no fresh high-impact catalyst", repr(risk.check(self.cfg, self.entry("catalyst"), state, 20000.0)))

    def test_one_trade_per_catalyst_and_the_other_limits_still_bite(self):
        state = {"day": {}, "positions": [], "intel": {"catalyst": self.cat}, "catalysts_used": ["abc"]}
        self.assertIn("already traded once", repr(risk.check(self.cfg, self.entry("catalyst"), state, 20000.0)))
        state["catalysts_used"] = []
        wide = dict(self.entry("catalyst"), stop_price=20500.0)
        self.assertIn("wider than max_stop_points", repr(risk.check(self.cfg, wide, state, 20000.0)))
        no_stop = dict(self.entry("catalyst"), stop_price=None)
        self.assertIn("every entry needs a stop", repr(risk.check(self.cfg, no_stop, state, 20000.0)))

    def test_blackout_holds_before_the_number_and_lifts_after_it_for_a_catalyst(self):
        tz = ZoneInfo(self.cfg["session"]["timezone"])
        rel = datetime(2025, 6, 11, 10, 0, tzinfo=tz).timestamp()
        state = {"day": {}, "intel": {"blackouts": [[rel - 600, rel + 900, "CPI YoY", rel]]}}
        self.assertIn("calendar blackout", repr(risk.pre_check(self.cfg, state, now=rel - 120, catalyst=True)))
        self.assertIn("calendar blackout", repr(risk.pre_check(self.cfg, state, now=rel + 120, catalyst=False)))
        self.assertNotIn("calendar blackout", repr(risk.pre_check(self.cfg, state, now=rel + 120, catalyst=True)))

    def test_a_catalyst_outside_the_windows_needs_the_switch(self):
        tz = ZoneInfo(self.cfg["session"]["timezone"])
        night = datetime(2025, 6, 11, 20, 0, tzinfo=tz).timestamp()
        self.assertIn("outside trade windows", repr(risk.pre_check(self.cfg, {"day": {}}, now=night, catalyst=True)))
        cfg = dict(self.cfg, catalyst={"allow_outside_windows": True})
        self.assertNotIn("outside trade windows", repr(risk.pre_check(cfg, {"day": {}}, now=night, catalyst=True)))
        loss = {"day": {"consecutive_losses": 99}}
        self.assertIn("max consecutive losses", repr(risk.pre_check(cfg, loss, now=night, catalyst=True)))


if __name__ == "__main__":
    unittest.main()
