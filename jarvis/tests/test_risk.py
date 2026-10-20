import os
import tempfile
import time
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from _fx import cfg_for
from jarvis_core import risk

ET = ZoneInfo("America/New_York")


def ts(h, m, dow=1):
    """epoch for a weekday (Tue by default) at h:m ET this week."""
    now = datetime.now(ET)
    d = now - __import__("datetime").timedelta(days=(now.weekday() - dow) % 7)
    return d.replace(hour=h, minute=m, second=0, microsecond=0).timestamp()


class PreCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cfg = cfg_for(self.tmp)
        self.state = {"day": {"realized_pnl": 0.0, "trades": 0, "consecutive_losses": 0, "last_loss_ts": None}, "positions": []}

    def test_inside_window_passes(self):
        self.assertTrue(risk.pre_check(self.cfg, self.state, now=ts(10, 0)))

    def test_outside_window_blocks(self):
        v = risk.pre_check(self.cfg, self.state, now=ts(12, 0))
        self.assertFalse(v)
        self.assertIn("outside trade windows", v.reasons[0])

    def test_weekend_blocks(self):
        self.assertFalse(risk.pre_check(self.cfg, self.state, now=ts(10, 0, dow=6)))

    def test_daily_loss_blocks(self):
        self.state["day"]["realized_pnl"] = -500
        self.assertIn("daily loss", repr(risk.pre_check(self.cfg, self.state, now=ts(10, 0))))

    def test_trade_limit_blocks(self):
        self.state["day"]["trades"] = 4
        self.assertIn("trade limit", repr(risk.pre_check(self.cfg, self.state, now=ts(10, 0))))

    def test_consecutive_losses_block(self):
        self.state["day"]["consecutive_losses"] = 2
        self.assertIn("consecutive", repr(risk.pre_check(self.cfg, self.state, now=ts(10, 0))))

    def test_cooldown(self):
        t = ts(10, 0)
        self.state["day"]["last_loss_ts"] = t - 60
        self.assertIn("cooling", repr(risk.pre_check(self.cfg, self.state, now=t)))
        self.state["day"]["last_loss_ts"] = t - 16 * 60
        self.assertTrue(risk.pre_check(self.cfg, self.state, now=t))

    def test_kill_switch(self):
        open(os.path.join(self.tmp, "STOP"), "w").close()
        self.assertIn("kill switch", repr(risk.pre_check(self.cfg, self.state, now=ts(10, 0))))

    def test_event_blackout(self):
        t = ts(8, 32)
        date = datetime.fromtimestamp(t, ET).strftime("%Y-%m-%d")
        self.cfg["session"]["trade_windows"] = [["08:00", "16:00"]]
        self.cfg["session"]["event_blackouts"] = [{"label": "CPI", "date": date, "time": "08:30", "minutes_before": 5, "minutes_after": 10}]
        self.assertIn("CPI", repr(risk.pre_check(self.cfg, self.state, now=t)))
        self.assertTrue(risk.pre_check(self.cfg, self.state, now=ts(8, 45)))


class OrderCheck(unittest.TestCase):
    def setUp(self):
        self.cfg = cfg_for(tempfile.mkdtemp())
        self.state = {"day": {"realized_pnl": 0.0}, "positions": []}
        self.good = {"action": "long", "contracts": 1, "entry_type": "market", "entry_price": None,
                     "stop_price": 24790.0, "target_price": 24840.0, "confidence": 0.7}

    def test_good_long_passes(self):
        self.assertTrue(risk.check(self.cfg, self.good, self.state, price=24810.0))

    def test_non_entry_passes(self):
        self.assertTrue(risk.check(self.cfg, {"action": "hold"}, self.state, price=1))

    def test_too_many_contracts(self):
        d = dict(self.good, contracts=3)
        self.assertIn("max_contracts", repr(risk.check(self.cfg, d, self.state, 24810.0)))

    def test_no_stop(self):
        d = dict(self.good, stop_price=None)
        self.assertIn("needs a stop", repr(risk.check(self.cfg, d, self.state, 24810.0)))

    def test_stop_wrong_side(self):
        d = dict(self.good, stop_price=24830.0)
        self.assertIn("wrong side", repr(risk.check(self.cfg, d, self.state, 24810.0)))

    def test_stop_too_wide_and_too_tight(self):
        self.assertIn("wider", repr(risk.check(self.cfg, dict(self.good, stop_price=24700.0), self.state, 24810.0)))
        self.assertIn("tighter", repr(risk.check(self.cfg, dict(self.good, stop_price=24808.0), self.state, 24810.0)))

    def test_reward_risk(self):
        d = dict(self.good, target_price=24820.0)  # 10 reward vs 20 risk
        self.assertIn("reward:risk", repr(risk.check(self.cfg, d, self.state, 24810.0)))

    def test_short_mirror(self):
        d = {"action": "short", "contracts": 1, "entry_type": "market", "entry_price": None,
             "stop_price": 24830.0, "target_price": 24770.0, "confidence": 0.8}
        self.assertTrue(risk.check(self.cfg, d, self.state, 24810.0))

    def test_low_confidence(self):
        self.assertIn("confidence", repr(risk.check(self.cfg, dict(self.good, confidence=0.4), self.state, 24810.0)))

    def test_daily_loss_room(self):
        self.state["day"]["realized_pnl"] = -300  # $200 room; 20pt stop = $400 worst case
        self.assertIn("daily loss room", repr(risk.check(self.cfg, self.good, self.state, 24810.0)))

    def test_tick_grid(self):
        self.assertIn("tick grid", repr(risk.check(self.cfg, dict(self.good, stop_price=24790.1), self.state, 24810.0)))

    def test_limit_uses_entry_price(self):
        d = dict(self.good, entry_type="limit", entry_price=24805.0, stop_price=24785.0, target_price=24845.0)
        self.assertTrue(risk.check(self.cfg, d, self.state, 24900.0))

    def test_already_in_position(self):
        self.state["positions"] = [{"side": "long"}]
        self.assertIn("max_open_positions", repr(risk.check(self.cfg, self.good, self.state, 24810.0)))


if __name__ == "__main__":
    unittest.main()
