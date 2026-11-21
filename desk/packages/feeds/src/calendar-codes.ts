/**
 * Calendar title -> canonical EventCode. Only the headline series of each release gets the code;
 * sub-indices, index levels and auction detail rows map to OTHER so an engine asking for "CPI"
 * never receives "CPI-W" or "ISM Manufacturing Prices".
 * Tested against every distinct title in the recorded TradingView calendar.
 */
import type { EventCode } from '@desk/contracts';

type Rule = [RegExp, EventCode];

/** Order matters: first match wins. Titles are TradingView's, with ForexFactory variants alongside. */
const RULES: Rule[] = [
  // Fed
  [/^(fed )?interest rate( decision)?$|^federal funds rate$|^fomc (rate decision|statement)$/, 'FOMC'],
  [/^fomc (meeting )?minutes$/, 'FOMC_MINUTES'],
  [/^(fed|fomc) press conference$|\bfed chair\b|\bfed chairman\b/, 'FED_CHAIR'],
  [/^fed .*\b(speech|speaks|testimony|testifies)\b|^fomc member .*\bspeaks\b/, 'FED_SPEAKER'],
  // CPI
  [/^core inflation rate (mom|yoy)$|^core cpi (m\/m|y\/y|mom|yoy)$/, 'CORE_CPI'],
  [/^inflation rate (mom|yoy)$|^cpi (m\/m|y\/y|mom|yoy)$/, 'CPI'],
  // PPI
  [/^core ppi (mom|yoy|m\/m|y\/y)$/, 'CORE_PPI'],
  [/^ppi (mom|yoy|m\/m|y\/y)$/, 'PPI'],
  // Jobs
  [/^non[- ]?farm payrolls$|^non-farm employment change$/, 'NFP'],
  [/^unemployment rate$/, 'UNEMPLOYMENT'],
  [/^jolts job openings$/, 'JOLTS'],
  [/^initial jobless claims$|^unemployment claims$/, 'CLAIMS'],
  // PCE
  [/^core pce price index (mom|yoy|m\/m|y\/y)$/, 'CORE_PCE'],
  [/^pce price index (mom|yoy|m\/m|y\/y)$/, 'PCE'],
  // Activity
  [/^ism manufacturing pmi$/, 'ISM_MFG'],
  [/^ism (services|non-manufacturing) pmi$/, 'ISM_SVC'],
  [/^retail sales (mom|m\/m)$/, 'RETAIL_SALES'],
  [/^gdp growth rate qoq (adv|2nd est|final)$|^(advance|prelim|final) gdp q\/q$/, 'GDP'],
  [/^(ny empire state manufacturing index|empire state manufacturing index|philadelphia fed manufacturing index|philly fed manufacturing index|richmond fed composite index|richmond manufacturing index|kansas fed composite index|kansas fed manufacturing index|dallas fed manufacturing index)$/, 'REGIONAL_FED'],
  // Coupon auctions only: the yield row, not bid-to-cover / allotted / accepted, and not bills, TIPS or FRNs.
  [/^(2|3|5|7|10|20|30)-(year|y) (note|bond) auction$/, 'TREASURY_AUCTION'],
];

const norm = (title: string): string => title.toLowerCase().replace(/\s+/g, ' ').trim();

export function titleToEventCode(title: string): EventCode {
  const t = norm(title);
  for (const [re, code] of RULES) if (re.test(t)) return code;
  return 'OTHER';
}

/** Tier-1 codes per spec section 5 (earnings and ad-hoc are tiered by the catalyst engine). */
export const TIER1_CODES: readonly EventCode[] = ['CPI', 'CORE_CPI', 'PPI', 'CORE_PPI', 'NFP', 'FOMC', 'FOMC_MINUTES', 'FED_CHAIR'];
