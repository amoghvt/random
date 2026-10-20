"""One heartbeat = fetch -> picture -> mark position -> (brain) -> risk -> act -> journal.

Modes:
  observe  brain decides, nothing is placed, every decision is logged.
  propose  entries become proposals you approve with `jarvis.py approve <id>`.
  auto     entries that pass risk are placed. Paper by default; live needs the
           explicit config flag.
"""

import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from . import broker as broker_mod
from . import config as config_mod
from . import data as data_mod
from . import features, knowledge, risk
from .brain import Brain, BrainError
from .journal import Journal
from .notify import say


class Jarvis:
    def __init__(self, cfg, brain=None, source=None, broker=None, fetch_news=True, now_fn=None):
        self.cfg = cfg
        self._now_fn = now_fn or time.time
        self.tz = ZoneInfo(cfg["session"]["timezone"])
        self.journal = Journal(config_mod.path(cfg, cfg["state_dir"]), cfg["session"]["timezone"])
        self.broker = broker or broker_mod.make_broker(cfg, self.journal.state.get("broker"))
        self.source = source or data_mod.make_source(cfg)
        self.brain = brain or Brain(cfg["model"], cfg["effort"])
        self.fetch_news = fetch_news
        kdir = config_mod.path(cfg, cfg["knowledge"]["dir"])
        self.kdir = kdir
        self.kindex = knowledge.load_index(kdir)
        self.playbook = knowledge.always_include(kdir, cfg["knowledge"]["always_include"])

    # ---- helpers -----------------------------------------------------------
    def now(self):
        return self._now_fn()

    def now_et(self):
        return datetime.fromtimestamp(self.now(), self.tz)

    def _persist(self):
        if hasattr(self.broker, "to_state"):
            self.journal.state["broker"] = self.broker.to_state()
        self.journal.state["positions"] = [p.to_dict() for p in self.broker.positions()]
        self.journal.save()

    def _rules(self):
        r = dict(self.cfg["risk"])
        r.pop("kill_file", None)
        r["session"] = self.cfg["session"]["trade_windows"]
        r["flatten_at"] = self.cfg["session"]["flatten_at"]
        r["tick_size"] = self.cfg["instrument"]["tick_size"]
        r["point_value"] = self.cfg["instrument"]["point_value"]
        return r

    def _position_view(self, price):
        ps = self.broker.positions()
        if not ps:
            return None
        p = ps[0]
        d = p.to_dict()
        d["unrealized_usd"] = round(p.unrealized(price, self.cfg["instrument"]["point_value"]), 2)
        d["minutes_open"] = round((time.time() - p.opened_ts) / 60, 1)
        return d

    def picture(self):
        bars, meta = self.source.bars()
        pic = features.compute(bars, now=self.now(), tz_name=self.cfg["session"]["timezone"],
                               tick=self.cfg["instrument"]["tick_size"])
        pic["symbol"] = self.cfg["instrument"]["symbol"]
        pic["data_source"] = "%s %s (delayed)" % (self.cfg["data"]["source"], self.cfg["data"]["interval"])
        return bars, pic

    def context(self, pic, price, question=None):
        headlines = []
        if self.fetch_news:
            try:
                headlines = data_mod.headlines(self.cfg["data"]["news_symbols"])
            except Exception as e:
                say("headlines failed: %s" % e, self.cfg, "error")
        query = " ".join(str(x) for x in [pic.get("phase"), pic.get("trend_ema"), "NQ", "level",
                                            "vwap", "opening range", question or ""])
        chunks = knowledge.search(self.kindex, query, k=self.cfg["knowledge"]["top_k"]) if self.kindex else []
        return {
            "picture": pic,
            "position": self._position_view(price),
            "day": self.journal.state["day"],
            "headlines": headlines,
            "knowledge_chunks": chunks,
            "playbook": self.playbook,
            "lessons": self.journal.recent_lessons(),
            "rules": self._rules(),
        }

    # ---- actions -----------------------------------------------------------
    def _execute_entry(self, d, price):
        fill = self.broker.enter(d["action"], d["contracts"], d["stop_price"], d["target_price"], price,
                                 d.get("entry_type", "market"), d.get("entry_price"),
                                 meta={"thesis": d.get("thesis"), "confidence": d.get("confidence")})
        if fill is None:
            say("limit %s not filled yet (price %.2f vs %.2f)" % (d["action"], price, d["entry_price"]), self.cfg)
            return False
        say("ENTERED %s %d @ %s stop %s target %s | %s" % (
            d["action"], d["contracts"], fill.get("fill"), d["stop_price"], d["target_price"],
            d.get("thesis", "")[:160]), self.cfg, "trade")
        return True

    def _execute_manage(self, d, price):
        if d["action"] == "close":
            t = self.broker.close(price, "brain")
            if t:
                self._record_closed(t if isinstance(t, list) else [t])
            return True
        if d["action"] == "move_stop":
            try:
                self.broker.move_stop(d["new_stop"])
                say("stop moved to %s" % d["new_stop"], self.cfg)
                return True
            except broker_mod.BrokerError as e:
                say(str(e), self.cfg, "error")
        return False

    def _record_closed(self, trades):
        for t in trades:
            if "pnl" in t:
                self.journal.trade_closed(t)
                say("CLOSED %s %d entry %.2f exit %.2f pnl $%.2f (%s) | day $%.2f" % (
                    t["side"], t["qty"], t["entry"], t["exit"], t["pnl"], t["reason"],
                    self.journal.state["day"]["realized_pnl"]), self.cfg, "trade")
            else:
                say("CLOSED %s" % t, self.cfg, "trade")

    def flatten(self, reason="flatten"):
        bars, pic = self.picture()
        t = self.broker.close(pic["price"], reason)
        if t:
            self._record_closed(t if isinstance(t, list) else [t])
        self._persist()
        return t

    def approve(self, pid):
        row = self.journal.state["pending"].get(pid)
        if not row:
            return "no pending proposal %s" % pid
        bars, pic = self.picture()
        price = pic["price"]
        d = row["decision"]
        moved = abs(price - row["price"])
        if moved > self.cfg["instrument"]["tick_size"] * 40:
            self.journal.resolve_proposal(pid, "rejected_price_moved")
            self._persist()
            return "price moved %.2f pts since the proposal; rejected, ask for a fresh one" % moved
        v = risk.pre_check(self.cfg, self.journal.state, now=self.now()) and risk.check(self.cfg, d, self.journal.state, price)
        if not v:
            self.journal.resolve_proposal(pid, "blocked")
            self._persist()
            return "blocked on re-check: %r" % v
        ok = self._execute_entry(d, price)
        self.journal.resolve_proposal(pid, "executed" if ok else "unfilled")
        self._persist()
        return "executed" if ok else "not filled"

    # ---- the heartbeat -----------------------------------------------------
    def tick(self, force_brain=False):
        cfg = self.cfg
        mode = cfg["mode"]
        self.journal.expire_proposals()
        now_et = self.now_et()

        if risk.kill_switch_on(cfg):
            if self.broker.positions():
                say("kill switch: flattening", cfg, "alert")
                self.flatten("kill_switch")
            self._persist()
            return {"skipped": "kill switch"}

        try:
            bars, pic = self.picture()
        except data_mod.DataError as e:
            say("data: %s" % e, cfg, "error")
            return {"skipped": "data error: %s" % e}
        price = pic["price"]

        # 1. mark the open position against the latest bar (stops/targets)
        closed = self.broker.mark(bars[-1])
        if closed:
            self._record_closed(closed)

        # 2. scheduled flatten
        fh, fm = map(int, cfg["session"]["flatten_at"].split(":"))
        if (now_et.hour, now_et.minute) >= (fh, fm) and self.broker.positions():
            say("flatten_at reached", cfg, "alert")
            t = self.broker.close(price, "flatten_at")
            if t:
                self._record_closed(t if isinstance(t, list) else [t])
            self._persist()
            return {"flattened": True}

        in_position = bool(self.broker.positions())
        pre = risk.pre_check(cfg, self.journal.state, now=self.now())
        if not in_position and not pre and not force_brain:
            self._persist()
            return {"skipped": repr(pre), "price": price, "phase": pic["phase"]}
        if pic.get("stale_minutes", 0) > 30 and not force_brain:
            self._persist()
            return {"skipped": "data stale %.0f min" % pic["stale_minutes"], "price": price}

        # 3. ask the brain
        ctx = self.context(pic, price)
        try:
            d = self.brain.decide(**ctx)
        except BrainError as e:
            say("brain: %s" % e, cfg, "error")
            self._persist()
            return {"error": str(e)}

        # 4. risk, then act by mode
        executed = False
        verdict = risk.Verdict(True)
        if d["action"] in ("long", "short"):
            if in_position:
                verdict = risk.Verdict(False, ["already in a position; entries are one at a time"])
            else:
                verdict = pre if not pre else risk.check(cfg, d, self.journal.state, price)
            if verdict:
                if mode == "observe":
                    say("OBSERVE would %s %d stop %s target %s conf %.2f | %s" % (
                        d["action"], d["contracts"], d["stop_price"], d["target_price"],
                        d["confidence"], d["thesis"][:160]), cfg, "alert")
                elif mode == "propose":
                    pid = self.journal.propose(d, price)
                    say("PROPOSAL %s: %s %d @ %s stop %s target %s conf %.2f\n   thesis: %s\n   invalidation: %s\n   approve with: python3 jarvis.py approve %s" % (
                        pid, d["action"], d["contracts"], d.get("entry_price") or "market", d["stop_price"],
                        d["target_price"], d["confidence"], d["thesis"], d["invalidation"], pid), cfg, "alert")
                elif mode == "auto":
                    executed = self._execute_entry(d, price)
            else:
                say("brain wanted %s, %r" % (d["action"], verdict), cfg)
        elif d["action"] in ("close", "move_stop") and in_position:
            if mode == "observe":
                say("OBSERVE would %s %s" % (d["action"], d.get("new_stop") or ""), cfg, "alert")
            else:  # managing an existing position is allowed in propose mode too
                executed = self._execute_manage(d, price)
        else:
            say("%s | %s | conf %.2f | %s" % (d["action"], pic["phase"], d["confidence"], d["thesis"][:140]), cfg)

        summary = {"price": price, "phase": pic["phase"], "trend": pic["trend_ema"],
                   "position": bool(in_position), "fp": d.get("_context_fp")}
        self.journal.decision(d, summary, verdict, mode, executed)
        self._persist()
        return {"decision": d, "verdict": repr(verdict), "executed": executed, "price": price}

    def run(self, every=None, max_ticks=None):
        every = every or self.cfg["heartbeat_seconds"]
        say("Jarvis running: mode=%s broker=%s paper=%s every %ss. Ctrl-C to stop; touch %s to kill." % (
            self.cfg["mode"], self.broker.name, self.cfg["paper"], every, self.cfg["risk"]["kill_file"]), self.cfg)
        n = 0
        while True:
            try:
                out = self.tick()
                if out.get("skipped"):
                    say("skip: %s" % out["skipped"], self.cfg)
            except KeyboardInterrupt:
                say("stopped by user", self.cfg)
                break
            except Exception as e:  # keep the loop alive, log loudly
                say("tick crashed: %r" % e, self.cfg, "error")
            n += 1
            if max_ticks and n >= max_ticks:
                break
            time.sleep(every)
