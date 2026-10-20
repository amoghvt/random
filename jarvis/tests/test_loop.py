"""The whole loop with a fake brain, fake data and the paper broker. No network."""
import json
import os
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from _fx import bars_for, cfg_for, ET
from jarvis_core.brain import Brain, BrainError, validate_decision, build_user_message, DECISION_SCHEMA
from jarvis_core.loop import Jarvis
from jarvis_core.journal import Journal


class FakeSource:
    def __init__(self, bars):
        self._bars = bars

    def bars(self):
        return self._bars, {}


def decision(**over):
    d = {"action": "flat", "contracts": 0, "entry_type": "market", "entry_price": None, "stop_price": None,
         "target_price": None, "new_stop": None, "confidence": 0.5, "timeframe_minutes": 30, "regime": "chop",
         "thesis": "nothing", "invalidation": "n/a", "crowd_read": "bored", "self_check": "boredom: no"}
    d.update(over)
    return d


class LoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "knowledge"))
        # windows cover the whole day so the synthetic 10:30 ET bars are inside a window on weekdays
        self.cfg = cfg_for(self.tmp, mode="propose", session={"trade_windows": [["00:00", "23:59"]]})
        self.bars = bars_for(days=2)
        self.price = self.bars[-1]["c"]
        self.now = self.bars[-1]["t"] + 60  # 10:31 ET on the synthetic day
        self.calls = []

    def make(self, decisions, mode=None):
        if mode:
            self.cfg["mode"] = mode
        it = iter(decisions)

        def caller(system, user, schema):
            self.calls.append(user)
            return next(it)
        brain = Brain(caller=caller)
        return Jarvis(self.cfg, brain=brain, source=FakeSource(self.bars), fetch_news=False, now_fn=lambda: self.now)

    def test_flat_decision_logs_only(self):
        j = self.make([decision()])
        out = j.tick(force_brain=True)
        self.assertEqual(out["decision"]["action"], "flat")
        self.assertFalse(out["executed"])
        self.assertEqual(len(j.journal.decisions()), 1)
        self.assertFalse(j.broker.positions())

    def test_entry_in_propose_mode_creates_proposal_and_approve_executes(self):
        p = self.price
        d = decision(action="long", contracts=1, confidence=0.75, stop_price=round((p - 20) * 4) / 4,
                     target_price=round((p + 40) * 4) / 4, thesis="failed breakdown")
        j = self.make([d])
        out = j.tick(force_brain=True)
        self.assertEqual(out["verdict"], "PASS")
        self.assertFalse(out["executed"])
        pending = j.journal.state["pending"]
        self.assertEqual(len(pending), 1)
        pid = next(iter(pending))
        msg = j.approve(pid)
        self.assertEqual(msg, "executed")
        self.assertEqual(len(j.broker.positions()), 1)
        self.assertEqual(j.journal.state["pending"], {})

    def test_entry_in_auto_mode_executes(self):
        p = self.price
        d = decision(action="short", contracts=1, confidence=0.8, stop_price=round((p + 15) * 4) / 4,
                     target_price=round((p - 40) * 4) / 4)
        j = self.make([d], mode="auto")
        out = j.tick(force_brain=True)
        self.assertTrue(out["executed"])
        self.assertEqual(j.broker.positions()[0].side, "short")

    def test_risk_blocks_bad_entry(self):
        p = self.price
        d = decision(action="long", contracts=5, confidence=0.9, stop_price=round((p - 20) * 4) / 4,
                     target_price=round((p + 40) * 4) / 4)
        j = self.make([d], mode="auto")
        out = j.tick(force_brain=True)
        self.assertIn("max_contracts", out["verdict"])
        self.assertFalse(out["executed"])

    def test_brain_error_does_not_crash(self):
        def caller(s, u, sch):
            raise BrainError("boom")
        j = Jarvis(self.cfg, brain=Brain(caller=caller), source=FakeSource(self.bars), fetch_news=False, now_fn=lambda: self.now)
        self.assertIn("error", j.tick(force_brain=True))

    def test_kill_switch_flattens(self):
        p = self.price
        d = decision(action="long", contracts=1, confidence=0.8, stop_price=round((p - 20) * 4) / 4,
                     target_price=round((p + 40) * 4) / 4)
        j = self.make([d], mode="auto")
        j.tick(force_brain=True)
        self.assertTrue(j.broker.positions())
        open(os.path.join(self.tmp, "STOP"), "w").close()
        out = j.tick()
        self.assertEqual(out["skipped"], "kill switch")
        self.assertFalse(j.broker.positions())
        self.assertEqual(len(j.journal.trades()), 1)

    def test_manage_position_close(self):
        p = self.price
        enter = decision(action="long", contracts=1, confidence=0.8, stop_price=round((p - 20) * 4) / 4,
                         target_price=round((p + 40) * 4) / 4)
        j = self.make([enter, decision(action="close", thesis="thesis failed")], mode="auto")
        j.tick(force_brain=True)
        out = j.tick(force_brain=True)
        self.assertTrue(out["executed"])
        self.assertFalse(j.broker.positions())
        self.assertEqual(j.journal.state["day"]["trades"], 1)

    def test_context_includes_playbook_and_rules(self):
        with open(os.path.join(self.tmp, "knowledge", "playbook.md"), "w") as f:
            f.write("NEVER_TRADE_FIRST_FIVE")
        j = self.make([decision()])
        j.tick(force_brain=True)
        self.assertIn("NEVER_TRADE_FIRST_FIVE", self.calls[0])
        self.assertIn("max_daily_loss_usd", self.calls[0])
        self.assertIn("Market picture", self.calls[0])

    def test_state_persists_across_instances(self):
        p = self.price
        d = decision(action="long", contracts=1, confidence=0.8, stop_price=round((p - 20) * 4) / 4,
                     target_price=round((p + 40) * 4) / 4)
        j = self.make([d], mode="auto")
        j.tick(force_brain=True)
        j2 = Jarvis(self.cfg, brain=Brain(caller=lambda *a: decision()), source=FakeSource(self.bars), fetch_news=False, now_fn=lambda: self.now)
        self.assertEqual(len(j2.broker.positions()), 1)


class BrainUnit(unittest.TestCase):
    def test_validate(self):
        with self.assertRaises(BrainError):
            validate_decision(decision(action="long", contracts=1))  # no stop
        with self.assertRaises(BrainError):
            validate_decision(decision(action="move_stop"))
        with self.assertRaises(BrainError):
            validate_decision(decision(confidence=1.5))
        validate_decision(decision(action="long", contracts=1, stop_price=1.0))

    def test_schema_required_matches_properties(self):
        self.assertEqual(set(DECISION_SCHEMA["required"]), set(DECISION_SCHEMA["properties"]))

    def test_user_message_sections(self):
        txt = build_user_message({"price": 1}, None, {"trades": 0}, [{"title": "h"}], [], [], "", {"x": 1})
        for s in ("Market picture", "Headlines", "Open position", "Day so far", "Hard rules"):
            self.assertIn(s, txt)


class JournalUnit(unittest.TestCase):
    def test_day_stats(self):
        j = Journal(tempfile.mkdtemp())
        j.trade_closed({"pnl": -100.0, "side": "long", "qty": 1, "entry": 1, "exit": 0, "reason": "stop"})
        j.trade_closed({"pnl": 250.0, "side": "long", "qty": 1, "entry": 1, "exit": 2, "reason": "target"})
        d = j.state["day"]
        self.assertEqual((d["trades"], d["wins"], d["losses"], d["consecutive_losses"]), (2, 1, 1, 0))
        self.assertEqual(d["realized_pnl"], 150.0)
        j.save()
        j2 = Journal(j.dir)
        self.assertEqual(j2.state["day"]["realized_pnl"], 150.0)

    def test_lessons(self):
        j = Journal(tempfile.mkdtemp())
        j.save_review("2026-10-19", "# r\n\n## What happened\nx\n\n## Lessons\n- Next time wait")
        self.assertIn("Next time wait", j.recent_lessons())


if __name__ == "__main__":
    unittest.main()
