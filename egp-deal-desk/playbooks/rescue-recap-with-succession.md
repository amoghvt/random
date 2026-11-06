# Deal archetype: Family-owned regulated financial business — solvency-driven recapitalisation with succession

Reference case: Plan Seguro S.A. de C.V., Compañía de Seguros (Mexico, specialised health insurer), EGP mandate Sep–Nov 2026.
Purpose of this file: give the EGP deal desk a precise definition of this deal type so it can (a) recognise and source similar situations, (b) qualify them fast, (c) identify and rank the investors who actually close them, and (d) run the process without repeating the mistakes made on the reference case.

---

## 1. One-paragraph definition

A privately held, family-controlled, **regulated balance-sheet business** (insurer, lender, payments firm, broker-dealer, bank) with a real franchise (licence, distribution, customer base, 10+ years of operation) that has fallen into a **regulatory capital shortfall** because of an external shock (tax change, claims inflation, rate move, regulatory reserve change) layered on top of a **structural under-pricing or under-reserving problem** that the family's accounting has not fully surfaced. The owners are **ageing, illiquid, and without a succession plan**; they have already injected what they can and cannot fund the remaining need. The transaction is a **primary capital raise for a significant minority (or control) stake in the holding company**, where new money goes into the regulated entity as capital, priced close to (restated) book value, with the investor protected by a price-adjustment mechanism tied to an independent actuarial/asset-quality review. Owners take no proceeds. The investment case is **margin repair plus clean balance sheet**, not growth, and the return comes from re-rating the equity once reserves are clean and the book is repriced.

Internal shorthand: **"Rescue-recap with succession"** or **"funded clean-up"**.

---

## 2. Classification fields (for the desk's deal schema)

```yaml
deal_type: primary_recapitalisation_minority_or_control
sub_type: regulated_financial_rescue_recap
sector_family: [insurance, specialty_lending, consumer_finance, payments, broker_dealer, regional_bank]
reference_sector: health_insurance_specialised (ISES, Mexico)
geography_fit: [LatAm, GCC, Southern/Eastern EU, SE Asia]   # family-owned regulated businesses, thin domestic PE coverage
ticket_range_usd: 15m–60m           # sweet spot 20–40m
stake_range: 30%–70% of holding company (look-through 25–50% of opco)
instrument: new ordinary shares in holdco; often tranche 1 as convertible loan pending regulatory approval
use_of_proceeds: regulatory capital in the operating company; no secondary
pricing_anchor: restated book value (0.8x–1.6x pro-forma book); earnings multiples not usable until clean
investor_return_driver: combined/cost ratio repair + reserve clean-up → re-rating; dividends only after year 3–4
holding_period: 4–6 years
exit_routes: trade sale to strategic (regional insurer/bank), secondary to financial sponsor, recap at normalised earnings, listing (rare)
regulatory_gate: change-of-control / qualifying-holding approval for >10–20% holders (Mexico: SHCP/CNSF Art. 49 LISF; EU: ECB/NCA qualifying holding; GCC: central bank/insurance authority)
timeline_signing_to_close: 4–9 months (regulatory approval is the long pole)
fee_model: readiness/work fee (EUR 25–60k) + success fee 5–7% of capital raised; closing/execution fee credited against success fee
```

---

## 3. What this deal is NOT (so the desk doesn't mis-tag it)

- **Not a growth round.** Growth capital goes into expansion; this goes into solvency. Growth-fund investors (VC, growth equity) will decline on the combined ratio alone.
- **Not a secondary / succession sale**, even though the owners are old. Owners want liquidity but the regulator and the balance sheet won't allow it until the capital is restored. Pitching it as "owners selling" is the single most damaging framing error (see §10).
- **Not a distressed-for-control deal** in the US sense. No insolvency process, no creditor-led restructuring. The regulator is the de facto senior creditor; the business is a going concern above the solvency minimum.
- **Not a yield / dividend play.** Historic dividends are tiny (Plan Seguro: ~USD 1m/yr on USD 240m premium).

---

## 4. Signals to hunt for (sourcing heuristics)

### 4.1 Public / semi-public signals

| Signal | Where to find it | Weight |
|---|---|---|
| Regulator publishes a supervisory measure, regularisation plan, prudential measures programme, or sanction against a mid-sized private player | Regulator registers and gazettes (CNSF, SBS Peru, SFC Colombia, SUSEP Brazil, SAMA, CBUAE, CMA, EIOPA/NCA registers) | Very high |
| Solvency / capital ratio in the annual solvency report (RSCF / SFCR / Pillar 3) falls below 1.3x or shows a sharp year-on-year drop | Mandatory public solvency reports | Very high |
| Retroactive tax or accounting change hitting a whole sub-sector (e.g. Mexico LIF 2026 Art. 25 non-creditable VAT on claims) | Tax legislation trackers, Big-4 tax alerts, sector association (AMIS) bulletins | High — creates a *cohort* of targets |
| Rating agency downgrade or negative outlook of a family-owned financial (Moody's Local, Fitch, HR Ratings, S&P regional) | Rating agency press releases | High |
| Reinsurer / funding partner publicly changes terms, or a quota-share increase is announced | Reinsurance press, treaty renewal season (Jan 1 / Jul 1) | Medium |
| Multiple capital injections by existing shareholders within 12 months, visible in filed financials or registry filings | Corporate registries (KvK, RPC, Registro Mercantil), shareholder meeting minutes | High |
| Shares of the regulated entity or its holdco pledged to a lender | Pledge registries, UBO registers, notarial filings | High (illiquid owners) |
| Founder/patriarch aged 75+, no visible next-generation executive, long-tenured non-family CEO/CFO | LinkedIn, company history, press, UBO registers with DOB | Medium–high |
| Provider / supplier / counterparty complaints about late payment (hospitals suspending service, merchants, brokers) | Local press, social media, provider association notices, court filings | High |
| Rapid premium / loan-book growth (>25% p.a.) in a company with flat capital | Public financials | High (growth outrunning capital) |
| Unusual accounting basis (claims on paid/registration basis; loans on cash basis; "advances" or "other debtors" growing faster than revenue) | Audited notes, solvency reports | Very high — the hidden-liability tell |

### 4.2 Private signals (network)

- Boutique law firms and tax advisers asked for memos on "restoring creditability", "reserve methodology change", "capital plan to regulator".
- Reinsurance brokers and reinsurers (Hannover, Munich, Swiss, SCOR, Mapfre Re) aware of cedants under capital pressure.
- Local auditors (second-tier) with clients under regulatory review.
- Family-office intermediaries and company directors (the Plan Seguro mandate came via a director of the Dutch holdco).
- Appointed actuaries and actuarial consultancies (Milliman, WTW, Deloitte Actuarial) who are asked to "quantify a deficit".

### 4.3 Negative screens (don't chase)

- Solvency < 0.8x or regulator has already appointed an administrator → it's a resolution, not a recap; fees unlikely.
- Fraud indicators (auditor resignation, restatement, criminal referral).
- Owner refuses an independent actuarial / asset-quality review → cannot be sold to any institutional money.
- Capital need > 2x the company's normalised annual earnings capacity after repair → clean-up can't be funded once.

---

## 5. Anatomy of the reference case (for pattern-matching)

| Element | Plan Seguro fact |
|---|---|
| Business | Specialised health insurer (ISES), Mexico; 30 years; 150k members; 250–270 hospitals on direct-pay; 95–99% broker-distributed; expense ratio 7.6% |
| Scale | GWP MXN 4.3bn (2025, +38.6%); ~USD 240–270m |
| Shock | Nov 2025 retroactive VAT change: ~MXN 244m 2025 charge, ~MXN 280m/yr run-rate |
| Structural problem | Claims booked on paid basis; incurred loss ratio ~79% vs booked ~63%; pending provider balances MXN 1.1bn; provider "advances" MXN 1.06bn in Otros Deudores > equity MXN 663m; combined ratio ~107% incurred |
| Regulatory state | CNSF oficio 25 Jun 2026: sanction proceeding + regularisation plan (Art. 321 LISF); plan filed 16 Jul, completion report 10 Aug; solvency held at 1.01–1.02x by deferring hospital payments |
| Ownership | Family foundation (Curaçao) → Dutch BVs → Mexican holdco GSM (72.9%) → opco (74.6%); patriarch b. 1937; shares pledged; MXN 234m injected in 2026; Sept instalment missed |
| Capital need | Management USD 20–25m; restated USD 70–90m; marketed USD 22m (term sheet) / 35m (deck) |
| Structure | New shares in Dutch holdco; 49%; look-through ~27–30%; tranche 1 USD 10m convertible loan on signing; balance on SHCP approval; price adjustment to actuarial review; board seats; reserved matters; no secondary |
| Fix levers | 25% tariff increase 2027 renewals; exit of loss-making group contracts; new IBNR method; reinsurer support; VAT crediting route (upside) |
| Investor objections met | Framing inconsistency; combined ratio >100%; reserve adequacy; advances > equity; raise too small vs backlog; adviser fee from proceeds |

---

## 6. Investor universe for this archetype

### 6.1 Who actually closes these (ranked)

1. **Insurance-/financials-specialist private equity and special situations funds** — understand combined ratios, reserving, regulatory capital; price on restated book; accept 4–6 year holds. Examples by type: regional financial-services PE (LatAm, GCC), run-off and specialty insurance investors, credit-opportunity funds with equity mandates.
2. **Strategic insurers / banks seeking a licence or distribution in the geography** — often the best exit buyer and sometimes the lead investor; will pay for the licence + network; need control path.
3. **Family offices with an operating background in insurance, healthcare or financial services** — the sweet spot for USD 10–40m tickets; decide fast; need a lead or a strong independent review; want board seat.
4. **Reinsurers' strategic/venture arms and reinsurance-backed structures** — capital relief via quota share / LPT alongside equity.
5. **Development finance institutions and impact investors** (IFC, IDB Invest, FMO, BII, Proparco) — health-access angle, patient capital, regulator-friendly; slow (6–12 months) but credible.
6. **Local institutional investors and pension-adjacent funds** — only once the independent review exists.

### 6.2 Who will not (filter them out early)

- Generalist VC / growth funds; tech-only family offices; yield-seeking private credit without equity mandate; US/UK investors with no emerging-market or regulatory-capital experience; anyone who needs an EBITDA multiple to underwrite.

### 6.3 Investor qualification questions (ask before sending anything)

1. Have you invested in a regulated balance-sheet business before? Which?
2. Can you underwrite on restated book value with an actuarial adjustment, rather than on EBITDA?
3. Are you able to go through a change-of-control / qualifying-holding approval in [country] and hold through a 6–9 month approval?
4. Is a 4–6 year hold with no dividends for 3 years acceptable?
5. Ticket size and whether you lead or follow.

Two "no" answers → don't send the deck.

### 6.4 How to find them (desk tasks)

- Scrape and tag: completed deals in the sector/geography (press releases, regulator approval notices for qualifying holdings — these name the acquirer), run-off and specialty insurance transaction lists, DFI project disclosure pages (IFC/IDB Invest publish every proposed investment), reinsurer strategic investment announcements.
- Build lists of: family offices that own insurance/health assets (regulatory registers of beneficial owners), boards of regional insurers (directors often sit on family office investment committees), LPs of financials-specialist funds.
- Rank by: (a) prior regulated-financial deals, (b) geography, (c) ticket, (d) evidence of accepting minority with governance.

---

## 7. Qualification and diligence checklist (first 10 days)

**Request from management, in this order:**

1. Audited statements 5+ years with notes; latest interim; solvency reports; regulator's control figures.
2. Any regulator correspondence in the last 24 months (oficios, plans, sanction notices, acknowledgements).
3. **Claims/loans on incurred vs booked vs paid basis** — the reconciliation that reveals the true loss ratio.
4. Counterparty payables and "advances"/"other debtors" by name, with ageing, and any supplier suspensions or litigation.
5. Reserve methodology filings and the appointed actuary's reports.
6. Reinsurance / funding treaties and reconciliation.
7. Tax position (any retroactive change, settlement schedules, counsel memos).
8. Ownership chain with UBOs, pledges, shareholder loans, recent capital injections and their source.
9. Management's projection with pricing and portfolio-exit detail; sales plan for next renewal cycle.
10. Dividend history (statement of changes in equity) — including any paid during the distress period.

**Compute before talking to any investor:**

- Incurred-basis loss ratio and combined ratio, 3 years + interim.
- Restated equity = book equity − (unbooked incurred claims) − (advances that are really paid claims) ± tax effects.
- Capital need on three bases: management's; restated to 1.0x; restated to 1.3x with headroom.
- Look-through ownership of the ticket through the full chain.
- Pre-money / post-money of the entity actually issuing shares and the implied value of the operating company; multiples of pro-forma book and of revenue.
- Normalised earnings after the clean-up and the re-rated value at 8–10x.
- Each 1-point move in combined ratio in local currency and USD.

**Red-flag tests (stop and escalate if any fail):**

- Solvency ratio maintained only by deferring payments at month-end.
- Dividends paid while shareholders inject capital.
- Appointed actuary unwilling to certify "no unrecognised loss".
- Regulator "silence" presented as approval.
- Owner wants to hide the raise from management, or management from the owner.
- Capital instalments to the regulator missed.

---

## 8. Structuring template

| Term | Standard for this archetype |
|---|---|
| Issuer | Top holdco the family controls (keeps regulatory approvals at one level); or opco directly if chain dilutes look-through too much |
| Instrument | New ordinary shares; tranche 1 as interest-free convertible loan to holdco on signing, on-lent as capital; converts on regulatory approval; repayable with interest + security if approval fails within 12 months |
| Pricing | Restated book ± premium for franchise; expressed as pre/post-money of the issuer; **price adjustment** if independent review finds deficit > threshold |
| Conditions | Regulatory approval (qualifying holding); independent actuarial/AQR opinion; regulatory counsel opinion on open proceedings; DD; corporate approvals; pledgee consent; no MAC; solvency ≥ minimum at each month-end before close |
| Governance | 2 of 5 board seats at holdco + 1 at opco; reserved matters (capital, reserving methodology, regulatory filings, distributions, related parties, CEO/CFO/actuary/auditor, borrowing, M&A); monthly solvency reporting |
| Economics | No secondary; distributions suspended until solvency target + reserve clean-up; pre-emption; tag; drag after year 4 at ≥2x; exit process right at year 5 |
| Warranties / indemnities | Specific indemnities for the regulatory proceeding, retroactive tax, and pre-closing unrecognised claims |
| Counterparty | Always the corporate shareholder; never natural persons personally (owners' counsel will refuse) |
| Costs | Company pays actuary and counsel; adviser fees under separate agreements; investor bears own DD |

---

## 9. Mandate and fee structure (adviser side)

- **Readiness / work fee**: EUR 25–60k flat, paid on signature, for data room, restatement, regulatory memo, deck, NDA. Non-refundable. (Plan Seguro: EUR 35k.)
- **Success fee**: 5–7% of capital raised, payable within 10 business days of each tranche received by the client. Include "or such greater amount" and tranches explicitly. (Plan Seguro: 7%, USD 1.4m on USD 20m.)
- **Execution / transaction fee** (optional): USD 50–150k payable on **signed term sheet from a named investor**, by the **corporate** client, **credited in full against the success fee**. Put it in the engagement letter at the start; never introduce it mid-process (see §10).
- **Extension**: EUR 15–20k/month beyond the initial term.
- **Tail**: 18–24 months on introduced investors; investor list delivered to client in writing during the mandate as evidence.
- **Expenses**: travel and third-party costs pre-approved and reimbursed.
- **Entity names**: match the registry extracts exactly (KvK/RPC numbers) in every document; verify natural persons' full legal names against ID, not against organograms.

---

## 10. Lessons from the reference case (encode as desk rules)

1. **One story, frozen before first contact.** The opener said "owners getting old, selling 40–49%"; the data room said "rescue recap, primary". The lead investor declined on the inconsistency, not on the numbers. Rule: the one-paragraph snapshot, the deck and the data room must say the same thing about (a) primary vs secondary, (b) amount, (c) stake and look-through, (d) solvency, before anyone is contacted.
2. **No claim in an email that isn't already in a document you can attach.** "Regulator sign-off", "actuary commissioned", "revenue to USD 400m" each cost credibility when they ran ahead of evidence.
3. **Show the incurred-basis numbers yourself, on slide 8.** Investors who find them in the data room stop trusting the deck; investors who are shown them keep reading.
4. **Meet an investor's stated conditions with documents, not arguments.** Re-approach only when all conditions are in hand.
5. **Owners say yes on calls and their lawyers say no in letters.** Treat every verbal agreement as nothing until papered. Put fees in the engagement letter at the start; a mid-process fee request reads as a hold-up and triggers lawyer letters that build a termination record.
6. **Never condition an introduction on a fee.** It breaches the mandate's facilitation duty and hands the client cause to terminate and go direct.
7. **Look-through arithmetic first.** 49% of a holdco three levels up was ~27% of the opco, not 42%; the wrong figure went into a deck.
8. **Dividends during distress and month-end payment deferrals will be found.** Have the explanation before the question.
9. **Regulatory "silence ≠ approval".** Get regulatory counsel's written opinion on the status of any plan or proceeding; that is what institutional investors accept.
10. **Verify identities against ID documents, not charts.** Three family members shared a first name; the wrong one was named in two agreements.
11. **The success fee is the money.** Protect the mandate and the tail over any smaller fee.
12. **Deliver the data room completely and fast when the client asks for "all work product".** It is their property under the mandate, and withholding it is the cause they are looking for.

---

## 11. Desk automation hooks (what Claude Code should build)

- **Signal scrapers**: regulator registers (sanctions, supervisory measures, qualifying-holding approvals), solvency report repositories, rating agency feeds, tax-change alerts by sector, provider/supplier complaint monitoring, corporate registry filings (capital increases, pledges, director changes), obituary/age signals for UBOs.
- **Scoring model**: inputs from §4 table with weights; output a 0–100 "recap probability" and a "sellability" score (independent review feasible, solvency > 0.8x, owner cooperation).
- **Target brief generator**: one page per candidate — business, shock, structural problem, ownership chain, estimated capital need (three bases), probable investor list, first-10-days request list (§7).
- **Investor graph**: entities × (sector, geography, ticket, prior regulated-financial deals, minority tolerance, approval experience); refreshed from qualifying-holding approvals, DFI disclosures, deal press.
- **Consistency checker**: before any outbound, diff the snapshot, deck, term sheet and data-room index for amount, stake, primary/secondary, solvency figure, entity names; block send on mismatch.
- **Document templates**: NDA with non-circumvention; engagement letter with work fee + success fee + execution fee credited; indicative term sheet (§8); data-room index with gap list; incurred-vs-booked restatement workbook; regulatory position memo.
- **Process tracker**: investor conditions as checklist items with evidence attached; no re-approach until all green.
