# Doc 04 — Regulatory Annex & Due-Diligence Checklist (Above-and-Beyond)

This annex covers what Tasks 1–3 assume but don't spell out: **whether the grandfathered power position actually survives the transaction**, and everything else that must be verified before the option premium goes hard or the package is shown to a fund.

---

## 1. The Legal Reality of "Grandfathered" Power in Spain

The thesis lives or dies on Spanish access-and-connection law. Key instruments (verify current consolidated versions on `boe.es` — this regime is amended frequently):

| Instrument | Relevance |
|---|---|
| **Ley 24/2013, del Sector Eléctrico** | Framework: access/connection permits, supply contracts, distribution obligations |
| **RD 1183/2020** (acceso y conexión) | The core access-and-connection regime for generation *and demand*; capacity publication duties; **lapse (caducidad) rules for permits** |
| **RD 1955/2000** + **RD 1048/2013** | Connection infrastructure, `derechos de extensión/acceso`, who owns dedicated lines |
| **Circular CNMC 1/2021** (and successors) | Methodology for calculating and publishing access capacity — this is what makes the REE/DSO maps exist |
| **RDL 1/2020 (Texto Refundido de la Ley Concursal)** | Sale of assets/going-concern units in insolvency; judicial authorization; **art. 222 ff. transmission of contracts within a *unidad productiva*** |
| **Código Civil art. 1454** | Arras penitenciales (the refundable-deposit mechanics in Doc 03.2) |
| **RD-l 8/2023 y normativa de "demanda" posterior** | Recent reforms increasingly regulate *demand* access (data centers) incl. capacity tenders (`concursos de demanda`) — track MITECO/CNMC consultations continuously |

### 1.1 What actually transfers, and how (the three channels)

1. **Live supply contract + CUPS (best case).** If the supply point still has an active contract, the buyer of the property can generally **subrogate** into the supply contract (`subrogación en el contrato de suministro`) — the classic way legacy `potencia contratada` changes hands with the real estate. Keep the contract alive through closing (Doc 03.2, clause 2 covenant).
2. **Recently terminated supply (recoverable window).** After termination, the **`derechos de extensión`** attached to the point survive for a limited period (historically 3 years for LV/SMEs and shorter/negotiated for HV points under RD 1048/2013 — **verify the exact current window per voltage level with the DSO**). Within that window a new owner can re-contract up to the historical power **without paying new extension charges and, critically, without re-queuing for access capacity** at a saturated node.
3. **Dead point (worst case).** Rights lapsed → you are a new access applicant under RD 1183/2020 at whatever the node's published capacity is, possibly into a **demand capacity tender**. The "brownfield premium" is gone; underwrite as greenfield.

**Diligence implication:** the *date of supply-contract termination* is the single most valuable data point in the whole pipeline. Get it in writing (Doc 03.1, question 1) and verify independently via the DSO / Datadis before any money moves.

### 1.2 Insolvency-specific angles

- Buying the site as part of a **`unidad productiva`** (going-concern unit) can carry contracts — including the electricity supply contract — with it by operation of the TRLC, with judicial sanction. Sometimes the *unidad productiva* route preserves the power position better than a bare real-estate purchase. Ask the AC which perimeter the plan contemplates.
- Options/exclusivity granted by an AC outside the approved liquidation plan are voidable — always condition on judicial conformity (Doc 03.2, clause 9).
- Watch **separate auction of transformers/switchgear** (escrapalia-type sales) *before* the property sale — it guts the site. If spotted, move immediately or bid the equipment lot yourself.

### 1.3 Regulatory risks to price into every deal

- **Anti-hoarding drift:** Spain is actively tightening rules against capacity reservation without real projects (both generation and, increasingly, demand). Expect utilization commitments, milestones or tenders on big allocations. The flip must be to a buyer who will actually build.
- **Municipal layer:** data-center use may require `licencia urbanística`/compatibility with the polígono's `uso industrial`; Aragón offers **PIGA/Proyectos de Interés General de Aragón** fast-tracking for large projects — a genuine value-add in the package.
- **Environmental:** former chemical/paper sites carry soil-contamination declarations (`suelo contaminado`, Ley 7/2022). A `declaración de suelo contaminado` on the finca registral is discoverable via nota simple — check before outreach, not after.

---

## 2. Full Site Due-Diligence Checklist

### Phase A — Desktop (pre-outreach, cost ≈ 0)
- [ ] Nota simple registral (Registro de la Propiedad) — ownership, charges, embargoes, contamination annotations
- [ ] Catastro: parcel geometry, `uso`, built surface, year
- [ ] REE/DSO node capacity at nearest SETs (Doc 01) + distance measurement
- [ ] Registro Público Concursal: proceeding phase, AC identity
- [ ] BORME history: CNAE, capital, prior names (old ERZ-era supply contracts hide under prior denominations)
- [ ] Datadis / consumption footprint sanity-check of claimed historical MW
- [ ] Google Earth historicals: substation visible? transmission towers on parcel? cooling ponds?

### Phase B — Engagement (post first call)
- [ ] Written confirmation: CUPS(s), potencia contratada, tariff, contract status & termination date
- [ ] Utility invoices (last 24 months of operation) — the hard evidence of the power position
- [ ] Ownership perimeter of electrical assets (company-owned SET vs DSO-owned)
- [ ] `Derechos de extensión` vigency letter from DSO (or authorization to request it — Doc 03.2 clause 7)
- [ ] Liquidation plan text + envisaged sale mechanism
- [ ] Environmental reports / activity licence file at the ayuntamiento

### Phase C — Pre-hardening (before premium goes non-refundable / before flip)
- [ ] Formal DSO/REE `consulta de viabilidad` for target MW at the point
- [ ] Legal opinion (Spanish counsel): transferability of the specific position + concursal clean-title (purchases from liquidation convey free of charges — a selling point to funds)
- [ ] Phase-1 (and if flagged, phase-2) environmental assessment
- [ ] Urbanístico report: compatibility of data-center use, buildability, height, PIGA eligibility (Aragón)
- [ ] Water & fiber: canal/river concessions, backbone routes (Zaragoza: A-2/A-68 fiber axes; Henares: the Madrid–Barcelona backbone)
- [ ] Package data room assembled (see §3)

---

## 3. The Flip Package (what infrastructure PE actually pays for)

A fund underwrites **evidence, not narrative**. The sellable package per site:

1. Registered option deed (escritura + Registro de la Propiedad entry) with assignment clause — *site control*
2. Grid dossier: CUPS history, invoices, DSO vigency letters, viability consultation response, node capacity extract with date — *power control*
3. Clean-title path memo (concursal purchase mechanics + judicial authorization status)
4. Environmental & urbanístico reports with bounded remediation cost
5. Development concept: MW roadmap (retained legacy MW → expansion via node), indicative single-line diagram
6. Pipeline context: the tracker (`tools/pipeline_tracker_template.csv`) showing this is a *program*, not a one-off — that's what earns the JV multiple rather than a finder's fee

**Exit structures, in ascending value:** (a) straight assignment of the option (cesión) for a fee; (b) back-to-back exercise-and-sale at closing; (c) JV/promote: contribute the option to a NewCo with the fund, retain 10–20% carried position + development-management agreement.

---

## 4. Program Cadence

| Rhythm | Action |
|---|---|
| Weekly | Re-pull DSO/REE capacity files (they change monthly); diff against tracker; scraper sweep of BORME new liquidations in the 5 provinces |
| Per lead | 48 h from triage-pass to Doc 03.1 email; 2 weeks to discovery call; 6 weeks to LOI |
| Monthly | Review MITECO/CNMC consultations on demand access & capacity tenders (regime risk); review Just-Transition node allocations (Andorra) |
| Quarterly | Refresh polígono target list from auction-portal churn; prune dead leads |
