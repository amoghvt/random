#!/usr/bin/env python3
"""Jarvis: a discretionary NQ trading agent. Run from the jarvis/ folder.

  python3 jarvis.py status                 where things stand
  python3 jarvis.py picture                the market picture the brain sees (no model call)
  python3 jarvis.py brief                  one brain read of the market, nothing placed
  python3 jarvis.py ask "question"         ask the brain over your knowledge + the live picture
  python3 jarvis.py tick                   one heartbeat (respects mode)
  python3 jarvis.py run [--every 60]       the loop
  python3 jarvis.py approve <id>           execute a pending proposal
  python3 jarvis.py flatten                close everything now
  python3 jarvis.py stop | resume          kill switch on / off
  python3 jarvis.py ingest                 index jarvis/knowledge/
  python3 jarvis.py review [YYYY-MM-DD]    end-of-day review -> state/reviews/
  python3 jarvis.py reset-paper            fresh paper account
"""

import argparse
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from jarvis_core import config as config_mod  # noqa: E402
from jarvis_core import knowledge, risk  # noqa: E402
from jarvis_core.brain import BrainError  # noqa: E402
from jarvis_core.loop import Jarvis  # noqa: E402


def cmd_status(j, args):
    st = j.journal.state
    print("mode:    %s   broker: %s   paper: %s   model: %s" % (j.cfg["mode"], j.broker.name, j.cfg["paper"], j.cfg["model"]))
    print("kill:    %s" % ("ON (touch removed to resume)" if risk.kill_switch_on(j.cfg) else "off"))
    print("day:     %s" % json.dumps(st["day"]))
    if hasattr(j.broker, "equity"):
        print("equity:  $%.2f" % j.broker.equity)
    ps = j.broker.positions()
    print("position: %s" % (ps[0].to_dict() if ps else "flat"))
    if st["pending"]:
        print("pending proposals:")
        for pid, row in st["pending"].items():
            d = row["decision"]
            print("  %s  %s %d stop %s target %s conf %.2f" % (pid, d["action"], d["contracts"], d["stop_price"], d["target_price"], d["confidence"]))
    pre = risk.pre_check(j.cfg, st)
    print("trading allowed now: %r" % pre)
    print("knowledge: %s chunks" % (j.kindex["N"] if j.kindex else 0))


def cmd_picture(j, args):
    bars, pic = j.picture()
    print(json.dumps(pic, indent=1, default=str))


def cmd_brief(j, args):
    bars, pic = j.picture()
    ctx = j.context(pic, pic["price"])
    try:
        d = j.brain.decide(**ctx)
    except BrainError as e:
        sys.exit("brain: %s" % e)
    print(json.dumps(d, indent=1))
    print("\nrisk: %r" % (risk.pre_check(j.cfg, j.journal.state) and risk.check(j.cfg, d, j.journal.state, pic["price"])))


def cmd_ask(j, args):
    bars, pic = j.picture()
    ctx = j.context(pic, pic["price"], question=args.question)
    try:
        print(j.brain.ask(args.question, **ctx))
    except BrainError as e:
        sys.exit("brain: %s" % e)


def cmd_tick(j, args):
    print(json.dumps(j.tick(force_brain=args.force), indent=1, default=str))


def cmd_run(j, args):
    j.run(every=args.every)


def cmd_approve(j, args):
    print(j.approve(args.id))


def cmd_flatten(j, args):
    print(j.flatten("manual") or "nothing open")


def cmd_stop(j, args):
    p = os.path.join(j.cfg["_root"], j.cfg["risk"]["kill_file"])
    open(p, "a").close()
    print("kill switch ON (%s). Next tick flattens any position. `resume` to clear." % p)


def cmd_resume(j, args):
    p = os.path.join(j.cfg["_root"], j.cfg["risk"]["kill_file"])
    if os.path.exists(p):
        os.remove(p)
    print("kill switch off")


def cmd_ingest(j, args):
    idx = knowledge.build_index(j.kdir, exclude=())
    knowledge.save_index(idx, j.kdir)
    srcs = sorted(set(d["source"] for d in idx["docs"]))
    print("indexed %d chunks from %d files" % (idx["N"], len(srcs)))
    for s in srcs:
        print("  " + s)


def cmd_review(j, args):
    date = args.date or datetime.now(j.tz).strftime("%Y-%m-%d")
    trades = j.journal.trades_for(date)
    decisions = j.journal.decisions_for(date)
    if not trades and not decisions:
        sys.exit("nothing journaled for %s" % date)
    q = ("Write the end-of-day review for %s. Sections: ## What happened, ## Each trade (entry reason, exit, "
         "what the market actually did), ## Decisions not taken that mattered, ## Behavioural read (where the "
         "trader or the agent chased, hesitated, revenge-traded, or sat on hands correctly), ## Lessons "
         "(3 to 5 lines, concrete, each starting with 'Next time'). Be blunt.\n\nTrades:\n%s\n\nDecisions:\n%s") % (
        date, json.dumps(trades, indent=1), json.dumps([{"et": d["et"], "d": {k: v for k, v in d["decision"].items() if k != "_context_fp"}, "verdict": d["verdict"], "executed": d["executed"]} for d in decisions], indent=1)[:60000])
    bars, pic = j.picture()
    ctx = j.context(pic, pic["price"], question=q)
    try:
        text = j.brain.ask(q, **ctx)
    except BrainError as e:
        sys.exit("brain: %s" % e)
    p = j.journal.save_review(date, text)
    print(text)
    print("\nsaved %s" % p)


def cmd_reset_paper(j, args):
    if j.cfg["broker"]["kind"] != "paper":
        sys.exit("broker is not paper")
    j.journal.state["broker"] = {}
    j.journal.state["positions"] = []
    j.journal.state["pending"] = {}
    j.journal.save()
    print("paper account reset to $%.2f on next start" % j.cfg["broker"]["paper_starting_equity"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None, help="path to config.json (default: jarvis/config.json)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("status", "picture", "brief", "flatten", "stop", "resume", "ingest", "reset-paper"):
        sub.add_parser(name)
    a = sub.add_parser("ask"); a.add_argument("question")
    t = sub.add_parser("tick"); t.add_argument("--force", action="store_true", help="call the brain even outside windows")
    r = sub.add_parser("run"); r.add_argument("--every", type=int, default=None)
    ap_ = sub.add_parser("approve"); ap_.add_argument("id")
    rv = sub.add_parser("review"); rv.add_argument("date", nargs="?")
    args = ap.parse_args(argv)

    try:
        cfg = config_mod.load(args.config)
    except config_mod.ConfigError as e:
        sys.exit("config: %s" % e)
    needs_net = args.cmd not in ("stop", "resume", "ingest", "reset-paper", "status")
    j = Jarvis(cfg, fetch_news=needs_net)
    globals()["cmd_" + args.cmd.replace("-", "_")](j, args)


if __name__ == "__main__":
    main()
