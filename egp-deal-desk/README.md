# EGP Deal Desk

An AI-run origination and deal-preparation desk for Enterprise Growth Partners. Hunts, analyses, strategises and operates; Amogh closes.

## Run it

**In Claude Code (recommended — the desk's brain lives in `CLAUDE.md` and `skills/`):**
```
cd egp-deal-desk
claude
> run the hunter sweep for all regions and score the results
> operator: what's due today, draft the follow-ups
> write this week's desk report
```
Claude Code reads `CLAUDE.md` automatically and uses the skills as instructions.

**Scheduled (in Claude):** a weekly scheduled task that runs the Hunter + Analyst and writes `reports/desk-report-<date>.md`, plus a daily Operator run that lists actions due and drafts to `outbox/`.

**Email and documents:** connect Gmail/Outlook and Google Drive. The Operator then reads inbound, drafts replies into `outbox/`, and sends only on Amogh's approval. Approval is per message; nothing goes out unreviewed.

## Layout
```
CLAUDE.md             operating manual (ICP, products, rules, cadence)
skills/               hunter · analyst · strategist · operator · investor
playbooks/            deal archetypes (rescue-recap with succession = the reference pattern)
db/                   deals.json · intermediaries.json · investors.json · SCHEMA.md
sweeps/               raw hunter output per region/date
deals/<slug>/         brief.md · entry.md · drafts
outbox/ sent/         outbound drafts awaiting approval · sent log
reports/              weekly desk reports
templates/            first message · readiness outline · mandate outline · call brief
tools/pipeline.py     pipeline report / rank / due / add
tools/consistency_check.py   one-story check before any outbound (snapshot vs drafts)
tools/merge_station_output.py  merge a station worker's JSON into the databases
```

## First things Amogh fills in
1. `db/investors.json` — the network: name, type, geography, sectors, ticket, thesis. The Analyst's investor-match score depends on it.
2. `db/intermediaries.json` — mark anyone already known (`relationship: warm/active`).
3. Approve or edit `templates/first-message.md` so it sounds like him.

## Rules that never change
No fabricated facts. No outbound without approval. Max 10 first-contacts a week. Regulatory flag on every brief. Honesty over optimism.
