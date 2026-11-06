# Skill: Analyst

Purpose: turn a sourced candidate into a scored, one-page brief Amogh can read in two minutes.

## Scoring rubric (0–100)

| Dimension | Weight | 0 | 5 | 10 |
|---|---|---|---|---|
| **Need** — strength and timing of the capital/restructuring signal | 25 | vague press | one dated hard signal | regulator/rating/filing signal with a deadline inside 6 months |
| **Bank-shyness** — reason mainstream advisers won't do it | 20 | clean company | one complication | regulatory/tax/claims problem or off-book liabilities that scare banks but are solvable |
| **Decision-maker** — one reachable owner who can sign | 20 | diffuse listed board | holdco with identifiable chair | family/founder, named, with public contact path |
| **Size fit** — need in USD 10M–150M, can pay fixed fee | 15 | outside band or can't pay | in band, fee uncertain | in band, revenue > USD 50M, fee easily affordable |
| **Investor match** — fits EGP's network thesis (`db/investors.json`) | 10 | no match | plausible | a named investor already active in sector/region |
| **Entry path** — warm route exists | 10 | cold only | intermediary identified | intermediary known to EGP or shared contact |

Score = Σ(dimension score/10 × weight). Thresholds: **≥ 70 Priority** (Strategist this week) · **50–69 Watch** (re-sweep monthly, cultivate intermediary) · **< 50 Park**.

## Brief template (`deals/<slug>/brief.md`)

```
# <Company> — <country>, <sector>              Score: NN  [Priority/Watch/Park]
As of: <date>

**What they are.** 2 lines: business, size, ownership, decision-maker (sourced).
**What's wrong.** 3–5 lines: the signals, dated, each with its source. Deadline if any.
**What they'll need.** Amount band, instrument (recap equity / holdco loan / refi / secondary), timing. Mark estimates as estimates.
**Why it's ours.** Why banks/bulge-bracket won't; why EGP's readiness-then-mandate model fits; comparable (Plan Seguro) in one line.
**Who decides.** Names and roles only from sources. Public contact path.
**Regulatory note.** How an EGP mandate sits for this jurisdiction; local counsel needed?
**Risks.** What would make this a bad client (fraud indicators, liquidation risk, can't pay, hostile creditors).
**Proposed fee.** Readiness fee / engagement fee / success % / equity ask.
**Sources.** URLs.
```

## Archetype additions (rescue-recap with succession)

When the Hunter tags a candidate as the archetype, the brief also carries: the **shock** (external, dated) and the **structural problem** (under-pricing / under-reserving) as two separate lines; the **ownership chain** to the UBO with look-through arithmetic; the **capital need on three bases** (management's; restated to 1.0x; restated to 1.3x with headroom) marked as estimates until the first-10-days pack arrives; the §7 red-flag tests with a pass/fail/unknown each; and a **sellability** line: can an independent actuarial / asset-quality review be commissioned, is solvency > 0.8x, will the owner cooperate. Score Bank-shyness 8–10 only for regulatory, tax, claims or reserving complications; cyclical distress inside an insolvency process scores 4–6.

## Method
1. Read the Hunter entry. Re-verify the two strongest signals by fetching sources.
2. Fill the brief. Be blunt in Risks. If the company is likely headed to liquidation or shows fraud indicators, score Need high but mark **Park — not a client** in the header.
3. Update `db/deals.json`: stage `qualified`, score, brief path.
4. For Priority targets, hand to Strategist.
