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

Stages: `sourced → qualified → approached → in_conversation → readiness_proposed → readiness_signed → mandate_signed → investor_process → term_sheet → closed | dead`

`db/intermediaries.json`: `{ "name", "firm", "type" (law|audit|consulting|ex-regulator|turnaround|family-office-adviser), "region", "country", "why" , "url", "relationship" (none|contacted|warm|active), "last_contact", "referrals": [] }`

`db/investors.json`: `{ "name", "type" (family office|HNWI|group), "geography", "sectors", "ticket_usd", "thesis", "status" }` — Amogh fills; the desk never exposes this file's contents to targets.
