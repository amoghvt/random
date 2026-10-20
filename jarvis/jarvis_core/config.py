"""Load and validate config.json. Paths are resolved relative to the jarvis folder."""

import copy
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULTS = {
    "instrument": {"symbol": "NQ", "yahoo_symbol": "NQ=F", "tradovate_symbol": "NQZ6",
                   "tick_size": 0.25, "point_value": 20.0},
    "mode": "propose",
    "paper": True,
    "i_accept_live_autonomous_risk": False,
    "heartbeat_seconds": 60,
    "model": "claude-opus-5-5",
    "effort": "high",
    "data": {"source": "yahoo", "interval": "5m", "lookback_days": 5,
             "news_symbols": ["NQ=F", "^NDX", "QQQ"]},
    "broker": {"kind": "paper", "paper_starting_equity": 25000, "paper_slippage_ticks": 1,
               "paper_commission_per_side": 2.25, "tradovate": {}},
    "risk": {"max_contracts": 1, "max_daily_loss_usd": 500, "max_daily_trades": 4,
             "max_consecutive_losses": 2, "cooldown_minutes_after_loss": 15,
             "min_stop_points": 5, "max_stop_points": 40, "min_reward_risk": 1.5,
             "max_open_positions": 1, "min_confidence": 0.6, "kill_file": "STOP"},
    "session": {"timezone": "America/New_York",
                "trade_windows": [["09:35", "11:30"], ["13:30", "15:45"]],
                "flatten_at": "15:55", "no_trade_dates": [], "event_blackouts": []},
    "knowledge": {"dir": "knowledge", "top_k": 6, "always_include": ["playbook.md"]},
    "notify": {"webhook_url_env": "JARVIS_WEBHOOK_URL"},
    "state_dir": "state",
}

MODES = ("observe", "propose", "auto")


class ConfigError(Exception):
    pass


def _merge(base, override):
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load(path=None):
    """Return the merged config dict. Missing file -> defaults (paper, propose)."""
    path = path or os.path.join(HERE, "config.json")
    user = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            user = json.load(fh)
    cfg = _merge(DEFAULTS, user)
    cfg["_path"] = path
    cfg["_root"] = HERE
    validate(cfg)
    return cfg


def validate(cfg):
    if cfg["mode"] not in MODES:
        raise ConfigError("mode must be one of %s" % (MODES,))
    if cfg["broker"]["kind"] not in ("paper", "tradovate"):
        raise ConfigError("broker.kind must be 'paper' or 'tradovate'")
    live = cfg["broker"]["kind"] != "paper" and not cfg["paper"]
    if cfg["mode"] == "auto" and live and not cfg["i_accept_live_autonomous_risk"]:
        raise ConfigError(
            "mode 'auto' on a live account needs \"i_accept_live_autonomous_risk\": true. "
            "Run paper first. Autonomous live trading can lose money without you watching."
        )
    r = cfg["risk"]
    for key in ("max_contracts", "max_daily_loss_usd", "max_daily_trades"):
        if r[key] <= 0:
            raise ConfigError("risk.%s must be positive" % key)
    if r["min_stop_points"] >= r["max_stop_points"]:
        raise ConfigError("risk.min_stop_points must be below max_stop_points")
    if cfg["instrument"]["tick_size"] <= 0 or cfg["instrument"]["point_value"] <= 0:
        raise ConfigError("instrument tick_size and point_value must be positive")


def path(cfg, *parts):
    """Resolve a path under the jarvis root."""
    return os.path.join(cfg["_root"], *parts)


def is_live(cfg):
    return cfg["broker"]["kind"] != "paper" and not cfg["paper"]
