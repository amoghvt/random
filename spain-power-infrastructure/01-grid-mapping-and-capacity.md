# Doc 01 — Grid Mapping & Node Capacity Discovery (Spain)

**Objective:** Locate transmission and distribution nodes in Aragón and Madrid with available **demand access capacity** (`capacidad de acceso para demanda`), so every land target is anchored to a verifiable grid position.

Spain's system splits cleanly in two:

- **Transmission (≥ 220 kV, plus some 132/110 kV):** operated by **Red Eléctrica de España (REE / Redeia)** — the TSO. Large data-center loads (> ~50 MW) usually connect here or at a transmission-distribution boundary node.
- **Distribution (≤ 132 kV):** operated by regional **DSOs (distribuidoras)** — e-distribución (Endesa), i-DE (Iberdrola), UFD (Naturgy), E-Redes, etc. Legacy industrial sites almost always hang off these networks at 15/20/45/66/132 kV.

---

## 1. Red Eléctrica de España (REE) — Transmission-Level Discovery

> URLs below were correct as of research date; REE reorganizes its site periodically. If a path 404s, search the term in quotes on `ree.es` or Google `site:ree.es "<term>"`.

### 1.1 Demand Access Capacity Maps (`Capacidad de acceso para demanda`)

REE publishes nodal access capacity for **both generation and demand** under the RD 1183/2020 access-and-connection regime. The demand-side publication is the one that matters for data-center siting.

**Navigation path:**

1. Go to **`https://www.ree.es`** → menu **«Clientes»** (Customer portal — `https://www.ree.es/es/clientes`).
2. Select the profile **«Consumidor»** (consumer/demand) — as opposed to «Generador».
3. Open **«Acceso y conexión»** → **«Conoce la capacidad de acceso»** / **«Capacidad de acceso disponible»**.
4. Download the periodically updated file **«Capacidad de acceso para demanda en los nudos de la red de transporte»** (Excel/PDF, per-substation, per-voltage-level MW figures). REE updates capacity publications on a regular cycle (historically monthly/quarterly) and after each planning event.
5. Cross-check the interactive layer: **ESIOS** (REE's system-operator data portal) at **`https://www.esios.ree.es`** → **«Mapas de interés»** — includes the Iberian transmission-grid map (lines, substations, voltage levels).

**What to extract per node:** substation name (`nudo`), voltage (400/220/132 kV), available MW for demand, whether capacity is `disponible`, `ocupada`, `en tramitación` (pending applications), and any flag for **concurso de capacidad** (capacity tender) — critical in Aragón, where several nodes are demand-tendered.

**Application portal:** actual access requests for transmission connection go through REE's client portal (**MiAccesoREE / Portal de servicios a clientes**, reached from the «Clientes» area). You will not file yet, but registering gives visibility into procedure documents and node datasheets.

**Planning pipeline (future capacity):** MITECO's transmission plan **«Planificación eléctrica»** (current horizon 2021–2026, with the 2025–2030 cycle in process) lists every planned substation and repotenciación. Search: `Planificación de la red de transporte de energía eléctrica MITECO` — new planned SETs near your targets are a value catalyst you can underwrite before the market prices them.

### 1.2 GIS / "Grid Intelligence" stack used by developers

| Tool | Use | Access |
|---|---|---|
| **ESIOS map viewer** (`esios.ree.es`) | Official transmission topology, real-time system data | Free |
| **REE capacity publications** (above) | Nodal MW for demand & generation | Free (Excel/PDF) |
| **Open Infrastructure Map** (`openinframap.org`) | OSM-derived worldwide HV lines & substations — fastest visual recon layer; verify against official data | Free |
| **QGIS + IGN/Catastro layers** (`qgis.org`, `ign.es`, `sedecatastro.gob.es` WMS) | Overlay substations ↔ parcels ↔ polígonos; buffer analysis (e.g., parcels ≤ 3 km from a 220 kV SET) | Free |
| **Datadis** (`datadis.es`) | Aggregated real consumption data by CUPS/zone from all Spanish DSOs — validates a site's historical load | Free registration |
| **DSO capacity maps** (Section 2) | Distribution-level nodal capacity | Free |
| Commercial grid-intelligence platforms (various vendors sell curated ES nodal databases to IPPs/funds) | Queue positions, capacity history, hearsay layer | Paid — useful later; the official sources above are sufficient for origination |

**Practical GIS workflow:** export the REE + DSO capacity tables → geocode substations (ESIOS map / OpenInfraMap coordinates) → load into QGIS → draw 3 km and 5 km buffers → intersect with Catastro industrial-use parcels (`uso: industrial`) and SIGPAC/polígono shapefiles → that intersection list *is* your hunting ground.

---

## 2. Regional DSOs (Distribuidoras) — Aragón & Madrid

Capacity at 45/66/132 kV is where legacy-industrial `potencia contratada` lives. Each DSO is legally required (Circular CNMC 1/2021 and successors) to publish network capacity maps.

### 2.1 Aragón

| DSO | Coverage | Capacity data |
|---|---|---|
| **e-distribución Redes Digitales, S.L.U.** (Endesa; historically *ERZ — Eléctricas Reunidas de Zaragoza*) | Dominant DSO across Zaragoza, Huesca, Teruel | `https://www.edistribucion.com` → **«Capacidad de acceso a la red»** / interactive **«Mapa de capacidad»** (also reachable via the *zonas/Mapa interactivo* subsite). Publishes per-substation Excel: node, voltage, available MW for demand and generation |
| **i-DE Redes Eléctricas Inteligentes, S.A.U.** (Iberdrola) | Pockets, mainly toward the Ebro valley borders with Navarra/Rioja | `https://www.i-de.es` → **«Mapa de capacidad de acceso y conexión»** |
| Small historic distributors (e.g., cooperative/municipal distributors in rural Huesca/Teruel) | Very localized | Via CNMC's registry of distributors; usually irrelevant for > 5 MW loads |

### 2.2 Madrid (Comunidad de Madrid + Henares spillover into Guadalajara)

| DSO | Coverage | Capacity data |
|---|---|---|
| **i-DE (Iberdrola)** | Most of Madrid capital and the west/north/south metro | `https://www.i-de.es` → «Capacidad de acceso» map + downloadable node list |
| **UFD Distribución Electricidad, S.A.** (Naturgy; ex-Unión Fenosa) | Large share of the Madrid region incl. the eastern/Henares side | `https://www.ufd.es` → **«Mapa de capacidad»** / «Acceso y conexión» |
| **e-distribución** (Endesa) | Marginal in Madrid, but covers **Guadalajara-adjacent Aragón side**; note the Henares corridor crosses into i-DE/UFD territory in Guadalajara province | as above |

**How to read the DSO spreadsheets:** columns typically include `Subestación (SET)`, `Nivel de tensión (kV)`, `Posición`, `Capacidad disponible demanda (MW)`, `Capacidad ocupada`, `Solicitudes en tramitación`. Zero available capacity at a node does **not** kill a brownfield play — an existing site's **grandfathered contracted power rides on its existing supply contract/CUPS**, not on new access capacity. That asymmetry is the entire thesis (see Doc 04 for transfer/lapse rules).

**Escalation channel:** every DSO runs a formal pre-application consultation. For > 5 MW ask for a **«consulta de viabilidad de acceso y conexión»** on the specific SET — responses are documented and become part of your flip package.

---

## 3. Spanish Search-Term Lexicon (registries, maps, filings)

Use these exact strings when querying REE/DSO portals, BOE/BORME, catastro, planning documents, and Google (`site:` scoped):

**Grid capacity & access**
- `capacidad de acceso para demanda`
- `capacidad de acceso disponible`
- `nudos con capacidad disponible`
- `mapa de capacidad de acceso y conexión`
- `solicitud de acceso y conexión` / `permiso de acceso y conexión`
- `concurso de capacidad de demanda` (demand capacity tenders — Aragón nodes)
- `nudos de transición justa` (Just Transition nodes — released coal-plant capacity, e.g., Andorra (Teruel))
- `IVA / consulta de viabilidad de acceso`

**Physical assets**
- `subestación eléctrica` / `SET` (substation)
- `línea de alta tensión` / `LAT` / `línea aérea de alta tensión`
- `centro de transformación` / `CT`
- `red de transporte` (transmission) / `red de distribución` (distribution)
- `nivel de tensión 400 kV / 220 kV / 132 kV / 66 kV / 45 kV`
- `posición de transformación` / `parque de 220 kV`

**Site-level power rights (the brownfield gold)**
- `potencia contratada` (contracted power on the supply contract)
- `potencia adscrita` / `potencia asignada` (allocated power)
- `derechos de extensión` (extension rights — the paid-for network capacity attached to a supply point; **check expiry**)
- `derechos de acceso` / `derechos de acometida` (access/connection-charge rights)
- `CUPS — Código Universal del Punto de Suministro` (the unique supply-point ID; a live CUPS is the anchor of the grandfathered position)
- `boletín eléctrico` / `certificado de instalación eléctrica (CIE)`
- `acometida en media/alta tensión`
- `tarifa de acceso 6.1TD / 6.2TD / 6.3TD / 6.4TD` (HV access tariffs — a site historically on 6.2TD+ was a genuinely heavy consumer)
- `expediente de acceso y conexión`
- `caducidad de los permisos de acceso y conexión` (lapse rules)

**Corporate/insolvency crossover (feeds Doc 02)**
- `en liquidación` / `concurso de acreedores` / `unidad productiva`
- `nave industrial con subestación` / `suelo industrial con potencia contratada`
- `fábrica cerrada` + `papelera` / `química` / `cerámica` / `ladrillera` / `fundición` / `siderurgia`

---

## 4. Aragón & Madrid — Transmission Geography Cheat-Sheet

High-value transmission clusters to prioritize when buffering (verify current capacity on the REE map before underwriting):

- **Zaragoza ring:** SET María, SET Peñaflor, SET Los Vientos/El Espartal area, La Cartuja (former thermal), Entrerríos/Figueruelas (Stellantis feed), Villanueva de Gállego, Escatrón/Sástago (Ebro valley 400 kV corridor with legacy thermal-plant nodes).
- **Teruel:** **Andorra 400 kV node** — Endesa's closed 1.1 GW coal plant released massive capacity, partially allocated via the Just-Transition tender; watch residual/relinquished MW.
- **Huesca:** Monzón and Sabiñánigo (electro-chemical legacy — chlor-alkali era sites with heavy historical connections).
- **Madrid east (Henares):** SET San Fernando, Coslada, Torrejón, Alcalá — plus the Guadalajara continuation (Azuqueca, Cabanillas, Yebes/Meco 400 kV area, the corridor already densely built with data centers — meaning brokers/utilities there are educated; price accordingly).
- **Madrid south:** Getafe, Fuenlabrada, Pinto, Arganda del Rey, Villaverde (industrial legacy incl. former cement/metal works).

**Next:** Doc 02 — overlay this grid layer with distressed-asset sourcing.
