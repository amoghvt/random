# Skill: Strategist

Purpose: for a Priority target, design the entry so the first contact is warm, specific and lands a 20-minute call.

## Output (`deals/<slug>/entry.md`)

```
# Entry plan — <Company>

## Path in (ranked)
1. <Warm route>: named intermediary / shared investor / board member / adviser seen in sources; why they'd introduce; what's in it for them (referral fee 10–20% of engagement fee is standard; say so).
2. <Second route>
3. Direct: decision-maker's public channel (LinkedIn, company email pattern, event they're speaking at).

## Angle
One sentence: the specific problem we noticed + what we did in a comparable case + the ask.
Front door: Readiness Programme (fixed fee, 30 days) — low risk for them, builds trust, produces the material for the mandate.
Behind the door: Capital Advisory Mandate + equity ask.

## Fee design
Readiness: EUR __k on signature.  Engagement: EUR __k.  Success: _% of capital raised.  Equity/warrants: _% of holdco.  Rationale in two lines (size, urgency, competition).

## First message
(drafted in Amogh's voice, ≤ 120 words, see templates/first-message.md; file copy to outbox/<slug>-first.md)

## Call brief
What to ask in 20 minutes; what they'll object to; what we must not promise (no guaranteed raise, no timing promises, no investor names before NDA).

## Investor pre-match
2–4 investors from db/investors.json whose thesis fits, with the one-line reason. (Never named to the target before NDA.)

## Kill criteria
What we'd learn on the first call that ends it.
```

## Framing rule for regulated-financial recaps

The story is a **primary raise forced by the regulator**, priced on restated book, owners taking no proceeds. It is never "the owners are getting old and selling 40–49%". Succession is the investor's control path in year 4–5, mentioned once, not the pitch. Write `deals/<slug>/snapshot.json` (amount, stake, look-through, primary/secondary, solvency figure, entity names, banned claims) before the first message and run `tools/consistency_check.py <slug>`.

Investor pre-match for this archetype comes from `db/investor-candidates.json` (types in playbook §6.1, ranked by prior regulated-financial deals, geography, ticket, minority tolerance) and from `db/investors.json` once Amogh has filled it. Hand the shortlist to `skills/investor.md`.

## Principles
- Specific beats clever: quote the public signal (filing, rating action) in the first line.
- Receipts not poetry: one comparable deal, one number, one ask.
- Intermediaries first: a referral from their lawyer/auditor converts 5–10x better than cold outreach and makes EGP look like a peer, not a vendor.
- Never promise an outcome. EGP sells a process and a network.
- Fee anchors: readiness fee covers EGP's real cost and signals seriousness; success fee is where the upside is; equity ask is the asymmetry — ask for it every time, accept losing it.
