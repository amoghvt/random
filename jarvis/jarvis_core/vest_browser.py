"""Vest Markets through the browser: the order form is driven with Playwright in a Chrome profile you logged in to.

Why a browser: Vest has no API for funded accounts. Its Prop Terms (section 9) treat bots, scripts and browser
extensions as "Third-Party Tools" used at your own risk: Vest does not support them, is not liable for a failed or
unintended trade, and a tool never excuses a rule breach. This adapter is such a tool.

What was verified and what was not (2026-11-27):
  - VERIFIED against the public page next.vestmarkets.com/trade/NDX-USD-PERP: every order-form selector below
    (data-testid values), the TP/SL fields, the reduce-only checkbox, the halted/closed notices, the price read-outs.
  - NOT VERIFIED (needs a logged-in account, which this code was written without): the confirmation dialog after
    submit, the row layout of the positions table, how the reduce-only close sizes itself, the account switcher.
    Those paths are written defensively and stop with an error when the page does not look as expected.
    Run `python3 jarvis.py vest-check` and one tiny manual-size trade with submit_orders on before trusting it.

Safety properties:
  - every entry carries a stop-loss (and target) on the exchange at submit time, so the stop does not depend on this
    process staying alive;
  - `submit_orders` is false by default: the form is filled, checked and screenshotted, and nothing is clicked;
  - the order value shown by the page must match the intended notional within 2% or the order is abandoned;
  - a position on the page that this process did not open blocks all new entries.
"""
import os
import re
import time

from .broker import Broker, BrokerError, Position
from .data import DataError

SEL = {
    "form": '[data-testid="order-form"]', "market_tab": '[data-testid="ordertype-tab-market"]',
    "size": '[data-testid="size-input"]', "unit": '[data-testid="size-unit-select"]',
    "tpsl_toggle": '[data-testid="tpsl-toggle"]', "tpsl_price": '[data-testid="tpsl-unit-price"]',
    "tp": '[data-testid="tpsl-input-tp"]', "sl": '[data-testid="tpsl-input-sl"]',
    "reduce_only": '[data-testid="reduce-only-checkbox"]', "pct100": '[data-testid="size-pct-100"]',
    "long": '[data-testid="submit-long"]', "short": '[data-testid="submit-short"]',
    "mid": '[data-testid="market-midPrice"]', "index": '[data-testid="market-indexPrice"]',
    "positions_tab": '[data-testid="account-tab-active-positions"]', "account_tabs": '[data-testid="trade-account-tabs"]',
    "power": '[data-testid="trading-power"]', "account_value": '[data-testid="account-value"]',
}
BLOCK_NOTICES = ("Trading Halted", "This market is closed", "temporarily halted")


class DryRun(BrokerError):
    """Raised instead of submitting when submit_orders is off."""


def money(text):
    """'$26,756.75' -> 26756.75; None when there is no number."""
    m = re.search(r"-?\d[\d,]*\.?\d*", (text or "").replace("−", "-"))
    return float(m.group(0).replace(",", "")) if m else None


def notional_usd(qty, price):
    return round(qty * price, 2)


def order_value_ok(shown, intended, tolerance=0.02):
    return shown is not None and intended > 0 and abs(shown - intended) / intended <= tolerance


def estimate_exit(pos, price):
    """The exchange closed the position (stop or target). Which one is not on the page we read, so it is inferred
    from where price is now: nearer the stop means the stop."""
    if pos.target is None or pos.stop is None:
        return (pos.stop if pos.stop is not None else price), "stop"
    return (pos.stop, "stop") if abs(price - pos.stop) <= abs(price - pos.target) else (pos.target, "target")


class VestSession:
    """One browser page on one Vest market, shared by the broker and the price feed."""

    def __init__(self, cfg_v, state_dir, page=None):
        self.cfg = cfg_v
        self.state_dir = state_dir
        self.market = cfg_v.get("market", "NQ-PERP")
        self.label = cfg_v.get("position_label", "NQ")
        self.url = cfg_v.get("base_url", "https://next.vestmarkets.com").rstrip("/") + "/trade/" + self.market
        self._page = page
        self._opened = page is not None
        self._pw = None
        self._ctx = None

    @property
    def page(self):
        if self._page is None:
            try:
                from playwright.sync_api import sync_playwright
            except ImportError:
                raise BrokerError("vest_browser needs Playwright: pip install playwright && playwright install chromium")
            self._pw = sync_playwright().start()
            profile = self.cfg.get("user_data_dir") or os.path.join(self.state_dir, "vest-profile")
            opts = {"headless": bool(self.cfg.get("headless", False)), "viewport": {"width": 1440, "height": 900}}
            if self.cfg.get("channel"):
                opts["channel"] = self.cfg["channel"]
            if self.cfg.get("executable_path"):
                opts["executable_path"] = self.cfg["executable_path"]
            self._ctx = self._pw.chromium.launch_persistent_context(profile, **opts)
            self._page = self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()
        # Vest redirects market aliases (NDX-USD-PERP -> NQ-PERP), so "are we on the market" is tracked, not compared.
        if not self._opened or not self._page.query_selector(SEL["form"]):
            self._opened = True
            self._page.goto(self.url, wait_until="domcontentloaded", timeout=60000)
            self._page.wait_for_selector(SEL["form"], timeout=60000)
            self._page.wait_for_timeout(1500)
        return self._page

    def close(self):
        if self._ctx:
            self._ctx.close()
        if self._pw:
            self._pw.stop()

    def text(self, sel):
        el = self.page.query_selector(sel)
        return el.inner_text() if el else None

    def mid(self):
        v = money(self.text(SEL["mid"]))
        if v is None:
            raise BrokerError("vest: no mid price on the page")
        return v

    def form_text(self):
        return self.text(SEL["form"]) or ""

    def blocked(self):
        t = self.form_text() + " " + (self.page.inner_text("body")[:400])
        return next((n for n in BLOCK_NOTICES if n in t), None)

    def logged_in(self):
        return self.page.get_by_role("button", name="Log In").count() == 0

    def position_text(self):
        """Text of the active-positions panel rows that mention this market, or None when flat."""
        p = self.page
        tab = p.query_selector(SEL["positions_tab"])
        if tab:
            tab.click()
            p.wait_for_timeout(300)
        panel = p.query_selector(SEL["account_tabs"])
        scope = panel.evaluate_handle("el => el.parentElement").as_element() if panel else None
        body = (scope.inner_text() if scope else p.inner_text("body")) or ""
        if "No positions yet" in body:
            return None
        rows = [ln for ln in body.split("\n") if re.search(r"\b%s\b" % re.escape(self.label), ln)]
        cells = p.query_selector_all("tr, [role=row]")
        for c in cells:
            t = c.inner_text()
            if re.search(r"\b%s\b" % re.escape(self.label), t) and not t.strip().startswith("Market"):
                return t.replace("\n", " | ")
        return " | ".join(rows) if rows else None

    def screenshot(self, name):
        path = os.path.join(self.state_dir, "%s-%s.png" % (name, time.strftime("%Y%m%d-%H%M%S")))
        os.makedirs(self.state_dir, exist_ok=True)
        self.page.screenshot(path=path)
        return path


class VestBrowserBroker(Broker):
    name = "vest_browser"

    def __init__(self, session, point_value=1.0, state=None, submit_orders=False, max_notional_usd=None):
        self.s = session
        self.point_value = point_value
        self.submit = bool(submit_orders)
        self.max_notional = max_notional_usd
        self.pos = Position.from_dict(state["position"]) if state and state.get("position") else None

    def to_state(self):
        return {"position": self.pos.to_dict() if self.pos else None}

    # ---- reads ----
    def positions(self):
        on_page = self.s.position_text()
        if self.pos and on_page:
            return [self.pos]
        if on_page and not self.pos:
            # opened by hand or by another tool: occupy the slot so no entry is placed on top of it
            side = "short" if re.search(r"short|sell|-\$?\d", on_page, re.I) and not re.search(r"\blong\b", on_page, re.I) else "long"
            return [Position(side, 0, self.s.mid(), None, None, time.time(), {"external": True, "row": on_page[:200]})]
        return [self.pos] if self.pos else []  # page says flat: mark() reconciles on the next heartbeat

    # ---- writes ----
    def _set_check(self, sel, want):
        el = self.s.page.query_selector(sel)
        if not el:
            raise BrokerError("vest: %s not found" % sel)
        on = (el.get_attribute("aria-checked") == "true") or (el.get_attribute("data-state") == "checked")
        if on != want:
            if el.is_disabled():
                raise BrokerError("vest: %s is disabled" % sel)
            el.click()
            self.s.page.wait_for_timeout(250)

    def _fill(self, sel, value):
        el = self.s.page.wait_for_selector(sel, timeout=5000)
        el.click()
        el.fill("")
        el.type(("%.2f" % value).rstrip("0").rstrip("."), delay=15)

    def _order_value(self):
        m = re.search(r"Order Value\s*\$?\s*([\d,]+\.?\d*)", self.s.form_text().replace("\n", " "))
        return float(m.group(1).replace(",", "")) if m else None

    def _prepare(self, usd):
        p = self.s.page
        why = self.s.blocked()
        if why:
            raise BrokerError("vest: cannot trade now: %s" % why)
        if not self.s.logged_in():
            raise BrokerError("vest: not logged in in this browser profile")
        p.click(SEL["market_tab"])
        unit = self.s.text(SEL["unit"]) or ""
        if "USD" not in unit:
            raise BrokerError("vest: size unit is %r, expected USD; set it to USD in the form" % unit.strip())
        self._fill(SEL["size"], usd)
        p.wait_for_timeout(400)

    def enter(self, side, qty, stop, target, price, entry_type="market", limit=None, meta=None):
        if entry_type != "market":
            raise BrokerError("vest_browser places market entries only")
        if stop is None:
            raise BrokerError("vest_browser refuses an entry without a stop")
        if self.pos or self.s.position_text():
            raise BrokerError("vest: a position is already open")
        mid = self.s.mid()
        usd = notional_usd(qty, mid)
        if self.max_notional and usd > self.max_notional:
            raise BrokerError("vest: order of $%.0f is above max_notional_usd $%.0f" % (usd, self.max_notional))
        if (side == "long" and not stop < mid) or (side == "short" and not stop > mid):
            raise BrokerError("vest: stop %.2f is on the wrong side of the price %.2f" % (stop, mid))
        self._prepare(usd)
        self._set_check(SEL["tpsl_toggle"], True)
        self.s.page.click(SEL["tpsl_price"])
        self._fill(SEL["sl"], stop)
        if target is not None:
            self._fill(SEL["tp"], target)
        self.s.page.wait_for_timeout(400)
        shown = self._order_value()
        if not order_value_ok(shown, usd):
            raise BrokerError("vest: the page shows order value %s for an intended $%.2f; not submitting" % (shown, usd))
        btn = self.s.page.query_selector(SEL[side])
        if not btn or btn.is_disabled():
            raise BrokerError("vest: the %s button is disabled (balance, market state or a form error): %s" % (side, self.s.form_text().replace("\n", " ")[-200:]))
        if not self.submit:
            shot = self.s.screenshot("vest-dryrun")
            raise DryRun("DRY RUN: %s $%.2f (%s units) stop %.2f target %s filled and checked, not submitted. Screenshot: %s"
                         % (side, usd, qty, stop, target, shot))
        btn.click()
        self._confirm_dialog()
        deadline = time.time() + 15
        while time.time() < deadline and not self.s.position_text():
            self.s.page.wait_for_timeout(500)
        if not self.s.position_text():
            shot = self.s.screenshot("vest-submit-unconfirmed")
            raise BrokerError("vest: order submitted but no position is visible after 15s. CHECK THE PLATFORM. Screenshot: %s" % shot)
        self.pos = Position(side, qty, mid, stop, target, time.time(), dict(meta or {}, entry_is_mid_estimate=True))
        return {"fill": mid, "qty": qty, "side": side, "estimated": True}

    def _confirm_dialog(self):
        """Some venues ask for a confirmation; click it when one appears, otherwise carry on."""
        p = self.s.page
        p.wait_for_timeout(600)
        dlg = p.query_selector('[role="dialog"], [role="alertdialog"]')
        if not dlg:
            return
        for b in dlg.query_selector_all("button"):
            if re.search(r"confirm|place|submit|yes", b.inner_text() or "", re.I) and not b.is_disabled():
                b.click()
                p.wait_for_timeout(600)
                return
        raise BrokerError("vest: a dialog appeared that this adapter does not recognise: %s" % (dlg.inner_text() or "")[:200])

    def close(self, price, reason="manual"):
        row = self.s.position_text()
        if not row:
            return self._reconcile(price) or None
        if not self.pos:
            raise BrokerError("vest: the open position was not opened by Jarvis; close it yourself")
        p = self.pos
        mid = self.s.mid()
        self._prepare(notional_usd(p.qty, mid))
        self._set_check(SEL["tpsl_toggle"], False)
        self._set_check(SEL["reduce_only"], True)
        side = "short" if p.side == "long" else "long"
        btn = self.s.page.query_selector(SEL[side])
        if not btn or btn.is_disabled():
            raise BrokerError("vest: cannot close, the %s button is disabled" % side)
        if not self.submit:
            raise DryRun("DRY RUN: reduce-only %s to close filled, not submitted. Screenshot: %s" % (side, self.s.screenshot("vest-dryrun-close")))
        btn.click()
        self._confirm_dialog()
        deadline = time.time() + 15
        while time.time() < deadline and self.s.position_text():
            self.s.page.wait_for_timeout(500)
        if self.s.position_text():
            shot = self.s.screenshot("vest-close-unconfirmed")
            raise BrokerError("vest: close submitted but a position is still visible. CHECK THE PLATFORM. Screenshot: %s" % shot)
        return self._book(mid, reason)

    def move_stop(self, new_stop):
        raise BrokerError("vest_browser cannot edit the stop yet (the TP/SL edit screen needs a logged-in session to map); close instead")

    def _book(self, exit_px, reason):
        p = self.pos
        pnl = (exit_px - p.entry) * p.dir * p.qty * self.point_value
        self.pos = None
        return {"side": p.side, "qty": p.qty, "entry": p.entry, "exit": exit_px, "stop": p.stop, "target": p.target,
                "pnl": round(pnl, 2), "reason": reason, "opened_ts": p.opened_ts, "closed_ts": time.time(),
                "meta": dict(p.meta, exit_is_estimate=True)}

    def _reconcile(self, price):
        """The page is flat but a position is on the books: the exchange closed it (stop, target or liquidation)."""
        if not self.pos:
            return None
        self.s.page.wait_for_timeout(1500)
        if self.s.position_text():
            return None
        px, why = estimate_exit(self.pos, price)
        return self._book(px, why + " (closed by the exchange, exit estimated)")

    def mark(self, bar):
        if not self.pos or self.s.position_text():
            return []
        t = self._reconcile(bar["c"])
        return [t] if t else []


class VestPageData:
    """Live 1-minute bars built by sampling the page's mid price, on top of a delayed backfill for indicator warm-up.

    The backfill (Yahoo, delayed) is shifted by the difference between its last close and the live mid when the feed
    starts, so levels line up with the venue's price. Bars made here are real-time; backfilled bars are marked."""

    def __init__(self, session, backfill=None, interval_sec=60):
        self.s = session
        self.backfill = backfill
        self.step = interval_sec
        self.live = []
        self.base = None
        self.meta = {}

    def sample(self, now=None):
        now = now or time.time()
        px = self.s.mid()
        t = int(now // self.step) * self.step
        if self.live and self.live[-1]["t"] == t:
            b = self.live[-1]
            b["h"], b["l"], b["c"] = max(b["h"], px), min(b["l"], px), px
        else:
            self.live.append({"t": t, "o": px, "h": px, "l": px, "c": px, "v": 0})
        return px

    def bars(self):
        try:
            px = self.sample()
        except BrokerError as e:
            raise DataError(str(e))
        if self.base is None:
            self.base = []
            if self.backfill is not None:
                try:
                    old, self.meta = self.backfill.bars()
                    shift = px - old[-1]["c"]
                    first = self.live[0]["t"]
                    self.base = [dict(b, o=b["o"] + shift, h=b["h"] + shift, l=b["l"] + shift, c=b["c"] + shift, backfill=True)
                                 for b in old if b["t"] < first]
                except DataError:
                    self.base = []
        return self.base + self.live, dict(self.meta, source="vest_page", live_bars=len(self.live))


_SESSIONS = {}


def session_for(cfg):
    v = cfg["broker"].get("vest_browser", {})
    key = (v.get("market", "NQ-PERP"), v.get("user_data_dir"))
    if key not in _SESSIONS:
        _SESSIONS[key] = VestSession(v, os.path.join(cfg["_root"], "state"))
    return _SESSIONS[key]
