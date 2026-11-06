# Deal database schema (`db/deals.json`)

Array of records:

```json
{
  "slug": "plan-seguro",
  "company": "Plan Seguro S.A.",
  "country": "MX",
  "region": "LATAM",
  "sector": "health insurance",
  "size_note": "~USD 260M premiums (source)",
  "signals": [{"date": "2026-09-14", "signal": "VAT ruling + post-COVID claims, ~USD 39M 2026 impact", "url": ""}],
  "need_band_usd": "20-40M",
  "need_type": "recapitalisation",
  "decision_maker": "Cecil Chellew (President, Biltmore)",
  "intermediary": "Mike (introducer)",
  "score": 92,
  "stage": "term_sheet",
  "fee_proposed": "EUR 35k readiness + 7% success",
  "potential_fee_usd": 1580000,
  "last_contact": "2026-10-28",
  "next_action": "Term sheet to Juan Carlos Cerda",
  "next_action_date": "2026-11-04",
  "brief": "deals/plan-seguro/brief.md",
  "notes": "",
  "sources": []
}
```

Optional fields: `archetype` (`rescue_recap_succession` | `insolvency_process` | `rights_issue_backstop` | `growth`), `deal_type`, `sub_type` (playbook §2 values), `recap_probability` (0–100), `sellability` (one line), `snapshot` (`deals/<slug>/snapshot.json`, the frozen story checked by `tools/consistency_check.py`).

Stages: `sourced → qualified → approached → in_conversation → readiness_proposed → readiness_signed → mandate_signed → investor_process → term_sheet → closed | dead`

`db/intermediaries.json`: `{ "name", "firm", "type" (law|audit|consulting|ex-regulator|turnaround|family-office-adviser), "region", "country", "why" , "url", "relationship" (none|contacted|warm|active), "last_contact", "referrals": [] }`

`db/investor-candidates.json` (desk-built prospect graph): `{ "name", "type" (financials-specialist PE | special situations | strategic insurer/bank | family office | reinsurer strategic arm | DFI | local institutional), "hq", "geographies": [], "sectors": [], "ticket_usd", "evidence_deals": [{"date","target","country","role","url"}], "minority_tolerance", "approval_experience", "fit" (1–5), "fit_reason", "contact_path" (public URL only), "sources": [], "status" (candidate|qualified|declined|promoted), "qualification": {answers to the five questions}, "added" }`

`db/investors.json`: `{ "name", "type" (family office|HNWI|group), "geography", "sectors", "ticket_usd", "thesis", "status" }` — Amogh fills; the desk never exposes this file's contents to targets.
