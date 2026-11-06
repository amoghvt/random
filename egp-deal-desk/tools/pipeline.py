#!/usr/bin/env python3
"""Deal desk pipeline helper.

Usage:
  python tools/pipeline.py report            # pipeline by stage + actions due
  python tools/pipeline.py rank              # all targets ranked by score
  python tools/pipeline.py due [YYYY-MM-DD]  # actions due on/before date
  python tools/pipeline.py add <slug> --company ... --country ... --region ... --sector ... --score N --stage sourced
"""
import json, sys, argparse, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DB = ROOT / "db" / "deals.json"
STAGES = ["sourced","qualified","approached","in_conversation","readiness_proposed",
          "readiness_signed","mandate_signed","investor_process","term_sheet","closed","dead"]

def load():
    return json.loads(DB.read_text()) if DB.exists() else []

def save(d):
    DB.write_text(json.dumps(d, indent=2, ensure_ascii=False))

def report(deals, today):
    print(f"# Pipeline — {today}\n")
    for s in STAGES:
        rows = [d for d in deals if d.get("stage")==s]
        if not rows: continue
        fees = sum(d.get("potential_fee_usd",0) or 0 for d in rows)
        print(f"## {s} ({len(rows)}) — potential fees USD {fees:,.0f}")
        for d in sorted(rows, key=lambda x: -(x.get("score") or 0)):
            print(f"- {d['company']} [{d.get('country')}] score {d.get('score')} — next: {d.get('next_action','')} ({d.get('next_action_date','')})")
        print()
    due(deals, today)

def due(deals, today):
    rows = [d for d in deals if d.get("next_action_date") and d["next_action_date"] <= today and d.get("stage") not in ("closed","dead")]
    print(f"## Actions due by {today} ({len(rows)})")
    for d in sorted(rows, key=lambda x: x["next_action_date"]):
        print(f"- {d['next_action_date']} {d['company']}: {d.get('next_action','')}")

def rank(deals):
    print("# Targets ranked\n")
    for d in sorted(deals, key=lambda x: -(x.get("score") or 0)):
        tier = "Priority" if (d.get("score") or 0)>=70 else "Watch" if (d.get("score") or 0)>=50 else "Park"
        print(f"- {d.get('score'):>3} {tier:8} {d['company']} [{d.get('country')}/{d.get('sector')}] stage={d.get('stage')} need={d.get('need_band_usd','')} {d.get('need_type','')}")

def main():
    today = datetime.date.today().isoformat()
    args = sys.argv[1:]
    deals = load()
    if not args or args[0]=="report": report(deals, today)
    elif args[0]=="rank": rank(deals)
    elif args[0]=="due": due(deals, args[1] if len(args)>1 else today)
    elif args[0]=="add":
        p = argparse.ArgumentParser(); p.add_argument("slug")
        for f in ["company","country","region","sector","size_note","need_band_usd","need_type","decision_maker","intermediary","fee_proposed","next_action","next_action_date","brief","notes"]:
            p.add_argument(f"--{f}", default="")
        p.add_argument("--score", type=int, default=0); p.add_argument("--stage", default="sourced")
        p.add_argument("--potential_fee_usd", type=float, default=0)
        a = p.parse_args(args[1:])
        if any(d["slug"]==a.slug for d in deals): sys.exit("slug exists")
        rec = vars(a); rec["signals"]=[]; rec["sources"]=[]; rec["last_contact"]=""
        deals.append(rec); save(deals); print("added", a.slug)
    else: print(__doc__)

if __name__=="__main__": main()
