# Spain Power-Anchored Brownfield Acquisition Program

**Strategy:** Secure site control (Opción de Compra with assignment rights) over distressed/inactive heavy-industrial sites in **Aragón (Zaragoza corridor)** and **Madrid (Henares Corridor + southern ring)** that hold legacy high-voltage grid connections or sit adjacent to transmission/distribution nodes with available demand access capacity — then flip or JV the de-risked site package to infrastructure PE.

**Why it works:** European data-center markets are power-constrained (7–10 year queues in FLAP-D). Spain publishes nodal demand-access capacity, has a deep pool of post-industrial sites with historical `potencia contratada`, and the option-contract structure (`contrato de opción de compra` + `cláusula de cesión`) lets you control land with minimal capital while the grid position is validated.

---

## Repository Map

| File | Contents |
|---|---|
| [`01-grid-mapping-and-capacity.md`](01-grid-mapping-and-capacity.md) | REE demand-capacity maps, DSO capacity portals (e-distribución, i-DE, UFD), GIS stack, Spanish search-term lexicon |
| [`02-brownfield-sourcing.md`](02-brownfield-sourcing.md) | Bankruptcy/auction portals with filtering workflows, target polígonos industriales in Aragón & Madrid |
| [`03-outreach/01-intro-email-administrador-concursal.md`](03-outreach/01-intro-email-administrador-concursal.md) | Bilingual (EN/ES) first-contact email to bankruptcy administrators / site owners |
| [`03-outreach/02-loi-opcion-de-compra.md`](03-outreach/02-loi-opcion-de-compra.md) | Bilingual LOI / Propuesta de Opción de Compra with exclusivity, assignment clause, and refundable-arras grid condition |
| [`04-regulatory-and-diligence-annex.md`](04-regulatory-and-diligence-annex.md) | RD 1183/2020 access & connection rules, capacity-transfer risk analysis, full site due-diligence checklist |
| [`tools/cnae_liquidation_scraper.py`](tools/cnae_liquidation_scraper.py) | Python scraper/structurer for company directories — CNAE heavy-industry codes × Aragón/Madrid × "en liquidación / inactiva" |
| [`tools/pipeline_tracker_template.csv`](tools/pipeline_tracker_template.csv) | Deal-pipeline tracker schema (site → node → capacity → legal status → outreach stage) |

---

## Operating Sequence (recommended)

1. **Map power first, land second.** Pull REE demand-capacity nodes + DSO capacity spreadsheets for Aragón/Madrid (Doc 01). Shortlist substations (`SET`) with ≥ 20–50 MVA available or recently released capacity (plant closures, *nudos de transición justa*).
2. **Overlay distressed assets.** Run the sourcing portals and the CNAE scraper (Doc 02 + `tools/`) against the shortlisted node buffer zones (≤ 3–5 km from a 45/66/132/220 kV SET).
3. **Validate the grid position** before spending on outreach: confirm the site's historical `potencia contratada`, whether the CUPS is still alive, and whether `derechos de extensión` have lapsed (Doc 04 — this is the single biggest deal-killer).
4. **Engage** the administrador concursal / owner (Doc 03.1), then move to the option contract (Doc 03.2) with the refundable-arras grid condition as your capital protection.
5. **Package and flip:** site + nota simple + capacity evidence + DSO/REE correspondence + option contract with cesión rights = the sellable "powered land" package.

---

> **Legal notice:** The templates and regulatory summaries in this repository are working drafts for commercial negotiation and research. Spanish insolvency sales require judicial/administrator involvement and the access-and-connection regime changes frequently (CNMC circulars, MITECO planning cycles). Have every contract reviewed and executed under supervision of Spanish counsel (abogado colegiado) and verify all portal URLs and capacity figures at time of use.
