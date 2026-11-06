# Skill: Hunter

Purpose: find companies that will need EGP's help before they know it, with proof.

## Inputs
- Region(s) and sector focus for this sweep (default: all three regions, ICP sectors)
- Exclusions: companies already in `db/deals.json` unless re-sweeping for new signals

## Sources, in order of signal quality

**Regulator actions (highest signal)**
- Mexico: CNSF (insurers), CNBV (banks/SOFOMs), CONDUSEF sanctions; SAT tax rulings reported in press
- Colombia: Superintendencia Financiera; Chile: CMF; Peru: SBS; Brazil: SUSEP/BCB; Argentina: SSN
- GCC: SAMA, CBUAE, UAE Insurance Authority/CBUAE insurance, DFSA, ADGM FSRA, Saudi CMA & Insurance Authority, Qatar QCB/QFCRA
- EU: BaFin, FMA (AT), DNB/AFM, CSSF, CNMV/DGSFP (ES), IVASS/Consob, KNF (PL); EIOPA solvency warnings
- Search patterns: "capital shortfall", "solvency", "requerimiento de capital", "intervención", "Kapitalerhöhung angeordnet", "Solvency II breach", "suspensión de operaciones", exchange suspensions

**Pre-insolvency and restructuring registers**
- Germany: StaRUG, Schutzschirm, Eigenverwaltung filings (press: Handelsblatt, Deutsche Unternehmerbörse, FINANCE-Magazin, Restructuring-News)
- Netherlands: WHOA; Spain: pre-concurso (Expansión, Cinco Días); Austria: ReO/Sanierungsverfahren (KSV1870, AKV); UK: restructuring plans
- Mexico/LatAm: concurso mercantil filings, IFECOM

**Rating actions**
- Fitch, Moody's, S&P, Capital Intelligence (GCC), HR Ratings & Verum (MX): downgrades, negative watch, withdrawn ratings, "capital adequacy" language

**Market structure signals**
- Auditor resignations or qualified opinions; late annual filings; delisting/suspension notices
- Bond/Schuldschein maturity walls 2026–27 with no refinancing announced
- PE portfolio companies held 6+ years (fund past its term); family groups with public succession stories
- Claims shocks, tax rulings, litigation losses, regulatory fines reported in press

**Human sources (the ones that actually produce mandates)**
- Restructuring and insurance-regulatory law firms; mid-market auditors; insurance/actuarial consultants; ex-regulators turned advisers; turnaround managers (Sachwalter, CROs); family-office advisers. Map them by region into `db/intermediaries.json`.

## Method
1. Run searches region by region, signal type by signal type. Use extended search for registers and rating actions. Fetch the actual source page for every candidate.
2. Reject: companies in formal liquidation; companies too small (< USD 10M need) or too large (bulge-bracket territory, > USD 200M need unless family-owned and bank-shy); anything without a retrievable source.
3. Write `sweeps/<region>-<date>.md` with, per candidate: company, country, sector, size (sourced), signals (dated, URLs), ownership/decision-maker, likely need (band, type), why banks avoid it, intermediaries seen in sources, preliminary fit 1–5, sources.
4. Hand to Analyst.

## Standard
A candidate with one verified strong signal beats five with speculation. Never invent a name, figure or person. Mark anything uncertain "unverified".
