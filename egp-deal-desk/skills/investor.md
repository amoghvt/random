# Skill: Investor

Purpose: find the investors who actually close EGP's deal types, qualify them before they see anything, and convert them without losing the one thing that makes a family office say yes: the feeling that it was shown the bad number first.

Reads: `playbooks/rescue-recap-with-succession.md` §6 (universe, filters, qualification questions), `db/investor-candidates.json` (the prospect graph the desk builds), `db/investors.json` (Amogh's confirmed network — never shown to a target, never pasted to an external service).

## 1. Build the graph (weekly, 2 hours)

Sources that NAME investors who have done this before, in order of signal quality:
1. Regulator approvals of qualifying holdings / change of control (CNSF-SHCP, SBS, SFC, CMF, SUSEP, SAMA, Saudi IA, CBUAE, CMA, OJK, BNM, EIOPA/NCA registers). The approval notice names the acquirer, the stake and the date. That is a verified "has done a regulated-financial deal and survived an approval".
2. DFI disclosure pages (IFC, IDB Invest, FMO, BII, Proparco, DEG): every proposed equity investment is public months before closing, with ticket and co-investors.
3. Deal press for recapitalisations of insurers / lenders in the target geography: the co-investors, the law firms, the advisers.
4. Reinsurer strategic arms and run-off buyers (capital-relief partners as much as equity).
5. Family offices documented as owning insurance / health / lending assets (regulatory beneficial-owner registers, company sites, press). Boards of regional insurers: directors often sit on family-office investment committees.

Record each investor as in `db/SCHEMA.md` (investor-candidates): type, HQ, geographies, sectors, ticket band, evidence deals with URLs, minority tolerance, approval experience, fit 1–5, contact path (public page, never a guessed address), status.

Rank by: (a) prior regulated-financial deals, (b) geography, (c) ticket, (d) evidence of accepting a minority with governance, (e) speed of decision (family office > DFI).

## 2. Qualify before sending anything (one call, 15 minutes)

The five questions in the playbook §6.3, asked in this order, conversationally:
1. "Have you put money into a regulated balance-sheet business before? Which one?"
2. "Would you underwrite on restated book with an actuarial adjustment, or do you need an earnings multiple?"
3. "Have you been through a change-of-control approval in [country]? Can you hold through 6–9 months of it?"
4. "Is a 4–6 year hold with no dividends for the first 3 years workable?"
5. "Ticket, and do you lead or follow?"
Two "no" answers → no deck, thank them, keep them on the list for a different archetype. Record the answers in the investor's record under `qualification`.

## 3. Convert (the part nobody else does well)

What a family-office principal is actually deciding on a first call is not the deal. It is: "will this person make me look foolish in front of my family / my co-investors?" Everything below follows from that.

- **Bad number first.** Open with the incurred-basis combined ratio, the advances-over-equity, the regulator's letter. Said by us, it is a sign of competence; found by them, it is a sign of concealment and the conversation is over. (Playbook §10.3.)
- **One story, frozen.** Snapshot, deck, data room and every email say the same amount, stake, look-through, primary/secondary and solvency figure. Run `tools/consistency_check.py <slug>` before any outbound. A mismatch is the single most common reason a lead investor declines. (§10.1)
- **Receipts, not adjectives.** Every claim in an email is in a document we can attach today. "Regulator sign-off", "actuary commissioned", "revenue to USD 400m" are banned unless the paper exists. (§10.2)
- **Conditions are a checklist, not a debate.** When an investor states conditions, write them down verbatim, attach evidence to each, and do not re-approach until every line is green. Re-approaching early with arguments reads as pressure; re-approaching late with documents reads as diligence. (§10.4)
- **Give them the independent review as the trust object.** The actuarial / asset-quality review with a price-adjustment mechanism is what lets a principal say yes without being the one who priced it. Offer it before they ask; the investor who proposes it feels in control, the investor who is offered it feels protected. Both are good.
- **Name the exit before they ask about it.** Strategic buyer list (regional insurers/banks who want the licence) in the deck. A family office is not buying a company; it is buying a credible path to someone else buying it.
- **Let them bring a friend.** Family offices close faster with a co-investor they already trust. Ask "who would you want alongside you on this?" on the second call and let them introduce; the deal becomes theirs.
- **Never sell the owners' age as the reason.** The owners are not selling; the regulator is forcing a primary raise. Succession is the investor's upside (control path later), not the pitch. (§3, §10.1)
- **Silence after a data room is a question, not a no.** Ask which number stopped them. The answer usually names a document we can produce in a week.
- **The adviser never stands between the investor and the owner once an NDA is signed.** Facilitate, do not gate; never condition an introduction on a fee. (§10.6)

## 4. Run the process

Per deal, `deals/<slug>/investors.md`: shortlist of 6–10 qualified investors with status (not contacted / qualified / NDA / data room / conditions / term sheet / declined with reason), conditions checklist with evidence links, and the one-paragraph frozen snapshot at the top. Max 10 investor first-contacts per deal per week; three at a time is better, so each one gets a real conversation.

Investor outreach drafts go to `outbox/<slug>-investor-<name>-<date>.md` and are sent only after Amogh approves. Template: `templates/investor-first-message.md`.

## 5. What this station reports in the weekly desk report

New investors added to the graph (with evidence), investors qualified this week (answers), investors in process per deal with status and the next document owed, declines with the stated reason (these are the desk's most valuable data).
