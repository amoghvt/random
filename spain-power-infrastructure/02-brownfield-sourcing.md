# Doc 02 — Sourcing Distressed Industrial Sites (Brownfields)

**Objective:** Build a live pipeline of bankrupt, liquidating, or inactive heavy-industrial properties in Aragón and Madrid whose parcels carry (or sit beside) high-voltage infrastructure and historical `potencia contratada`.

---

## 1. Bankruptcy, Liquidation & Auction Portals

### 1.1 Official / public channels

| Portal | URL | What it is | How to filter |
|---|---|---|---|
| **Portal de Subastas — Agencia Estatal BOE** | `https://subastas.boe.es` | The central electronic auction platform for **judicial, notarial and administrative (AEAT/TGSS) auctions** — the majority of forced sales of insolvent companies' real estate pass through here | Search → «Bienes» type **«Inmueble»** → subtype **«Industrial» / «Nave» / «Solar»**; filter **Provincia: Zaragoza / Huesca / Teruel / Madrid / Guadalajara**. Read the `pliego`/edicto PDF — it often names the polígono and parcel (referencia catastral), which you geocode against your grid layer |
| **Registro Público Concursal (publicidad concursal)** | `https://publicidadconcursal.registradores.org` (a.k.a. `publicidadconcursal.es`) | Official registry of every **concurso de acreedores**: debtor name, court (Juzgado de lo Mercantil), phase (`fase de liquidación`), and — crucially — the **administrador concursal's identity and contact** | Search by province + browse recent declarations; cross-reference any company your CNAE scraper flags. This is where you get the AC's name for Doc 03 outreach |
| **BOE / BORME** | `https://www.boe.es/diario_borme/` | Statutory publication of insolvency declarations, liquidation openings, dissolutions | Search `"en liquidación"` / `"fase de liquidación"` + province; BORME «Actos inscritos» per province is machine-readable (see scraper) |
| **Sede Judicial Electrónica** | `https://sedejudicial.justicia.es` | E-filing/notification hub of the courts; auction notices link out to subastas.boe.es | Use to track specific Juzgado de lo Mercantil proceedings (Zaragoza has dedicated mercantile courts; Madrid has many) |
| **AEAT Subastas** (tax agency) & **TGSS** (social security) enforcement sales | via `subastas.boe.es` | Seized industrial assets from tax/SS debt — often *pre*-insolvency distress | Same BOE filters; these sellers are motivated and process-driven |

### 1.2 Specialized private liquidation marketplaces

| Portal | URL | Notes |
|---|---|---|
| **Eactivos** | `https://www.eactivos.com` | Major *entidad especializada* appointed by mercantile courts to liquidate estates. Category filters: **«Inmuebles» → «Naves industriales» / «Suelo industrial»**; province facets. Lots frequently include machinery + the property + sometimes the **transformer/substation as an asset line-item** — read lot inventories carefully |
| **Escrapalia (Surus Inversa)** | `https://www.escrapalia.com` | Industrial auctions incl. whole plants, electrical equipment, decommissioning sales — a *leading indicator*: a company auctioning its transformers is about to have a dead site with a live connection |
| **Activos Concursales** | `https://www.activosconcursales.com` | Aggregator/marketplace of insolvency assets; filter «Naves industriales», subscribe to province alerts |
| **Trademat** | `https://www.trademat.es` (verify) | Industrial asset liquidation marketplace (machinery + property lots) |
| **Addmeet** | `https://www.addmeet.com` | Off-market/institutional property auctions incl. `suelo industrial`; used by banks and servicers |
| **Bank servicers / REO portals** | Aliseda, Servihabitat, Haya/Anticipa, Solvia, diGlo (Santander) | Post-2008 legacy industrial REO; search «nave industrial» + province on each |
| **Generalist portals (fast recon)** | `idealista.com`, `fotocasa.es`, `belbex/CBRE`, `naves.com` | Query strings: `nave industrial subestación`, `nave con potencia contratada`, `antigua fábrica`, filter by polígono. Sellers occasionally advertise kV/kW figures directly — instant qualifiers |
| **SEPES** (public land agency) & regional equivalents (Aragón Plataforma Logística, IVIMA/Madrid) | `https://www.sepes.es` | Public industrial land sales — greenfield fallback near the same SETs |

**Filtering workflow (applies to all portals):**
1. Asset type = `nave industrial` / `suelo industrial` / `complejo industrial`.
2. Province ∈ {Zaragoza, Huesca, Teruel, Madrid, Guadalajara}.
3. Extract `referencia catastral` from the listing/edicto → resolve parcel on `sedecatastro.gob.es` → check surface, `uso industrial`, year built.
4. Geocode → distance to nearest SET/LAT from your Doc 01 QGIS layer. **Keep if ≤ ~3–5 km from ≥ 45 kV, or if the listing itself mentions a CT/SET on-site.**
5. Pull the company behind the asset (BORME/Registro Mercantil) → historical CNAE → estimate legacy load (paper mill ≈ 10–50 MW; chlor-alkali ≈ 20–100 MW; brick/ceramic kiln ≈ 2–10 MW mostly gas but with meaningful electrical + a grid position; foundry/steel ≈ 10–80 MW).

---

## 2. Target Industrial Geographies

### 2.1 Aragón (Zaragoza-centric)

| # | Polígono / zone | Municipality | Legacy profile / power angle |
|---|---|---|---|
| 1 | **Polígono Industrial Malpica** | Zaragoza (east) | Zaragoza's classic heavy-industry estate — chemicals, metal transformation, paper converting; mature 45/66 kV distribution, aging plants → liquidation churn |
| 2 | **Polígono de Cogullada** | Zaragoza (north) | One of the oldest estates (1960s); food-industrial + manufacturing legacy, embedded CTs everywhere |
| 3 | **PLAZA (Plataforma Logística de Zaragoza)** | Zaragoza (southwest, airport) | Iberia's largest logistics platform; fewer bankruptcies but strong grid build-out and land liquidity — good for the JV/flip comp story |
| 4 | **Figueruelas / Entrerríos corridor** | Figueruelas–Pedrola | Stellantis (ex-GM/Opel) ecosystem; supplier plants with heavy connections; watch tier-2 supplier insolvencies |
| 5 | **PTR López Soriano (Parque Tecnológico del Reciclado)** | Zaragoza (southeast) | Recycling/industrial park on the 400/220 kV Ebro corridor — already a declared data-center magnet; land + capacity narrative pre-validated |
| 6 | **El Burgo de Ebro / La Cartuja** | south-east Ebro axis | SAICA paper complex + former La Cartuja area; paper-industry suppliers and converters around it are prime targets (paper = high MW legacy) |
| 7 | **Monzón (Polígonos Armentera/Paúles) & Sabiñánigo** | Huesca | Electro-chemical heritage (chlor-alkali, chlorates — Ercros lineage): the single richest source of oversized grandfathered connections in Aragón; several units downsized/closed |
| 8 | **Andorra (Teruel) mining-power basin** | Andorra–Sierra de Arcos | 1.1 GW coal plant closed → Just-Transition node; surrounding industrial land + released 400 kV capacity |

### 2.2 Madrid — Henares Corridor & southern ring

| # | Polígono / zone | Municipality | Legacy profile / power angle |
|---|---|---|---|
| 1 | **Corredor del Henares — Coslada/San Fernando** | Coslada, San Fernando de Henares | Oldest logistics-industrial belt in the region; obsolete naves with disproportionate legacy connections |
| 2 | **Torrejón de Ardoz (Casablanca, Las Monjas)** | Torrejón de Ardoz | Mixed heavy manufacturing legacy; corridor already hosts hyperscale DCs → utility familiarity |
| 3 | **Alcalá de Henares (La Garena, Azuqueca fringe)** | Alcalá de Henares → Azuqueca de Henares (GU) | Manufacturing (ex-electronics, chemical) transitioning to logistics; Guadalajara continuation (Azuqueca, Cabanillas, Marchamalo) is the active DC frontier |
| 4 | **Cobo Calleja** | Fuenlabrada | Largest industrial estate in southern Madrid; older plants cycling out |
| 5 | **Getafe (Los Olivos, San Marcos, El Lomo)** | Getafe | Aerospace/metal heavy industry (Airbus ecosystem); supplier insolvencies carry real MW |
| 6 | **Arganda del Rey (Polígono Industrial de Arganda)** | Arganda del Rey | Chemical/plastics/metal legacy on the A-3; classic mid-size brownfield hunting ground |
| 7 | **Villaverde & Vicálvaro** | Madrid capital | Historic steel/automotive (ex-Boetticher, ex-Marconi) and former cement works — urban-industrial parcels with serious embedded grid |
| 8 | **Pinto–Valdemoro–Ciempozuelos axis** | south A-4 | Aging light-heavy industry over the 220 kV southern ring |

---

## 3. Company-Level Screening (feeds the scraper)

**Target CNAE 2009 codes (heavy consumers):**

| CNAE | Sector |
|---|---|
| 17.11 / 17.12 / 17.2x | Pulp & paper / paper articles (papeleras) |
| 20.1x – 20.6x | Industrial chemicals (químicas) |
| 23.2 / 23.3x / 23.5x / 23.6x | Refractories, **bricks & ceramic tiles (ladrilleras/cerámicas)**, cement/lime, concrete |
| 24.1x – 24.5x | Basic metals: steel, foundries (fundiciones, siderurgia) |
| 25.x | Fabricated metal (larger plants only) |
| 27.x | Electrical equipment manufacturing |
| 38.3x | Recycling/valorization (shredders = big MW) |
| 10.8x / 11.x (selective) | Sugar/malt/beverage plants (evaporation loads) |

**Status flags:** `En liquidación`, `Concurso de acreedores`, `Inactiva`, `Extinguida (con inmueble retenido)`, `Cierre de hoja registral`.

**Directory sources for the scraper** (`tools/cnae_liquidation_scraper.py`): company directories that expose CNAE + status + province in list pages — e.g., **Infocif**, **El Economista (Ranking de Empresas)**, **Expansión directorio**, **Axesor/eInforma** (paid API — cleanest data), plus **BORME** (official, free, machine-readable) as ground truth. The script ships with a pluggable `DirectoryAdapter` so each portal's selectors/params are placeholders you fill per target — check each site's terms of service and robots.txt, and prefer official/paid APIs (BORME open data, eInforma API) for production runs.

---

## 4. Triage Scorecard (run every lead through this)

| Dimension | 0 pts | 5 pts | 10 pts |
|---|---|---|---|
| Historical power | < 2 MW | 2–10 MW | > 10 MW documented (`6.2TD+` tariff, own SET) |
| CUPS status | Extinguished > 3 yrs | Recently deactivated | **Live/maintained contract** |
| Distance to ≥ 220 kV SET | > 10 km | 3–10 km | < 3 km or on-site |
| Node capacity (REE/DSO map) | 0 MW & saturated | Pending applications | Available MW or Just-Transition released |
| Legal state | Pre-insolvency chaos | Concurso, liquidation phase | Clean liquidation w/ cooperative AC or direct owner |
| Land | < 2 ha, contaminated unpriced | 2–10 ha, known remediation | > 10 ha, remediation bounded or done |
| Water/fiber adjacency | none | one | both (canal/river rights + backbone route) |

**≥ 45/70 → issue Doc 03.1 email within 48 h.**
