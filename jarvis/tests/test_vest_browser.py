"""The Vest browser adapter against a local replica of the order form (same data-testid values as the real page)."""
import os
import tempfile
import unittest

from jarvis_core import vest_browser as vb
from jarvis_core.broker import BrokerError, Position

FIXTURE = "file://" + os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "vest_form.html")

try:
    from playwright.sync_api import sync_playwright
    HAVE_PW = True
except ImportError:
    HAVE_PW = False


class Pure(unittest.TestCase):
    def test_money(self):
        self.assertEqual(vb.money("$26,756.75"), 26756.75)
        self.assertEqual(vb.money("Order Value $1,234"), 1234.0)
        self.assertIsNone(vb.money("N/A"))

    def test_order_value_check(self):
        self.assertTrue(vb.order_value_ok(26700.0, 26756.75))
        self.assertFalse(vb.order_value_ok(535135.0, 26756.75))  # the page multiplied by leverage: do not submit
        self.assertFalse(vb.order_value_ok(None, 100.0))

    def test_exit_estimate(self):
        p = Position("long", 1, 100.0, 90.0, 130.0, 0)
        self.assertEqual(vb.estimate_exit(p, 91.0), (90.0, "stop"))
        self.assertEqual(vb.estimate_exit(p, 128.0), (130.0, "target"))


class Sess(vb.VestSession):
    """A session pinned to the fixture page."""

    def __init__(self, page, tmp):
        super().__init__({"market": "X"}, tmp, page=page)
        self.url = page.url.split("?")[0]


@unittest.skipUnless(HAVE_PW, "playwright not installed")
class Form(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        try:
            exe = os.environ.get("JARVIS_TEST_CHROMIUM")
            cls.browser = cls.pw.chromium.launch(**({"executable_path": exe} if exe else {}))
        except Exception as e:  # no browser binary for this Playwright build
            cls.pw.stop()
            raise unittest.SkipTest("chromium could not start: %s" % str(e)[:120])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, query="", submit=True, max_notional=1_000_000):
        page = self.browser.new_page()
        page.goto(FIXTURE + query)
        self.page = page
        return vb.VestBrowserBroker(Sess(page, tempfile.mkdtemp()), 1.0, None, submit_orders=submit, max_notional_usd=max_notional)

    def tearDown(self):
        self.page.close()

    def test_dry_run_fills_but_does_not_submit(self):
        b = self.open(submit=False)
        with self.assertRaises(vb.DryRun):
            b.enter("long", 2, 26700.0, 26900.0, 26756.75)
        self.assertEqual(self.page.evaluate("window.orders.length"), 0)
        self.assertEqual(self.page.input_value(vb.SEL["sl"]), "26700")
        self.assertEqual(b.positions(), [])

    def test_entry_carries_stop_and_target_then_close_is_reduce_only(self):
        b = self.open()
        fill = b.enter("short", 2, 26800.0, 26600.0, 26756.75)
        o = self.page.evaluate("window.orders[0]")
        self.assertEqual((o["side"], o["usd"], o["sl"], o["tp"], o["tpsl"], o["reduceOnly"]), ("short", 53513.5, "26800", "26600", True, False))
        self.assertEqual(fill["side"], "short")
        self.assertEqual(len(b.positions()), 1)
        t = b.close(26700.0, "brain")
        c = self.page.evaluate("window.orders[1]")
        self.assertEqual((c["side"], c["reduceOnly"], c["tpsl"]), ("long", True, False))
        self.assertEqual(t["reason"], "brain")
        self.assertEqual(b.positions(), [])

    def test_exchange_side_close_is_booked_on_the_next_mark(self):
        b = self.open()
        b.enter("long", 1, 26700.0, 26900.0, 26756.75)
        self.page.evaluate("window.exchangeClose()")
        closed = b.mark({"t": 0, "o": 26705, "h": 26710, "l": 26690, "c": 26702})
        self.assertEqual(len(closed), 1)
        self.assertIn("stop", closed[0]["reason"])
        self.assertAlmostEqual(closed[0]["pnl"], 26700.0 - 26756.75, places=2)

    def test_refusals(self):
        b = self.open()
        with self.assertRaises(BrokerError):
            b.enter("long", 1, None, 26900.0, 26756.75)                # no stop
        with self.assertRaises(BrokerError):
            b.enter("long", 1, 26800.0, 26900.0, 26756.75)             # stop on the wrong side
        self.assertEqual(self.page.evaluate("window.orders.length"), 0)
        for query, cap in (("", 1000), ("?halted=1", 1_000_000), ("?loggedout=1", 1_000_000), ("?scale=50", 1_000_000)):
            self.page.close()
            b = self.open(query, max_notional=cap)   # dollar cap, halted market, logged out, page shows 50x the value
            with self.assertRaises(BrokerError):
                b.enter("long", 1, 26700.0, None, 26756.75)
            self.assertEqual(self.page.evaluate("window.orders.length"), 0)

    def test_a_position_opened_by_hand_blocks_entries(self):
        b = self.open()
        self.page.evaluate("document.getElementById('rows').innerHTML='<tr><td>NQ</td><td>long $500</td></tr>';document.getElementById('empty').style.display='none'")
        self.assertTrue(b.positions()[0].meta["external"])
        with self.assertRaises(BrokerError):
            b.enter("long", 1, 26700.0, None, 26756.75)

    def test_live_bars_from_the_page(self):
        b = self.open()
        feed = vb.VestPageData(b.s, None)
        feed.sample(now=600.0)
        self.page.evaluate("document.querySelector('[data-testid=\"market-midPrice\"]').textContent='$26,760.00'")
        feed.sample(now=630.0)
        feed.sample(now=660.0)
        self.assertEqual([(x["t"], x["o"], x["h"], x["c"]) for x in feed.live], [(600, 26756.75, 26760.0, 26760.0), (660, 26760.0, 26760.0, 26760.0)])


if __name__ == "__main__":
    unittest.main()
