#!/usr/bin/env python3
"""Record a sent message: move the outbox draft to sent/, update the deal record.

Usage: python3 tools/record_sent.py <draft-id> --to <address> [--message-id <id>] [--date YYYY-MM-DD]
                                   [--stage approached|in_conversation] [--followup-days 7]
<draft-id> is the outbox file stem, e.g. windmoeller-first-2026-11-06.
"""
import argparse, datetime, json, pathlib, re, shutil, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("draft"); ap.add_argument("--to", required=True)
    ap.add_argument("--message-id", default=""); ap.add_argument("--date", default=datetime.date.today().isoformat())
    ap.add_argument("--stage", default="approached"); ap.add_argument("--followup-days", type=int, default=7)
    a = ap.parse_args()
    src = ROOT / "outbox" / f"{a.draft}.md"
    if not src.exists(): sys.exit(f"no such draft: {src}")
    deals = json.loads((ROOT / "db" / "deals.json").read_text(encoding="utf-8"))
    slugs = sorted((d["slug"] for d in deals), key=len, reverse=True)
    slug = next((s for s in slugs if a.draft.startswith(s + "-")), None)
    (ROOT / "sent").mkdir(exist_ok=True)
    dst = ROOT / "sent" / f"{a.draft}.sent-{a.date}.md"
    text = src.read_text(encoding="utf-8")
    stamp = f"Sent: {a.date} · To: {a.to}" + (f" · Message-Id: {a.message_id}" if a.message_id else "") + "\n"
    dst.write_text(stamp + text.replace("Status: DRAFT — awaiting Amogh's approval", "Status: SENT " + a.date, 1), encoding="utf-8")
    src.unlink()
    if slug:
        for d in deals:
            if d["slug"] == slug:
                if d["stage"] in ("sourced", "qualified") or (a.stage == "in_conversation" and d["stage"] == "approached"):
                    d["stage"] = a.stage
                d["last_contact"] = a.date
                fu = (datetime.date.fromisoformat(a.date) + datetime.timedelta(days=a.followup_days)).isoformat()
                d["next_action"] = f"Reply from {a.to.split('<')[0].strip() or a.to}; if silent, follow-up #1"
                d["next_action_date"] = fu
                d["notes"] = (d.get("notes", "") + f" Sent {a.draft} on {a.date}.").strip()
        (ROOT / "db" / "deals.json").write_text(json.dumps(deals, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"recorded: {dst.name}; {slug} -> {a.stage}, follow-up {fu}")
    else:
        print(f"recorded: {dst.name}; no matching deal record (slug not found)")

if __name__ == "__main__":
    main()
