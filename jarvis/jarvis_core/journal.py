"""Everything Jarvis does is written down. state/ holds:

  state.json        current day stats, broker state, open proposals
  decisions.jsonl   every brain decision with the context hash
  trades.jsonl      every closed trade
  proposals.jsonl   orders waiting for your yes (propose mode)
  reviews/DATE.md   end-of-day reviews; their lessons feed the next day's brain
"""

import json
import os
import time
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo


class Journal:
    def __init__(self, state_dir, tz_name="America/New_York"):
        self.dir = state_dir
        self.tz = ZoneInfo(tz_name)
        os.makedirs(os.path.join(self.dir, "reviews"), exist_ok=True)
        self.state = self._load_state()

    # ---- state -------------------------------------------------------------
    def _load_state(self):
        p = os.path.join(self.dir, "state.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as fh:
                st = json.load(fh)
        else:
            st = {}
        st.setdefault("day", {})
        st.setdefault("broker", {})
        st.setdefault("positions", [])
        st.setdefault("pending", {})
        self._roll_day(st)
        return st

    def _roll_day(self, st):
        today = datetime.now(self.tz).strftime("%Y-%m-%d")
        if st["day"].get("date") != today:
            st["day"] = {"date": today, "realized_pnl": 0.0, "trades": 0, "wins": 0, "losses": 0,
                         "consecutive_losses": 0, "last_loss_ts": None, "brain_calls": 0}

    def save(self):
        self._roll_day(self.state)
        p = os.path.join(self.dir, "state.json")
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.state, fh, indent=2)
        os.replace(tmp, p)

    def _append(self, name, row):
        row = dict(row)
        row.setdefault("ts", time.time())
        row.setdefault("et", datetime.now(self.tz).strftime("%Y-%m-%d %H:%M:%S"))
        with open(os.path.join(self.dir, name), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")
        return row

    def _read(self, name, last=None):
        p = os.path.join(self.dir, name)
        if not os.path.exists(p):
            return []
        with open(p, encoding="utf-8") as fh:
            rows = [json.loads(l) for l in fh if l.strip()]
        return rows[-last:] if last else rows

    # ---- events ------------------------------------------------------------
    def decision(self, decision, context_summary, verdict, mode, executed):
        self.state["day"]["brain_calls"] += 1
        return self._append("decisions.jsonl", {
            "decision": decision, "context": context_summary, "verdict": repr(verdict),
            "mode": mode, "executed": executed})

    def trade_closed(self, trade):
        d = self.state["day"]
        d["trades"] += 1
        d["realized_pnl"] = round(d["realized_pnl"] + trade["pnl"], 2)
        if trade["pnl"] < 0:
            d["losses"] += 1
            d["consecutive_losses"] += 1
            d["last_loss_ts"] = time.time()
        else:
            d["wins"] += 1
            d["consecutive_losses"] = 0
        return self._append("trades.jsonl", trade)

    def propose(self, decision, price):
        pid = uuid.uuid4().hex[:8]
        row = {"id": pid, "decision": decision, "price": price, "status": "pending"}
        self.state["pending"][pid] = row
        self._append("proposals.jsonl", row)
        return pid

    def resolve_proposal(self, pid, status):
        row = self.state["pending"].pop(pid, None)
        if row:
            row["status"] = status
            self._append("proposals.jsonl", row)
        return row

    def expire_proposals(self, max_age_s=900):
        now = time.time()
        for pid, row in list(self.state["pending"].items()):
            if now - row.get("ts", now) > max_age_s:
                self.resolve_proposal(pid, "expired")

    def trades(self, last=None):
        return self._read("trades.jsonl", last)

    def decisions(self, last=None):
        return self._read("decisions.jsonl", last)

    def trades_for(self, date):
        return [t for t in self.trades() if t.get("et", "").startswith(date)]

    def decisions_for(self, date):
        return [t for t in self.decisions() if t.get("et", "").startswith(date)]

    # ---- reviews -----------------------------------------------------------
    def save_review(self, date, text):
        p = os.path.join(self.dir, "reviews", "%s.md" % date)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(text)
        return p

    def recent_lessons(self, n=5, max_chars=3000):
        d = os.path.join(self.dir, "reviews")
        files = sorted(f for f in os.listdir(d) if f.endswith(".md"))[-n:]
        out = []
        for f in files:
            with open(os.path.join(d, f), encoding="utf-8") as fh:
                text = fh.read()
            # take the "Lessons" section if present, else the tail
            idx = text.lower().find("## lessons")
            snippet = text[idx:] if idx >= 0 else text[-800:]
            out.append("### %s\n%s" % (f[:-3], snippet.strip()))
        joined = "\n\n".join(out)
        return joined[-max_chars:]
