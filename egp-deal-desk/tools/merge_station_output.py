#!/usr/bin/env python3
"""Merge a station worker's JSON (one target) into db/deals.json and db/intermediaries.json.

Usage: python3 tools/merge_station_output.py <json-file> [<json-file> ...]
Each file holds one object with the keys the Analyst/Strategist return:
slug, score, tier, stage, decision_maker, intermediary, need_band_usd, need_type,
fee_proposed, potential_fee_usd, next_action, next_action_date, brief, signals,
sources, new_intermediaries, notes. Missing keys leave the record untouched.
"""
import json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
DB = ROOT / "db" / "deals.json"; INT = ROOT / "db" / "intermediaries.json"
FIELDS = ["score","stage","decision_maker","intermediary","need_band_usd","need_type",
          "fee_proposed","potential_fee_usd","next_action","next_action_date","brief","notes"]

def main(paths):
    deals = json.loads(DB.read_text()); inter = json.loads(INT.read_text())
    by_slug = {d["slug"]: d for d in deals}
    known = {(i.get("name","").strip().lower(), i.get("firm","").strip().lower()) for i in inter}
    for p in paths:
        o = json.loads(pathlib.Path(p).read_text())
        rec = by_slug.get(o["slug"])
        if rec is None:
            sys.exit(f"unknown slug {o['slug']}")
        for f in FIELDS:
            if f in o and o[f] not in (None, ""):
                rec[f] = o[f]
        if o.get("signals"):
            have = {(s.get("date"), s.get("signal")) for s in rec.get("signals", [])}
            rec["signals"] = rec.get("signals", []) + [s for s in o["signals"] if (s.get("date"), s.get("signal")) not in have]
        if o.get("sources"):
            rec["sources"] = sorted(set(rec.get("sources", [])) | set(o["sources"]))
        added = 0
        for ni in o.get("new_intermediaries", []) or []:
            key = (ni.get("name","").strip().lower(), ni.get("firm","").strip().lower())
            if key in known: continue
            inter.append({"name": ni.get("name",""), "firm": ni.get("firm",""), "type": ni.get("type",""),
                          "region": ni.get("region",""), "country": ni.get("country",""), "why": ni.get("why",""),
                          "url": ni.get("url",""), "relationship": "none", "last_contact": "", "referrals": []})
            known.add(key); added += 1
        print(f"merged {o['slug']}: score {rec.get('score')} stage {rec.get('stage')} next {rec.get('next_action_date')} (+{added} intermediaries)")
    DB.write_text(json.dumps(deals, indent=2, ensure_ascii=False) + "\n")
    INT.write_text(json.dumps(inter, indent=2, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    if len(sys.argv) < 2: sys.exit(__doc__)
    main(sys.argv[1:])
