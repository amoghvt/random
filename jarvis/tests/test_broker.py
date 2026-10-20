import unittest

from _fx import cfg_for
import tempfile
from jarvis_core.broker import PaperBroker, BrokerError, make_broker


class Paper(unittest.TestCase):
    def setUp(self):
        self.b = PaperBroker(point_value=20.0, tick=0.25, slippage_ticks=1, commission_per_side=2.0, starting_equity=10000)

    def test_market_long_fill_with_slippage(self):
        f = self.b.enter("long", 1, 24790.0, 24840.0, price=24810.0)
        self.assertEqual(f["fill"], 24810.25)
        self.assertEqual(self.b.equity, 9998.0)

    def test_stop_hit_long(self):
        self.b.enter("long", 1, 24790.0, 24840.0, price=24810.0)
        closed = self.b.mark({"t": 1, "o": 24805, "h": 24808, "l": 24789.0, "c": 24795, "v": 1})
        self.assertEqual(len(closed), 1)
        t = closed[0]
        self.assertEqual(t["reason"], "stop")
        self.assertEqual(t["exit"], 24789.75)
        # (24789.75 - 24810.25) * 20 - 2 = -412
        self.assertAlmostEqual(t["pnl"], -412.0)
        self.assertIsNone(self.b.pos)

    def test_target_hit_short(self):
        self.b.enter("short", 2, 24830.0, 24770.0, price=24810.0)
        closed = self.b.mark({"t": 1, "o": 24800, "h": 24805, "l": 24769.0, "c": 24775, "v": 1})
        self.assertEqual(closed[0]["reason"], "target")
        # entry 24809.75, exit 24770 -> 39.75 * 2 * 20 - 4 = 1586
        self.assertAlmostEqual(closed[0]["pnl"], 1586.0)

    def test_both_hit_stop_wins(self):
        self.b.enter("long", 1, 24790.0, 24840.0, price=24810.0)
        closed = self.b.mark({"t": 1, "o": 24800, "h": 24850, "l": 24780, "c": 24820, "v": 1})
        self.assertEqual(closed[0]["reason"], "stop")

    def test_limit_not_filled_until_through(self):
        self.assertIsNone(self.b.enter("long", 1, 24780.0, 24840.0, price=24810.0, entry_type="limit", limit=24800.0))
        self.assertIsNone(self.b.pos)
        f = self.b.enter("long", 1, 24780.0, 24840.0, price=24799.0, entry_type="limit", limit=24800.0)
        self.assertEqual(f["fill"], 24800.0)

    def test_double_entry_raises(self):
        self.b.enter("long", 1, 24790.0, 24840.0, price=24810.0)
        with self.assertRaises(BrokerError):
            self.b.enter("short", 1, 24830.0, 24770.0, price=24810.0)

    def test_close_and_move_stop(self):
        self.b.enter("long", 1, 24790.0, 24840.0, price=24810.0)
        self.b.move_stop(24805.0)
        self.assertEqual(self.b.pos.stop, 24805.0)
        t = self.b.close(24820.0, "manual")
        self.assertEqual(t["exit"], 24819.75)
        self.assertEqual(t["reason"], "manual")

    def test_state_roundtrip(self):
        self.b.enter("long", 1, 24790.0, 24840.0, price=24810.0)
        st = self.b.to_state()
        b2 = PaperBroker(state=st)
        self.assertEqual(b2.pos.entry, 24810.25)
        self.assertEqual(b2.equity, self.b.equity)

    def test_make_broker_paper(self):
        cfg = cfg_for(tempfile.mkdtemp())
        self.assertEqual(make_broker(cfg).name, "paper")


if __name__ == "__main__":
    unittest.main()
