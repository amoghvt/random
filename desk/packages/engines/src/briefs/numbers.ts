/** Number extraction and tolerant matching, used to check that an answer cites only numbers on the fact sheet. */

export interface NumToken { raw: string; value: number; dp: number; pct: boolean }

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
/** As-of stamps, clock times and dates are stamps, not data; they are removed before numbers are read. */
const STRIP: RegExp[] = [
  /\((?:[^()]*\bas of\b[^()]*|[^()]*\bold\b[^()]*)\)/gi,
  new RegExp(`\\bas of (?:${MONTH} \\d{1,2},? )?\\d{1,2}:\\d{2}(?: ?[A-Z]{2,4})?`, 'gi'),
  /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  new RegExp(`\\b${MONTH} \\d{1,2}(?:st|nd|rd|th)?\\b`, 'g'),
];
/** A number not glued to a word: "10Y", "N225", "Tier-1", "15m", "2s10s" are names, not values. */
const NUM = /(?<![\w.]|[A-Za-z]-)[-+−–±]?\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(%|bps?|pts?|x)(?![A-Za-z]))?(?![\w]|\.\d|,\d{3})/g;

export function stripStamps(text: string): string {
  return STRIP.reduce((s, re) => s.replace(re, ' '), text);
}

export function extractNumbers(text: string): NumToken[] {
  const out: NumToken[] = [];
  for (const m of stripStamps(text).matchAll(NUM)) {
    const frac = m[2] ?? '';
    out.push({ raw: m[0].trim(), value: Number(`${m[1]!.replace(/,/g, '')}${frac}`), dp: Math.max(0, frac.length - 1), pct: m[3] === '%' });
  }
  return out;
}

const roundTo = (x: number, dp: number): number => { const k = 10 ** dp; return Math.round(x * k) / k; };

/** True when `n` is some sheet number at the answer's precision; sign and the 0.62 / 62% forms are tolerated. */
export function numberOnSheet(n: NumToken, sheet: NumToken[]): boolean {
  const eps = 10 ** -n.dp / 1000 + 1e-9;
  const near = (x: number): boolean => Math.abs(roundTo(Math.abs(x), n.dp) - n.value) < eps;
  return sheet.some((f) => (f.dp >= n.dp && near(f.value)) || (f.dp < n.dp && Math.abs(f.value - n.value) < eps)
    || (n.pct && !f.pct && near(f.value * 100)) || (!n.pct && f.pct && near(f.value / 100)));
}

/** Numbers in `text` that are not on the sheet, as written. */
export function numbersNotOnSheet(text: string, sheetText: string): string[] {
  const sheet = extractNumbers(sheetText);
  return [...new Set(extractNumbers(text).filter((n) => !numberOnSheet(n, sheet)).map((n) => n.raw))];
}
