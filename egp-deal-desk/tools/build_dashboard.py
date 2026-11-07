#!/usr/bin/env python3
"""Build the desk dashboard: dashboard/index.html from dashboard/template.html + the live databases.

Usage: python3 tools/build_dashboard.py [--date YYYY-MM-DD]

Inlines db/deals.json, db/intermediaries.json, db/investor-candidates.json, every outbox draft,
every deals/<slug>/*.md, reports/, sweeps/, playbooks/ and skills/ into one self-contained page.
Re-run after every desk run; publish the result as the artifact.
"""
import datetime, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "dashboard" / "template.html"
OUT = ROOT / "dashboard" / "index.html"

def read(p):
    return p.read_text(encoding="utf-8")

def title_of(text, fallback):
    m = re.search(r"^#\s+(.+)$", text, re.M)
    return (m.group(1).strip() if m else fallback)

def parse_outbox(p, slugs=()):
    text = read(p)
    head, _, body = text.partition("\n---\n")
    fields = {}
    for line in head.splitlines():
        m = re.match(r"^(To|Cc|Subject|Channel|Why now|Status):\s*(.*)$", line)
        if m:
            fields[m.group(1).lower().replace(" ", "_")] = m.group(2).strip()
    stem = p.stem
    m = re.match(r"^(.*?)-(first|followup|termsheet-cover|investor-[^-]+|[a-z-]+?)-(\d{4}-\d{2}-\d{2})$", stem)
    date = m.group(3) if m else ""
    known = [s for s in slugs if stem.startswith(s + "-")]
    slug = max(known, key=len) if known else (m.group(1) if m else stem)
    return {"id": stem, "file": p.name, "slug": slug, "date": date, "to": fields.get("to", ""), "cc": fields.get("cc", ""),
            "subject": fields.get("subject", ""), "channel": fields.get("channel", ""), "why": fields.get("why_now", ""),
            "status_line": fields.get("status", ""), "body": body.strip() if body else text}

def report_decisions(text):
    """The numbered items under '## Decisions for Amogh' in a desk report."""
    m = re.search(r"^## Decisions for Amogh.*?$\n(.*?)(?=^## |^---|\Z)", text, re.M | re.S)
    if not m:
        return []
    items = re.findall(r"^\d+\.\s+(.*?)(?=^\d+\.\s|\Z)", m.group(1), re.M | re.S)
    out = []
    for it in items:
        it = " ".join(it.split())
        t = re.match(r"^\*\*(.+?)\*\*\s*(.*)$", it)
        out.append({"title": t.group(1) if t else it[:90], "body": t.group(2) if t else ""})
    return out

def report_lead(text):
    m = re.search(r"^## The one thing to read\s*$\n(.*?)(?=^---|^## )", text, re.M | re.S)
    return m.group(1).strip() if m else text[:1500]

def main():
    date = datetime.date.today().isoformat()
    if "--date" in sys.argv:
        date = sys.argv[sys.argv.index("--date") + 1]
    deals = json.loads(read(ROOT / "db" / "deals.json"))
    inter = json.loads(read(ROOT / "db" / "intermediaries.json"))
    inv_p = ROOT / "db" / "investor-candidates.json"
    investors = json.loads(read(inv_p)) if inv_p.exists() else []
    slugs = [d["slug"] for d in deals]
    outbox = [parse_outbox(p, slugs) for p in sorted((ROOT / "outbox").glob("*.md"))]
    deal_docs = {}
    for d in sorted((ROOT / "deals").glob("*/")):
        docs = {p.stem: read(p) for p in d.glob("*.md")}
        if docs:
            deal_docs[d.name] = docs
    reports = sorted((ROOT / "reports").glob("*.md"), reverse=True)
    report_texts = [{"file": p.name, "title": title_of(read(p), p.stem), "text": read(p)} for p in reports]
    sweeps = [{"file": p.name, "title": title_of(read(p), p.stem), "text": read(p)} for p in sorted((ROOT / "sweeps").glob("*.md"), reverse=True)]
    playbooks = [{"file": p.name, "title": title_of(read(p), p.stem), "text": read(p)} for p in sorted((ROOT / "playbooks").glob("*.md"))]
    skills = [{"file": p.name, "title": title_of(read(p), p.stem), "text": read(p)} for p in sorted((ROOT / "skills").glob("*.md"))]
    latest = report_texts[0]["text"] if report_texts else ""
    data = {
        "built_on": date, "built_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "deals": deals, "intermediaries": inter, "investors": investors, "outbox": outbox, "deal_docs": deal_docs,
        "reports": report_texts, "sweeps": sweeps, "playbooks": playbooks, "skills": skills,
        "report_date": re.search(r"(\d{4}-\d{2}-\d{2})", reports[0].name).group(1) if reports else date,
        "report_decisions": report_decisions(latest), "report_lead": report_lead(latest),
    }
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = read(TEMPLATE).replace("/*__DESK_DATA__*/null", payload, 1)
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(html)/1024:.0f} KB · {len(deals)} deals · {len(outbox)} drafts · {len(investors)} investors · {len(inter)} intermediaries · {len(data['report_decisions'])} decisions")

if __name__ == "__main__":
    main()
