---
name: deal-desk
description: >-
  The EGP Deal Desk in egp-deal-desk/: an origination and deal-preparation desk
  for Enterprise Growth Partners (hunter, analyst, strategist, operator; Amogh
  closes). Use when the user says "deal desk", "run the desk", "hunter sweep",
  "score the sweep", "what's due", "operator", "draft the follow-ups", "desk
  report", "brief me on <company>", "entry plan for <company>", "approve the
  draft", or wants pipeline, briefs, first messages or the weekly report.
argument-hint: "[due|report|rank|sweep <region>|brief <slug>|entry <slug>|operator|weekly]"
---

# EGP Deal Desk

The desk lives in `egp-deal-desk/`. Its brain is `egp-deal-desk/CLAUDE.md` (rules, ICP,
products, cadence) and the four station skills in `egp-deal-desk/skills/`. Read the manual
first, then the station you are running. Work from that folder:

```bash
cd egp-deal-desk && python3 tools/pipeline.py report      # pipeline by stage + actions due
cd egp-deal-desk && python3 tools/pipeline.py due          # actions due today
cd egp-deal-desk && python3 tools/pipeline.py rank         # every target by score
```

| ask | station | writes |
| --- | --- | --- |
| "hunter sweep <region>" | `skills/hunter.md` | `sweeps/<region>-<date>.md` |
| "score / brief <slug>" | `skills/analyst.md` | `deals/<slug>/brief.md`, `db/deals.json` |
| "entry plan <slug>" | `skills/strategist.md` | `deals/<slug>/entry.md`, `deals/<slug>/call-brief.md`, `outbox/<slug>-first-<date>.md` |
| "operator / what's due" | `skills/operator.md` | `outbox/<slug>-<type>-<date>.md`, record updates |
| "desk report / weekly" | `skills/operator.md` | `reports/desk-report-<date>.md` |
| "find investors for <slug>" / "qualify <investor>" | `skills/investor.md` | `db/investor-candidates.json`, `deals/<slug>/investors.md`, `outbox/<slug>-investor-*.md` |
| "check the story" | `tools/consistency_check.py <slug>` | blocks outbound on a mismatch |

Rules for this skill (they repeat the manual on purpose):
- No fabrication. Every company, figure and person carries a source URL that was actually fetched; otherwise "unverified".
- Nothing is sent. Drafts go to `outbox/`; only after the user approves a specific draft in chat is it moved to `sent/` and the record updated.
- Max 10 first-contacts a week across the desk. Warm route (named intermediary) before cold.
- Every brief carries a regulatory note for its jurisdiction. The desk is not a lawyer.
- `db/investors.json` is the user's private network: never expose it to a target, never paste it to an external service.
- Be honest: say when a target is weak, a fee is too high or a deal is unlikely.
- The archetype the desk is built around is in `egp-deal-desk/playbooks/rescue-recap-with-succession.md`; read it before hunting, scoring or talking to investors about a regulated financial.
