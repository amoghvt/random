"""Catalyst mode end to end: a fresh headline reaches the brain, overrides the trend gate once, and is not reused."""
import os
import tempfile
import unittest

from _fx import bars_for, cfg_for
from jarvis_core.brain import Brain
from jarvis_core.loop import Jarvis
from test_loop import FakeSource, decision


class FakeIntel:
    def __init__(self, cat):
        self.cat = cat

    def catalyst(self, used_ids=()):
        return None if self.cat is None or self.cat["id"] in used_ids else self.cat

    def gather(self, bars):
        return {"session_call": {"status": "up", "agrees_with_trend": True}, "blackouts": [], "macro": [], "wire": []}


class CatalystLoop(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "knowledge"))
        self.cfg = cfg_for(self.tmp, mode="auto", session={"trade_windows": [["00:00", "23:59"]]})
        self.cfg["intel"] = {"enabled": True, "require_with_trend_call": True}
        self.bars = bars_for(days=2)
        self.price = self.bars[-1]["c"]
        self.now = self.bars[-1]["t"] + 60
        self.seen = []

    def make(self, decisions, cat):
        it = iter(decisions)

        def caller(system, user, schema):
            self.seen.append(user)
            return next(it)
        j = Jarvis(self.cfg, brain=Brain(caller=caller), source=FakeSource(self.bars), fetch_news=False, now_fn=lambda: self.now)
        j.intel = FakeIntel(cat)
        return j

    def short(self, basis):
        return decision(action="short", contracts=1, stop_price=self.price + 20, target_price=self.price - 60, confidence=0.8,
                        basis=basis, catalyst_ref="Trump: 100% tariffs on China")

    def test_catalyst_short_goes_through_against_an_up_call_and_only_once(self):
        cat = {"id": "c1", "impact": 3, "tag": "trump policy", "title": "Trump: 100% tariffs on China", "ts": self.now - 90, "age_minutes": 1.5, "source": "FinancialJuice"}
        j = self.make([self.short("catalyst"), decision(action="close"), self.short("catalyst")], cat)
        out = j.tick()
        self.assertTrue(out["executed"])
        self.assertIn("Trump: 100% tariffs on China", self.seen[0])
        self.assertEqual(j.broker.positions()[0].side, "short")
        self.assertEqual(j.journal.state["catalysts_used"], ["c1"])
        j.tick()                      # the brain closes it
        self.assertFalse(j.broker.positions())
        out = j.tick(force_brain=True)  # the same headline cannot be traded again
        self.assertFalse(out["executed"])
        self.assertFalse(j.broker.positions())

    def test_the_same_short_without_a_catalyst_is_blocked_by_the_trend_gate(self):
        j = self.make([self.short("technical")], None)
        out = j.tick(force_brain=True)
        self.assertFalse(out["executed"])
        self.assertFalse(j.broker.positions())

    def test_claiming_a_catalyst_that_does_not_exist_is_blocked(self):
        j = self.make([self.short("catalyst")], None)
        out = j.tick(force_brain=True)
        self.assertFalse(out["executed"])


if __name__ == "__main__":
    unittest.main()
