"""Brokers. The loop talks to one Broker; it never knows which.

PaperBroker     - in-memory simulator with bracket orders, slippage and commission.
                  Fills entries at the next heartbeat price, checks stops and targets
                  against each new bar's high/low (stop wins if both hit).
TradovateBroker - REST adapter for Tradovate (demo by default). Written against
                  Tradovate's documented endpoints but NOT exercised against a live
                  account in this repo: verify every call in a demo account first.
"""

import json
import os
import time
import urllib.error
import urllib.request


class BrokerError(Exception):
    pass


class Position:
    def __init__(self, side, qty, entry, stop, target, opened_ts, meta=None):
        self.side = side          # "long" | "short"
        self.qty = qty
        self.entry = entry
        self.stop = stop
        self.target = target
        self.opened_ts = opened_ts
        self.meta = meta or {}

    @property
    def dir(self):
        return 1 if self.side == "long" else -1

    def unrealized(self, price, point_value):
        return (price - self.entry) * self.dir * self.qty * point_value

    def to_dict(self):
        return {"side": self.side, "qty": self.qty, "entry": self.entry, "stop": self.stop,
                "target": self.target, "opened_ts": self.opened_ts, "meta": self.meta}

    @classmethod
    def from_dict(cls, d):
        return cls(d["side"], d["qty"], d["entry"], d["stop"], d["target"], d["opened_ts"], d.get("meta"))


class Broker:
    name = "base"

    def positions(self):
        raise NotImplementedError

    def enter(self, side, qty, stop, target, price, entry_type="market", limit=None, meta=None):
        raise NotImplementedError

    def close(self, price, reason):
        raise NotImplementedError

    def move_stop(self, new_stop):
        raise NotImplementedError

    def mark(self, bar):
        """Called every heartbeat with the latest bar. Returns a list of closed-trade dicts."""
        return []


class PaperBroker(Broker):
    name = "paper"

    def __init__(self, point_value=20.0, tick=0.25, slippage_ticks=1, commission_per_side=2.25,
                 starting_equity=25000.0, state=None):
        self.point_value = point_value
        self.tick = tick
        self.slip = slippage_ticks * tick
        self.comm = commission_per_side
        self.equity = starting_equity
        self.pos = None
        if state:
            self.equity = state.get("equity", starting_equity)
            self.pos = Position.from_dict(state["position"]) if state.get("position") else None

    def to_state(self):
        return {"equity": self.equity, "position": self.pos.to_dict() if self.pos else None}

    def positions(self):
        return [self.pos] if self.pos else []

    def enter(self, side, qty, stop, target, price, entry_type="market", limit=None, meta=None):
        if self.pos:
            raise BrokerError("paper: already in a position")
        if entry_type == "limit":
            # a limit is only filled if price is already through it
            if (side == "long" and price > limit) or (side == "short" and price < limit):
                return None
            fill = limit
        else:
            fill = price + self.slip if side == "long" else price - self.slip
        self.pos = Position(side, qty, fill, stop, target, time.time(), meta)
        self.equity -= self.comm * qty
        return {"fill": fill, "qty": qty, "side": side}

    def _exit(self, fill, reason, ts=None):
        p = self.pos
        pnl = (fill - p.entry) * p.dir * p.qty * self.point_value - self.comm * p.qty
        self.equity += pnl
        trade = {"side": p.side, "qty": p.qty, "entry": p.entry, "exit": fill, "stop": p.stop,
                 "target": p.target, "pnl": round(pnl, 2), "reason": reason,
                 "opened_ts": p.opened_ts, "closed_ts": ts or time.time(), "meta": p.meta}
        self.pos = None
        return trade

    def close(self, price, reason="manual"):
        if not self.pos:
            return None
        fill = price - self.slip if self.pos.side == "long" else price + self.slip
        return self._exit(fill, reason)

    def move_stop(self, new_stop):
        if not self.pos:
            raise BrokerError("paper: no position")
        self.pos.stop = new_stop
        return new_stop

    def mark(self, bar):
        if not self.pos:
            return []
        p = self.pos
        if p.side == "long":
            stop_hit = p.stop is not None and bar["l"] <= p.stop
            tgt_hit = p.target is not None and bar["h"] >= p.target
        else:
            stop_hit = p.stop is not None and bar["h"] >= p.stop
            tgt_hit = p.target is not None and bar["l"] <= p.target
        if stop_hit:  # conservative: stop first when both touch in one bar
            fill = p.stop - self.slip if p.side == "long" else p.stop + self.slip
            return [self._exit(fill, "stop", bar["t"])]
        if tgt_hit:
            return [self._exit(p.target, "target", bar["t"])]
        return []


class TradovateBroker(Broker):
    """Tradovate REST. Demo: https://demo.tradovateapi.com/v1  Live: https://live.tradovateapi.com/v1

    Auth: POST /auth/accesstokenrequest {name, password, appId, appVersion, cid, sec}
    Orders: POST /order/placeorder, POST /order/placeoso (entry with bracket), /order/liquidateposition
    Reads: GET /account/list, GET /position/list
    """
    name = "tradovate"

    def __init__(self, cfg_tv, symbol, paper=True):
        env = "demo" if paper or cfg_tv.get("env", "demo") == "demo" else "live"
        self.base = "https://%s.tradovateapi.com/v1" % env
        self.symbol = symbol
        self.cfg = cfg_tv
        self.token = None
        self.account_id = cfg_tv.get("account_id")
        self.account_spec = None

    def _creds(self):
        c = self.cfg
        vals = {k: os.environ.get(c.get(k + "_env", ""), "") for k in ("username", "password", "cid", "sec")}
        missing = [k for k, v in vals.items() if not v]
        if missing:
            raise BrokerError("tradovate: missing env vars for %s" % ", ".join(missing))
        return vals

    def _req(self, method, path, body=None):
        if self.token is None and not path.startswith("/auth"):
            self.auth()
        url = self.base + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Content-Type": "application/json", "Accept": "application/json",
            **({"Authorization": "Bearer %s" % self.token} if self.token else {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raise BrokerError("tradovate HTTP %s on %s: %s" % (e.code, path, e.read()[:300]))
        except urllib.error.URLError as e:
            raise BrokerError("tradovate network: %s" % e.reason)
        return json.loads(raw) if raw else {}

    def auth(self):
        c = self._creds()
        out = self._req("POST", "/auth/accesstokenrequest", {
            "name": c["username"], "password": c["password"], "appId": self.cfg.get("app_id", "jarvis"),
            "appVersion": self.cfg.get("app_version", "1.0"), "cid": int(c["cid"]), "sec": c["sec"]})
        if "accessToken" not in out:
            raise BrokerError("tradovate auth failed: %s" % out)
        self.token = out["accessToken"]
        if not self.account_id:
            accts = self._req("GET", "/account/list")
            if not accts:
                raise BrokerError("tradovate: no accounts")
            self.account_id = accts[0]["id"]
            self.account_spec = accts[0]["name"]
        return self.token

    def positions(self):
        out = []
        for p in self._req("GET", "/position/list"):
            if p.get("accountId") != self.account_id or not p.get("netPos"):
                continue
            side = "long" if p["netPos"] > 0 else "short"
            out.append(Position(side, abs(p["netPos"]), p.get("netPrice"), None, None, time.time(),
                                {"contractId": p.get("contractId")}))
        return out

    def enter(self, side, qty, stop, target, price, entry_type="market", limit=None, meta=None):
        action = "Buy" if side == "long" else "Sell"
        exit_action = "Sell" if side == "long" else "Buy"
        entry = {"accountSpec": self.account_spec, "accountId": self.account_id, "action": action,
                 "symbol": self.symbol, "orderQty": qty, "isAutomated": True, "timeInForce": "Day",
                 "orderType": "Limit" if entry_type == "limit" else "Market"}
        if entry_type == "limit":
            entry["price"] = limit
        entry["bracket1"] = {"action": exit_action, "orderType": "Stop", "stopPrice": stop}
        if target is not None:
            entry["bracket2"] = {"action": exit_action, "orderType": "Limit", "price": target}
        out = self._req("POST", "/order/placeoso", entry)
        if out.get("failureReason"):
            raise BrokerError("tradovate rejected: %s %s" % (out.get("failureReason"), out.get("failureText")))
        return {"orderId": out.get("orderId"), "qty": qty, "side": side, "fill": None}

    def close(self, price, reason="manual"):
        closed = []
        for p in self.positions():
            self._req("POST", "/order/liquidateposition", {"accountId": self.account_id,
                      "contractId": p.meta.get("contractId"), "admin": False})
            closed.append({"side": p.side, "qty": p.qty, "reason": reason})
        return closed or None

    def move_stop(self, new_stop):
        raise BrokerError("tradovate: move_stop not implemented; cancel and replace the bracket in the platform")


def make_broker(cfg, state=None):
    b, inst = cfg["broker"], cfg["instrument"]
    if b["kind"] == "paper":
        return PaperBroker(inst["point_value"], inst["tick_size"], b["paper_slippage_ticks"],
                           b["paper_commission_per_side"], b["paper_starting_equity"], state)
    if b["kind"] == "tradovate":
        return TradovateBroker(b.get("tradovate", {}), inst["tradovate_symbol"], paper=cfg["paper"])
    raise BrokerError("unknown broker.kind %r" % b["kind"])
