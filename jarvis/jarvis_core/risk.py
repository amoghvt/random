"""Deterministic guardrails. The brain proposes; this layer decides whether the
proposal is allowed to exist. Nothing here calls a model. Every rule is a plain
number from config.json, and every BLOCK carries the reason.

Two layers:
  pre_check(state, now)   - is trading allowed at all right now? (cheap; run before
                            spending a brain call)
  check(decision, state)  - is THIS order within limits?
"""

import os
from datetime import datetime
from zoneinfo import ZoneInfo

from . import features

ENTRY_ACTIONS = ("long", "short")


class Verdict:
    def __init__(self, ok, reasons=None):
        self.ok = ok
        self.reasons = reasons or []

    def __bool__(self):
        return self.ok

    def __repr__(self):
        return "PASS" if self.ok else "BLOCK: " + "; ".join(self.reasons)


def kill_switch_on(cfg):
    return os.path.exists(os.path.join(cfg["_root"], cfg["risk"]["kill_file"]))


def pre_check(cfg, state, now=None):
    """Session-level gates. Returns Verdict. `state` is the journal's day state."""
    r, s = cfg["risk"], cfg["session"]
    tz = ZoneInfo(s["timezone"])
    now_et = datetime.fromtimestamp(now, tz) if now else datetime.now(tz)
    reasons = []
    if kill_switch_on(cfg):
        reasons.append("kill switch file %s present" % r["kill_file"])
    if now_et.strftime("%Y-%m-%d") in (s.get("no_trade_dates") or []):
        reasons.append("no-trade date")
    if now_et.weekday() >= 5:
        reasons.append("weekend")
    if not features.in_window(now_et, s["trade_windows"]):
        reasons.append("outside trade windows %s" % s["trade_windows"])
    label = features.in_blackout(now_et, s.get("event_blackouts"))
    if label:
        reasons.append("event blackout: %s" % label)
    day = state.get("day", {})
    if day.get("realized_pnl", 0.0) <= -abs(r["max_daily_loss_usd"]):
        reasons.append("daily loss limit hit (%.2f)" % day.get("realized_pnl", 0.0))
    if day.get("trades", 0) >= r["max_daily_trades"]:
        reasons.append("daily trade limit reached (%d)" % day.get("trades", 0))
    if day.get("consecutive_losses", 0) >= r["max_consecutive_losses"]:
        reasons.append("max consecutive losses reached (%d)" % day["consecutive_losses"])
    last_loss = day.get("last_loss_ts")
    if last_loss and now_et.timestamp() - last_loss < r["cooldown_minutes_after_loss"] * 60:
        reasons.append("cooling down after a loss")
    return Verdict(not reasons, reasons)


def check(cfg, decision, state, price=None):
    """Order-level gates for an entry decision. Non-entry actions pass through."""
    action = decision.get("action")
    if action not in ENTRY_ACTIONS:
        return Verdict(True)
    r = cfg["risk"]
    tick = cfg["instrument"]["tick_size"]
    reasons = []

    qty = decision.get("contracts", 0)
    if not isinstance(qty, int) or qty < 1:
        reasons.append("contracts must be a positive integer")
    elif qty > r["max_contracts"]:
        reasons.append("contracts %d > max_contracts %d" % (qty, r["max_contracts"]))

    if len(state.get("positions", [])) >= r["max_open_positions"]:
        reasons.append("already at max_open_positions")

    conf = decision.get("confidence", 0)
    if not isinstance(conf, (int, float)) or conf < r["min_confidence"]:
        reasons.append("confidence %s below min_confidence %s" % (conf, r["min_confidence"]))

    entry = decision.get("entry_price") if decision.get("entry_type") == "limit" else price
    stop = decision.get("stop_price")
    target = decision.get("target_price")
    if stop is None:
        reasons.append("no stop_price: every entry needs a stop")
    if entry is None:
        reasons.append("no reference price for the entry")
    if stop is not None and entry is not None:
        risk_pts = (entry - stop) if action == "long" else (stop - entry)
        if risk_pts <= 0:
            reasons.append("stop is on the wrong side of the entry")
        else:
            if risk_pts < r["min_stop_points"]:
                reasons.append("stop %.2f pts is tighter than min_stop_points %s" % (risk_pts, r["min_stop_points"]))
            if risk_pts > r["max_stop_points"]:
                reasons.append("stop %.2f pts is wider than max_stop_points %s" % (risk_pts, r["max_stop_points"]))
            if target is not None:
                reward_pts = (target - entry) if action == "long" else (entry - target)
                if reward_pts <= 0:
                    reasons.append("target is on the wrong side of the entry")
                elif reward_pts / risk_pts < r["min_reward_risk"]:
                    reasons.append("reward:risk %.2f below min_reward_risk %s" % (reward_pts / risk_pts, r["min_reward_risk"]))
            # the worst case for this order must not breach the daily loss limit
            worst = risk_pts * cfg["instrument"]["point_value"] * (qty if isinstance(qty, int) else 1)
            left = abs(r["max_daily_loss_usd"]) + state.get("day", {}).get("realized_pnl", 0.0)
            if worst > left:
                reasons.append("worst case $%.0f exceeds remaining daily loss room $%.0f" % (worst, left))
    for key in ("entry_price", "stop_price", "target_price"):
        v = decision.get(key)
        if v is not None and abs(round(v / tick) * tick - v) > 1e-9:
            reasons.append("%s %.4f is not on the %.2f tick grid" % (key, v, tick))
    return Verdict(not reasons, reasons)
