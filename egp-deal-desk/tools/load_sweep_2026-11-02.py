#!/usr/bin/env python3
"""Load the 2 Nov 2026 sweep results into db/deals.json and db/intermediaries.json."""
import json, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
DB = ROOT/"db"/"deals.json"; INT = ROOT/"db"/"intermediaries.json"
deals = json.loads(DB.read_text())
have = {d["slug"] for d in deals}
S = "sweeps/{r}-2026-11-02.md"
new = [
 # slug, company, country, region, sector, size, need_band, need_type, decision_maker, intermediary, score, stage, fee, pot_fee, next_action, date, sweep
 ("schuele-druckguss","Julius Schüle Druckguss GmbH","DE","EU","auto die-casting","EUR 111M rev, ~680 staff","EUR 15-40M","rescue/succession equity","Family (since 1951); MD Michael Eidecker","Arndt Geiwitz (SGP); Martin Mucha (GRUB BRUGGER)",80,"qualified","EUR 35k readiness + 7% success + 2% equity",2000000,"Strategist: entry plan + first message to Geiwitz/Mucha","2026-11-04",S.format(r="eu")),
 ("eliance","Eliance Aviation","ES","EU","helicopter emergency services","EUR 54M rev, -EUR 24M loss","EUR 15-40M","bridge/rescue equity or sub-debt","Swiss Life AM (owner); Infranity (lender)","Watson Farley & Williams; Beka Finance",79,"qualified","EUR 35k readiness + 6% success",1900000,"Strategist: entry via WFW/Beka; owner angle to Swiss Life AM","2026-11-04",S.format(r="eu")),
 ("takween","Takween Advanced Industries","SA","GCC","packaging","SAR 400M rights issue after 68% capital cut","USD 60-110M","sub-underwriting / strategic block","Al Othman Holding (41.6%)","Albilad Capital (unverified)",79,"qualified","co-advisory with CMA-licensed AP; 3-5% on placed block",2500000,"Decide Saudi route (AP partner); then approach Al Othman","2026-11-06",S.format(r="gcc")),
 ("windmoeller","Windmöller GmbH (wineo)","DE","EU","flooring","EUR 83M rev, ~280 staff","EUR 10-25M","plan financing / minority equity","3rd-gen family; CEO Matthias Windmöller","Streitbörger (Sachwalter); GÖRG (Rhode, Taras); Wittop (Montag & Montag)",76,"qualified","EUR 25k readiness + 7% success + 2% equity",1300000,"Strategist: entry via GÖRG / Wittop","2026-11-04",S.format(r="eu")),
 ("agrocapital-noroeste","Agrocapital del Noroeste SOFOM","MX","LATAM","agri non-bank lender","MXN 1.02bn book (~USD 55M)","USD 10-20M","equity/sub-debt + refi, or run-off","Grupo Ceres (family agri group)","PCR Verum analyst; development-bank workout desk",74,"qualified","EUR 25k readiness + 7% success",1100000,"Strategist: Grupo Ceres principals; bundle with Agropecuaria Financiera / FINDECA","2026-11-05",S.format(r="latam")),
 ("gulf-general","Gulf General Cooperative Insurance","SA","GCC","insurer","Losses 96% of capital; BlueFive ~USD 34M recap pending","USD 30-60M","co-invest / backstop","Listed; BlueFive Capital anchor-to-be","A&O Shearman; AS&H Clifford Chance; SNB Capital; GIB Capital",72,"qualified","co-investment via EGP investors",1500000,"After Saudi route decision: approach BlueFive advisers for co-invest slot","2026-11-10",S.format(r="gcc")),
 ("gilmar","Gilmar S.p.A. (Iceberg)","IT","EU","fashion","EUR 37.2M debt; 256 staff","EUR 10-25M","equity partner + real-estate monetisation","Gerani family (100%)","Court-appointed esperto; Tribunale di Rimini",72,"qualified","EUR 25k readiness + 7% success",1000000,"Strategist: identify esperto; approach before 24 Nov hearing","2026-11-05",S.format(r="eu")),
 ("acig","Allied Cooperative Insurance Group","SA","GCC","insurer","Losses 46% of capital; IA directive to reach SAR 300M","USD 50-80M","placed strategic equity (pre-emptive rights waived)","Listed board; no adviser named","Lux Actuaries / Badri (appointed actuary route)",71,"qualified","co-advisory with CMA-licensed AP",2000000,"After Saudi route decision: direct approach to board / actuary","2026-11-10",S.format(r="gcc")),
 ("booster","BOOSTER Precision Components Holding","DE","EU","auto turbo components","EUR 162M rev; 7% equity; EUR 40.5M bond","EUR 15-40M","new money + equity post-StaRUG","Owner not disclosed","Nordic Trustee; ad-hoc bondholder group; iron AG",71,"qualified","EUR 35k readiness + 6% success",1500000,"Identify owner/GP; approach after 28 Nov bond maturity resolution","2026-11-12",S.format(r="eu")),
 ("cruz-suiza","Cruz Suiza Compañía de Seguros","AR","LATAM","P&C insurer","Capital deficit ARS 48.6M; SSN regularisation plan","USD 5-15M","recap","Marcelo Figueiras & José Urtubey (owners)","Abeledo Gottheil (Ponferrada)",71,"qualified","EUR 25k readiness + 7% success",600000,"Strategist: direct approach to Figueiras via Richmond; small ticket, high probability","2026-11-06",S.format(r="latam")),
 # Watch
 ("abo-energy","ABO Energy GmbH & Co. KGaA","DE","EU","renewables developer","2025 loss ~EUR 170M; EUR 240M syndicate","EUR 50-100M","equity/mezz","Founder-family GP (unverified)","Hübner Management (CRO); Dentons; Rothschild; BCG; Noerr",66,"qualified","",0,"Watch: standstill cliff 30 Nov; crowded with advisers","2026-12-01",S.format(r="eu")),
 ("aman-takaful","Dubai Islamic Insurance & Reinsurance (AMAN)","AE","GCC","takaful","MCR deficit AED 58.6M; qualified review","USD 20-60M","portfolio sale + sponsor","DFM-listed; shareholders unnamed","Crowe Mak (auditor); prior bidders Salama, ADNTC",69,"qualified","",0,"Watch: diligence unit-linked book before any approach","2026-11-20",S.format(r="gcc")),
 ("amana-insurance","Amana Cooperative Insurance","SA","GCC","insurer","Capital SAR 430M -> 301M; FA to be appointed","USD 20-40M","recap / merger partner","Listed","None yet",62,"qualified","",0,"Watch: FA appointment","2026-11-20",S.format(r="gcc")),
 ("enaya","Saudi Enaya Cooperative Insurance","SA","GCC","health insurer","Three recap routes rejected by shareholders","USD 40-65M","placed block to swing EGM, or licence sale","Listed, fragmented register","Wasatah Capital; Al Tamimi",60,"qualified","",0,"Watch","2026-12-01",S.format(r="gcc")),
 ("chemanol","Methanol Chemicals Co. (Chemanol)","SA","GCC","petrochemicals","SAR 622M rev; SAR 350M rights issue","USD 90-150M","rights issue backstop + refi","Listed","Albilad Capital (incumbent)",58,"qualified","",0,"Watch","2026-12-01",S.format(r="gcc")),
 ("insurance-house","Insurance House PJSC","AE","GCC","insurer","Losses 115% of capital; LOI received Jan 2026","USD 10-35M","equity / change of control","ADX-listed; largest shareholder (unnamed)","Deloitte (appointed actuary)",58,"qualified","",0,"Watch","2026-12-01",S.format(r="gcc")),
 ("christof","Christof Industries Austria","AT","EU","plant engineering","Liabilities EUR 62.6M; 180 staff","EUR 10-15M","quota / plan financing","FMT Industrieholding; Johann Christof","Stefan Weileder (administrator); AKV; KSV1870",58,"qualified","",0,"Watch: plan vote 1 Dec","2026-11-25",S.format(r="eu")),
 ("photon-energy","Photon Energy N.V.","NL","EU","solar IPP/EPC","EUR 78.8M bond 2027; coupon deferred","EUR 30-80M","bond restructuring + new money","Listed","Schirp Schmidt-Morsbach; Robus",55,"qualified","",0,"Watch","2026-12-15",S.format(r="eu")),
 ("cruz-blanca-bupa","Isapre Cruz Blanca (Bupa Chile)","CL","LATAM","health insurer","CLP 316.6bn Supreme Court liability, 12% repaid","USD 50-100M+","owner exit / run-off","Bupa (UK)","Carey; Estudio Carvallo",56,"qualified","",0,"Watch: Bupa strategy signals","2026-12-15",S.format(r="latam")),
 ("patria-isapres","Isapre Vida Tres / Banmédica (Patria)","CL","LATAM","health insurers","Loss-making; under new PE owner","USD 30-80M","co-invest / minority recap","Patria Investments; Linzor","Carey",55,"qualified","",0,"Watch","2026-12-15",S.format(r="latam")),
 ("kubo","Kubo Financiero (GEMA)","MX","LATAM","SOFIPO","Post-merger; NPL 16.9%","USD 10-30M","follow-on growth equity / Tier-2","Oliver Fernández (GEMA, chair); Gerardo Piña (CEO)","Amsofipo",55,"qualified","",0,"Watch","2026-12-01",S.format(r="latam")),
 ("galeno","Grupo Galeno","AR","LATAM","prepaga + hospitals","ART licence revoked Feb 2026; group >12k staff","USD 30-100M","recap / partial sale","Julio Fraomeni","Abeledo Gottheil; UART",52,"qualified","",0,"Watch","2026-12-15",S.format(r="latam")),
]
for r in new:
    slug=r[0]
    if slug in have: continue
    deals.append({"slug":slug,"company":r[1],"country":r[2],"region":r[3],"sector":r[4],"size_note":r[5],"signals":[],"need_band_usd":r[6],"need_type":r[7],"decision_maker":r[8],"intermediary":r[9],"score":r[10],"stage":r[11],"fee_proposed":r[12],"potential_fee_usd":r[13],"last_contact":"","next_action":r[14],"next_action_date":r[15],"brief":"","notes":f"Sourced 2026-11-02; full entry with URLs in {r[16]}","sources":[r[16]]})
DB.write_text(json.dumps(deals, indent=2, ensure_ascii=False))

inter = [
 # name, firm, type, region, country, why, url
 ("Arndt Geiwitz","SGP Schneider Geiwitz","turnaround","EU","DE","Sachwalter on Schüle Druckguss and Himolla 2026","https://www.sgp.de"),
 ("Martin Mucha","GRUB BRUGGER","law","EU","DE","Generalbevollmächtigter Schüle Druckguss","https://www.grub-brugger.de"),
 ("Holger Rhode / Raul Taras","GÖRG","law","EU","DE","Windmöller Schutzschirm counsel; Northern Fiber StaRUG","https://www.goerg.de"),
 ("Frederik Wittop","Montag & Montag","turnaround","EU","DE","CFO/CRO at Windmöller","https://www.montag-montag.de"),
 ("Tillmann Peeters","Falkensteg Restructuring","turnaround","EU","DE","CRO at Himolla","https://www.falkensteg.com"),
 ("","FTI-Andersch","consulting","EU","DE","IDW S6 Sanierungsgutachten leader (Branicks)","https://www.fti-andersch.com"),
 ("Andreas Ziegenhagen","Dentons Germany","law","EU","DE","Bondholder joint representative ABO Energy","https://www.dentons.com"),
 ("","KSV1870 / AKV Europa","creditor association","EU","AT","First public source on every Austrian Sanierungsverfahren","https://www.ksv.at"),
 ("Omar Salah","Norton Rose Fulbright Amsterdam","law","EU","NL","WHOA lender-side (Royal IHC)","https://www.nortonrosefulbright.com"),
 ("","Watson Farley & Williams Madrid","law","EU","ES","Advised Eliance on refinancing","https://www.wfw.com"),
 ("","Beka Finance","debt adviser","EU","ES","Structured Eliance fleet financing","https://www.bekafinance.com"),
 ("","Adara Legal","law","EU","ES","Plan de reestructuración boutique (Santiveri, IMASA)","https://adaralegal.es"),
 ("Riccardo Ranalli / Paolo Bastia","Court-appointed esperti","expert","EU","IT","Composizione negoziata experts (Aeffe, TFM)",""),
 ("Yves Hayaux-du-Tilly","Nader, Hayaux y Goebel","law","LATAM","MX","Band 1 insurance Mexico","https://chambers.com/legal-rankings/insurance-mexico-9:33:144:1"),
 ("","Creel, García-Cuéllar, Aiza y Enríquez","law","LATAM","MX","Band 2 insurance and restructuring",""),
 ("","Sainz Abogados","law","LATAM","MX","Band 1 restructuring Mexico",""),
 ("","PCR Verum","rating","LATAM","MX","Publishes every SOFOM/SOFIPO downgrade with analyst names","https://pcrverum.mx"),
 ("","HR Ratings","rating","LATAM","MX","Mid-market financial ratings","https://www.hrratings.com"),
 ("Alfonso Novelo / Sebastián del Río","AM Best Mexico","rating","LATAM","MX","Authors of the VAT segment report","https://news.ambest.com"),
 ("Luis Matías Ponferrada","Abeledo Gottheil","law","LATAM","AR","Insurance regulatory; SSN cohort","https://www.globalinsurancelaw.com"),
 ("Rafael Alcázar","Rebaza, Alcázar & De Las Casas","law","LATAM","PE","Band 1 restructuring Peru (Acceso Crediticio)",""),
 ("","Carey / Estudio Carvallo","law","LATAM","CL","Band 1 insurance Chile",""),
 ("","Demarest / Mattos Filho","law","LATAM","BR","Band 1 insurance Brazil",""),
 ("","Lux Actuaries","actuarial","GCC","SA","IA-licensed appointed actuary to Saudi insurers","https://luxactuaries.com"),
 ("","Albilad Capital","financial adviser","GCC","SA","FA/underwriter Chemanol, Takween; CMA-licensed AP","https://www.argaam.com/en/article/articledetail/id/1867571"),
 ("","Wasatah Capital","financial adviser","GCC","SA","FA to Enaya; CMA-licensed AP",""),
 ("","Estedemah Capital","financial adviser","GCC","SA","FA to Salama on Enaya merger",""),
 ("","SNB Capital / GIB Capital","financial adviser","GCC","SA","FAs on GGI/BlueFive recap",""),
 ("","A&O Shearman Dubai/Riyadh","law","GCC","AE","Band 1 UAE restructuring; counsel to BlueFive on GGI",""),
 ("","AS&H Clifford Chance","law","GCC","SA","Counsel to GGI",""),
 ("","Al Tamimi & Company","law","GCC","AE","Saudi insurer M&A counsel (Enaya)","https://www.tamimi.com"),
 ("","Hadef & Partners","law","GCC","AE","Onshore UAE restructuring (KBBO, Drake & Scull)","https://hadefpartners.com"),
 ("James Dervin","Alvarez & Marsal Riyadh/Dubai","turnaround","GCC","SA","Mid-to-distressed turnaround, interim CRO",""),
 ("","Deloitte ME Business Restructuring","consulting","GCC","AE","Appointed actuary Insurance House; KBBO restructuring",""),
 ("","Crowe Mak","audit","GCC","AE","Auditor to AMAN (qualified review)",""),
 ("","Investcorp Golden Horizon","co-investor","GCC","AE","~USD 350M to deploy into GCC family businesses by mid-2028","https://www.qatarwallstreet.com/business/investment/investcorp-750m-fund-targets-gcc-family-firms/2026/07/01/"),
]
INT.write_text(json.dumps([{"name":n,"firm":f,"type":t,"region":rg,"country":c,"why":w,"url":u,"relationship":"none","last_contact":"","referrals":[]} for n,f,t,rg,c,w,u in inter], indent=2, ensure_ascii=False))
print(len(deals),"deals;",len(inter),"intermediaries")
