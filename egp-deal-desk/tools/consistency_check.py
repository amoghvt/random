#!/usr/bin/env python3
"""Consistency checker (playbook §10.1, §11): one story before any outbound.

Usage: python3 tools/consistency_check.py <slug>

Reads deals/<slug>/snapshot.json — the frozen story:
  {"amount_usd_m": [22], "stake_pct": [49], "look_through_pct": [27, 30],
   "primary_or_secondary": "primary", "solvency": ["1.01x", "1.02x"],
   "entities": ["Plan Seguro S.A. de C.V."], "banned_claims": ["regulator sign-off"]}
Then scans deals/<slug>/*.md and outbox/<slug>-*.md for USD amounts, percentages,
the words "secondary"/"selling"/"sale of shares" when the story is primary, and any
banned claim. Prints every mismatch with file and line. Exit 1 on any mismatch
(so a hook or the Operator can block the send).
"""
import json, pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent

def nums(pattern, text):
    return [float(x.replace(",", "")) for x in re.findall(pattern, text)]

def main(slug):
    snap_p = ROOT / "deals" / slug / "snapshot.json"
    if not snap_p.exists():
        sys.exit(f"no snapshot: {snap_p} — write the frozen story first")
    snap = json.loads(snap_p.read_text())
    files = sorted((ROOT / "deals" / slug).glob("*.md")) + sorted((ROOT / "outbox").glob(f"{slug}-*.md"))
    ok_amounts = {float(a) for a in snap.get("amount_usd_m", [])}
    ok_stakes = {float(s) for s in snap.get("stake_pct", [])} | {float(s) for s in snap.get("look_through_pct", [])}
    banned = [b.lower() for b in snap.get("banned_claims", [])]
    primary = snap.get("primary_or_secondary", "primary") == "primary"
    problems = 0
    for f in files:
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            low = line.lower()
            for a in nums(r"USD\s?([\d,]+(?:\.\d+)?)\s?[Mm]\b", line):
                if ok_amounts and a not in ok_amounts:
                    print(f"{f.relative_to(ROOT)}:{n}: amount USD {a:g}M not in snapshot {sorted(ok_amounts)}"); problems += 1
            for s in nums(r"\b([\d]{1,2}(?:\.\d+)?)\s?%\s?(?:of|stake|look-through|equity|of the holdco|of the opco)", line):
                if ok_stakes and s not in ok_stakes:
                    print(f"{f.relative_to(ROOT)}:{n}: stake {s:g}% not in snapshot {sorted(ok_stakes)}"); problems += 1
            if primary and re.search(r"\b(secondary|owners? (are )?selling|sale of (their )?shares|cash[- ]out)\b", low):
                print(f"{f.relative_to(ROOT)}:{n}: secondary/selling language in a primary story"); problems += 1
            for b in banned:
                if b in low:
                    print(f"{f.relative_to(ROOT)}:{n}: banned claim '{b}' (no document to attach)"); problems += 1
    print(f"{'BLOCK' if problems else 'OK'}: {problems} mismatch(es) across {len(files)} file(s) for {slug}")
    sys.exit(1 if problems else 0)

if __name__ == "__main__":
    if len(sys.argv) != 2: sys.exit(__doc__)
    main(sys.argv[1])
