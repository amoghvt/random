"""Intel: the session direction call, the calendar parser and the two gates in risk.py that read them."""
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from _fx import cfg_for
from jarvis_core import brain, intel, risk

ET = ZoneInfo("America/New_York")


def ts(day, hh, mm):
    return int(datetime(2025, 6, day, hh, mm, tzinfo=ET).timestamp())


def session(day, open_px, move):
    """26 fifteen-minute bars walking linearly from open_px to open_px * (1 + move)."""
    out = []
    for k in range(26):
        o, c = open_px * (1 + move * k / 26), open_px * (1 + move * (k + 1) / 26)
        out.append({"t": ts(day, 9, 30) + k * 900, "o": o, "h": max(o, c) + 1, "l": min(o, c) - 1, "c": c, "v": 1})
    return out


QUIET = [2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20]
HIST = [b for i, d in enumerate(QUIET) for b in session(d, 20000, 0.002 if i % 2 else -0.002)]


class SessionCall(unittest.TestCase):
    def test_up_call_with_trend_and_gap(self):
        live = session(20, 20000, 0.002) + session(23, 20100, 0.02)
        c = intel.session_call(HIST, live, [19000.0] * 60, ts(23, 10, 1))
        self.assertEqual((c["status"], c["time"], c["agrees_with_trend"], c["agrees_with_gap"]), ("up", "10:00", True, True))
        self.assertEqual(c["measured_right_pct"], 63)

    def test_against_trend_is_marked_as_a_coin_flip(self):
        live = session(20, 20000, 0.002) + session(23, 20100, 0.02)
        c = intel.session_call(HIST, live, [25000.0] * 60, ts(23, 10, 1))
        self.assertEqual((c["status"], c["agrees_with_trend"], c["measured_right_pct"]), ("up", False, 49))

    def test_no_look_ahead_before_the_first_check(self):
        live = session(20, 20000, 0.002) + session(23, 20100, 0.02)
        seen = [b for b in live if b["t"] + 900 <= ts(23, 9, 50)]
        self.assertEqual(intel.session_call(HIST, seen, [], ts(23, 9, 50))["status"], "before_first_check")

    def test_quiet_day_gives_no_call_and_the_levels_to_watch(self):
        live = session(20, 20000, 0.002) + session(23, 20040, 0.0003)
        seen = [b for b in live if b["t"] + 900 <= ts(23, 11, 5)]
        c = intel.session_call(HIST, seen, [], ts(23, 11, 5))
        self.assertEqual(c["status"], "no_call_yet")
        self.assertEqual(c["next_check"]["time"], "11:30")
        self.assertGreater(c["next_check"]["up_above"], c["next_check"]["down_below"])

    def test_not_enough_history(self):
        live = session(20, 20000, 0.002) + session(23, 20100, 0.02)
        self.assertEqual(intel.session_call(HIST[:26 * 4], live, [], ts(23, 11, 0))["status"], "not_enough_history")


class Calendar(unittest.TestCase):
    def test_parse_keeps_high_importance_in_local_time(self):
        rows = {"result": [
            {"title": "CPI YoY", "date": "2025-06-11T12:30:00.000Z", "importance": 1, "actual": None, "forecast": 2.5, "previous": 2.3},
            {"title": "Redbook", "date": "2025-06-11T12:55:00.000Z", "importance": -1}]}
        ev = intel.parse_calendar(rows)
        self.assertEqual([(e["title"], e["date"], e["time"]) for e in ev], [("CPI YoY", "2025-06-11", "08:30")])
        b = intel.blackouts(ev)
        self.assertEqual((b[0][1] - b[0][0]) / 60, 25)


class Gates(unittest.TestCase):
    def setUp(self):
        self.cfg = cfg_for(tempfile.mkdtemp())

    def decision(self, price=20000.0, side="long"):
        sgn = 1 if side == "long" else -1
        return {"action": side, "contracts": 1, "entry_type": "market", "entry_price": None, "stop_price": price - sgn * 20,
                "target_price": price + sgn * 60, "confidence": 0.9}

    def test_with_trend_gate(self):
        cfg = dict(self.cfg, intel={"enabled": True, "require_with_trend_call": True})
        state = {"day": {}, "positions": []}
        self.assertIn("no session direction call", repr(risk.check(cfg, self.decision(), state, 20000.0)))
        state["intel"] = {"session_call": {"status": "down", "agrees_with_trend": True}}
        self.assertIn("against the session call", repr(risk.check(cfg, self.decision(), state, 20000.0)))
        state["intel"] = {"session_call": {"status": "up", "agrees_with_trend": False}}
        self.assertIn("does not agree with the 50-day trend", repr(risk.check(cfg, self.decision(), state, 20000.0)))
        state["intel"] = {"session_call": {"status": "up", "agrees_with_trend": True}}
        self.assertTrue(risk.check(cfg, self.decision(), state, 20000.0))
        self.assertTrue(risk.check(self.cfg, self.decision(), {"day": {}, "positions": []}, 20000.0))  # gate off by default

    def test_calendar_blackout_blocks_the_session(self):
        tz = ZoneInfo(self.cfg["session"]["timezone"])
        now = datetime(2025, 6, 11, 10, 0, tzinfo=tz).timestamp()
        clear = risk.pre_check(self.cfg, {"day": {}}, now=now)
        hit = risk.pre_check(self.cfg, {"day": {}, "intel": {"blackouts": [[now - 60, now + 600, "CPI YoY"]]}}, now=now)
        self.assertNotIn("calendar blackout", repr(clear))
        self.assertIn("calendar blackout: CPI YoY", repr(hit))


class Message(unittest.TestCase):
    def test_intel_reaches_the_brain_without_the_raw_blackout_list(self):
        msg = brain.build_user_message({"price": 1}, None, {}, [], [], [], "", {}, intel={"session_call": {"status": "up"}, "blackouts": [[1, 2, "x"]]})
        self.assertIn('"session_call"', msg)
        self.assertNotIn('"blackouts"', msg)


if __name__ == "__main__":
    unittest.main()
